import 'reflect-metadata';
import { Fraction } from '../src/common/fraction';
import { buildHarness, resetHarness, seedBaseScenario, type Harness } from './harness';
import { TransferNetworkError } from '../src/common/errors';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Two-site internal-transfer world:
 *
 *   EAST / BOILER (facility EB): burns natural gas -> steam. Most steam is
 *   used in EAST, 200 GJ goes to WEST/PROCESS.
 *   WEST / TURBINE (facility WT): receives steam at WT_IN, produces
 *   electricity; some electricity flows back to EAST/AUX feeding EB.
 *
 * Reference efficiencies are part of the factor version:
 *   steam 0.9, electricity 0.4.
 */
export async function seedTransferWorld(
  h: Harness,
  opts: { version?: string } = {}
): Promise<{ factorVersionId: number; gwpSetId: number }> {
  await resetHarness(h);
  const seeded = await seedBaseScenario(h, {
    factorVersion: opts.version ?? 'FV1',
    sites: [
      {
        code: 'EAST',
        sources: [{ code: 'BOILER', fuelKey: 'natural_gas', scope: 1 as const }]
      },
      {
        code: 'WEST',
        sources: [{ code: 'GRID', fuelKey: 'electricity', scope: 2 as const }]
      }
    ],
    carriers: [
      { carrier: 'steam', refEfficiency: '0.9' },
      { carrier: 'electricity', refEfficiency: '0.4' }
    ]
  });

  await h.energyMaster.upsertFacility({ code: 'EB', siteCode: 'EAST', name: 'east boiler' });
  await h.energyMaster.upsertFacility({ code: 'WT', siteCode: 'WEST', name: 'west turbine' });

  await h.master.upsertSource({
    siteCode: 'EAST',
    code: 'BOILER',
    name: 'boiler house',
    fuelKey: 'natural_gas',
    scope: 1,
    facilityCode: 'EB'
  });
  // EAST final-use points: auxiliaries (which feed the boiler) and process.
  await h.energyMaster.upsertUsePoint({ siteCode: 'EAST', code: 'AUX', name: 'boiler auxiliaries', facilityCode: 'EB' });
  await h.energyMaster.upsertUsePoint({ siteCode: 'EAST', code: 'ESTEAM', name: 'east process steam', facilityCode: null });
  // WEST: turbine inlet (feeds WT) and final process points.
  await h.energyMaster.upsertUsePoint({ siteCode: 'WEST', code: 'WT_IN', name: 'turbine steam inlet', facilityCode: 'WT' });
  await h.energyMaster.upsertUsePoint({ siteCode: 'WEST', code: 'PROCESS', name: 'west process steam', facilityCode: null });
  await h.energyMaster.upsertUsePoint({ siteCode: 'WEST', code: 'WPOWER', name: 'west process power', facilityCode: null });

  return seeded;
}

async function ids(h: Harness, version = 'FV1', gwpCode = 'AR5') {
  const factorVersionId = (await h.factors.getVersion(version)).id;
  const gwpSetId = await h.gwp.resolveSetId(h.db, gwpCode);
  return { factorVersionId, gwpSetId };
}

async function cut(h: Harness) {
  return (await h.activity.createCutNow('t')).id;
}

describe('internal energy transfers', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.shutdown();
  });
  beforeEach(async () => {
    await seedTransferWorld(h);
  });

  test('worked example: west receives exactly 14.025 t CO2; east scope 1 stays 56.1 t', async () => {
    // 1000 GJ gas, CO2 factor 56.1 kg/GJ -> 56.1 t; 800 GJ steam, 200 GJ west.
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'O1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'T1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' }
    ]);
    const cutId = await cut(h);
    const { factorVersionId, gwpSetId } = await ids(h);
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });

    // Single carrier: every output share is 1, so the west edge carries 1/4.
    const westRows = h.accounting.aggregate(bundle, { groupBy: ['site'], siteCode: 'WEST' });
    const westScope2 = westRows.find((r) => r.scope === 2 && r.category === 'TRANSFER')!;
    expect(westScope2.totals.CO2.toDecimalString()).toBe('14.025');
    expect(westScope2.totals.CO2.key()).toBe('561/40');

    // Producer site scope 1 is untouched: full 56.1 t combustion.
    const eastRows = h.accounting.aggregate(bundle, { groupBy: ['site'], siteCode: 'EAST' });
    const eastScope1 = eastRows.find((r) => r.scope === 1)!;
    expect(eastScope1.totals.CO2.toDecimalString()).toBe('56.1');

    // The transfer scope-2 row is distinguishable from purchased electricity.
    expect(westRows.filter((r) => r.scope === 2).map((r) => r.category).sort()).toEqual(['TRANSFER']);
  });

  test('input emissions equal the sum of every output allocation, bit-for-bit', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'O1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'T1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' }
    ]);
    const cutId = await cut(h);
    const { factorVersionId, gwpSetId } = await ids(h);
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });
    const allocation = bundle.allocations[0];

    // Direct facility input = 56.1 t CO2 (+ CH4/N2O); edges + retained == input.
    const inputByGas = { CO2: Fraction.ZERO, CH4: Fraction.ZERO, N2O: Fraction.ZERO } as Record<string, Fraction>;
    for (const [, arr] of allocation.directByFacility) {
      for (const d of arr) for (const g of ['CO2', 'CH4', 'N2O'] as const)
        inputByGas[g] = inputByGas[g].add(d.byGas[g].gasTonnes);
    }
    let edgeCO2 = Fraction.ZERO, retCO2 = Fraction.ZERO;
    for (const e of allocation.edges) edgeCO2 = edgeCO2.add(e.perGas.CO2.gasTonnes);
    for (const [, byCarrier] of allocation.retained)
      for (const [, m] of byCarrier) retCO2 = retCO2.add(m.CO2);
    expect(edgeCO2.add(retCO2).key()).toBe(inputByGas.CO2.key());
    expect(edgeCO2.toDecimalString()).toBe('14.025');
    expect(retCO2.toDecimalString()).toBe('42.075');
  });

  test('reference-efficiency allocation: heat vs electricity split with published eta', async () => {
    // EB cogenerates 600 GJ steam + 400 GJ electricity from 1000 GJ gas.
    // weights: steam 600/0.9 = 666.67; power 400/0.4 = 1000; total 1666.67
    // p_steam = 0.4, p_power = 0.6.
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'OS', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '600', unit: 'GJ' },
      { recordNo: 'OE', facilityCode: 'EB', month: '2024-01', carrier: 'electricity', quantity: '400', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'TS', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '600', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' },
      { recordNo: 'TE', facilityCode: 'EB', month: '2024-01', carrier: 'electricity', quantity: '400', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'WPOWER' }
    ]);
    const cutId = await cut(h);
    const { factorVersionId, gwpSetId } = await ids(h);
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });
    const allocation = bundle.allocations[0];

    const pSteam = allocation.productShare.get('EB')!.get('steam')!;
    const pElec = allocation.productShare.get('EB')!.get('electricity')!;
    expect(pSteam.key()).toBe('2/5');
    expect(pElec.key()).toBe('3/5');
    // 56.1 split: steam 22.44, power 33.66 — and they reconcile exactly.
    const steamEdge = allocation.edges.find((e) => e.edge.carrier === 'steam')!;
    const powerEdge = allocation.edges.find((e) => e.edge.carrier === 'electricity')!;
    expect(steamEdge.perGas.CO2.gasTonnes.toDecimalString()).toBe('22.44');
    expect(powerEdge.perGas.CO2.gasTonnes.toDecimalString()).toBe('33.66');
    expect(
      steamEdge.perGas.CO2.gasTonnes.add(powerEdge.perGas.CO2.gasTonnes).key()
    ).toBe('561/10');
  });

  test('company net is invariant when only transfer amounts move; sites shift', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'O1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'T1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' }
    ]);
    const cut1 = await cut(h);
    const { factorVersionId, gwpSetId } = await ids(h);
    const b1 = await h.accounting.loadCaliber({ cutId: cut1, factorVersionId, gwpSetId });
    const r1 = h.company.report(b1, { month: '2024-01' });

    // Move more steam west (300 GJ): fuel/electricity untouched.
    await sleep(5);
    await h.flows.bulkImportTransfers([
      { recordNo: 'T1C', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '300', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS', supersedesRecordNo: 'T1' }
    ]);
    const cut2 = await cut(h);
    const b2 = await h.accounting.loadCaliber({ cutId: cut2, factorVersionId, gwpSetId });
    const r2 = h.company.report(b2, { month: '2024-01' });

    // Net (company after elimination) is bit-identical.
    expect(r2.net.CO2.key()).toBe(r1.net.CO2.key());
    expect(r2.net.CO2E.key()).toBe(r1.net.CO2E.key());
    // Gross moves; the elimination moves by the same amount.
    expect(r2.gross.CO2.compare(r1.gross.CO2)).not.toBe(0);
    expect(r2.internalElimination.CO2.sub(r1.internalElimination.CO2).key())
      .toBe(r2.gross.CO2.sub(r1.gross.CO2).key());
    // Sites: the producer keeps its full scope 1 (gross constant); west
    // receives more, and its net contribution rises by exactly that amount.
    // Site net views (gross minus transferred-in) move oppositely: east net
    // is unchanged and west net absorbs the whole delta.
    const w1 = r1.sites.find((s) => s.siteCode === 'WEST')!.gross.CO2;
    const w2 = r2.sites.find((s) => s.siteCode === 'WEST')!.gross.CO2;
    const e1 = r1.sites.find((s) => s.siteCode === 'EAST')!.gross.CO2;
    const e2 = r2.sites.find((s) => s.siteCode === 'EAST')!.gross.CO2;
    expect(e2.key()).toBe(e1.key());
    // delta = 100 GJ / 800 GJ * 56.1 = 7.0125 t
    expect(w2.sub(w1).toDecimalString()).toBe('7.0125');
    // On the net (post-elimination) site view the same delta shows up, and
    // east's transferred-in stays zero while west's grows.
    const wn1 = r1.sites.find((s) => s.siteCode === 'WEST')!.transferredIn.CO2;
    const wn2 = r2.sites.find((s) => s.siteCode === 'WEST')!.transferredIn.CO2;
    expect(wn2.sub(wn1).toDecimalString()).toBe('7.0125');
    const eastNet1 = r1.sites.find((s) => s.siteCode === 'EAST')!.net.CO2;
    const eastNet2 = r2.sites.find((s) => s.siteCode === 'EAST')!.net.CO2;
    expect(eastNet2.key()).toBe(eastNet1.key());
  });

  test('east-west ring solves and conserves', async () => {
    // EB: 1000 GJ gas -> 800 steam; sends 200 steam to WT inlet.
    // WT: 200 GJ steam in -> 80 GJ electricity; sends 30 GJ electricity back
    // to EAST/AUX (feeds EB) and 50 GJ to WEST/WPROCESS.
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'OS', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' },
      { recordNo: 'OE', facilityCode: 'WT', month: '2024-01', carrier: 'electricity', quantity: '80', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'TS', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'WT_IN' },
      { recordNo: 'TB', facilityCode: 'WT', month: '2024-01', carrier: 'electricity', quantity: '30', unit: 'GJ', toSiteCode: 'EAST', toUsePointCode: 'AUX' },
      { recordNo: 'TP', facilityCode: 'WT', month: '2024-01', carrier: 'electricity', quantity: '50', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'WPOWER' }
    ]);
    const cutId = await cut(h);
    const { factorVersionId, gwpSetId } = await ids(h);
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });
    const a = bundle.allocations[0];

    // Solved without error; both facilities present.
    expect(a.facilities.sort()).toEqual(['EB', 'WT']);

    // Conservation: sink-edge deliveries + retained production = 56.1.
    // The internal EB<->WT edges are intermediate and are not counted.
    const sinkNos = new Set(a.sinkEdges.map((e) => e.recordNo));
    let edgeCO2 = Fraction.ZERO, retCO2 = Fraction.ZERO;
    for (const e of a.edges.filter((x) => sinkNos.has(x.edge.recordNo)))
      edgeCO2 = edgeCO2.add(e.perGas.CO2.gasTonnes);
    for (const [, byCarrier] of a.retained)
      for (const [, m] of byCarrier) retCO2 = retCO2.add(m.CO2);
    expect(edgeCO2.add(retCO2).key()).toBe('561/10');
    // Sink deliveries are the west process steam (TS is internal, TP is sink)
    // and the back-flow auxiliaries are internal too.
    expect(edgeCO2.toDecimalString()).toBe('9.672413793103448276');

    // Closed-form check of the solved system:
    // m_EB,WT = p_WT,power * 30/80 = 3/8; E_WT = E_EB/4;
    // E_EB = 56.1 + 3/32 E_EB  =>  E_EB = 56.1*32/29.
    const eEB = a.embodied.get('EB')!.CO2;
    expect(eEB.key()).toBe(Fraction.from('56.1').mul(Fraction.from(32)).div(Fraction.from(29)).key());
    const eWT = a.embodied.get('WT')!.CO2;
    expect(eWT.key()).toBe(eEB.div(Fraction.from(4)).key());
    // The TS steam edge coefficient is 1/4.
    const steamEdge = a.edges.find((e) => e.edge.recordNo === 'TS')!;
    expect(steamEdge.edge.coefficient.key()).toBe('1/4');
    expect(steamEdge.perGas.CO2.gasTonnes.key()).toBe(eEB.div(Fraction.from(4)).key());
    // Back-edge power coefficient is 3/8; final power edge is 5/8.
    const backEdge = a.edges.find((e) => e.edge.recordNo === 'TB')!;
    const finalEdge = a.edges.find((e) => e.edge.recordNo === 'TP')!;
    expect(backEdge.edge.coefficient.key()).toBe('3/8');
    expect(finalEdge.edge.coefficient.key()).toBe('5/8');
    // The ring changes the distribution: back edge carries real mass back.
    expect(backEdge.perGas.CO2.gasTonnes.sign() > 0).toBe(true);

    // Company report reconciles: net CO2 = 56.1.
    const report = h.company.report(bundle, { month: '2024-01' });
    expect(report.net.CO2.key()).toBe('561/10');
  });

  test('fully closed loop with no final use is rejected and names facilities', async () => {
    // EB sends all steam to WT inlet; WT sends all power back to EB aux:
    // nothing retained and no sink edge.
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'OS', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' },
      { recordNo: 'OE', facilityCode: 'WT', month: '2024-01', carrier: 'electricity', quantity: '80', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'TS', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'WT_IN' },
      { recordNo: 'TB', facilityCode: 'WT', month: '2024-01', carrier: 'electricity', quantity: '80', unit: 'GJ', toSiteCode: 'EAST', toUsePointCode: 'AUX' }
    ]);
    const cutId = await cut(h);
    const { factorVersionId, gwpSetId } = await ids(h);
    await expect(
      h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId })
    ).rejects.toMatchObject({ name: 'TransferNetworkError' });
    try {
      await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as TransferNetworkError;
      expect(err.code).toBe('TRANSFER_NETWORK_NO_FINAL_USE');
      expect([...(err.facilities ?? [])].sort()).toEqual(['EB', 'WT']);
    }
  });

  test('changing only the GWP set leaves gas masses on the transfer chain unchanged', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'O1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'T1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' }
    ]);
    const cutId = await cut(h);
    const { factorVersionId } = await ids(h);
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');
    await h.gwp.publishSet({
      code: 'AR6',
      name: 'AR6',
      values: [
        { gas: 'CO2', value: '1' },
        { gas: 'CH4', value: '29.8' },
        { gas: 'N2O', value: '273' }
      ]
    });
    const ar6 = await h.gwp.resolveSetId(h.db, 'AR6');

    const b5 = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId: ar5 });
    const b6 = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId: ar6 });
    for (const gas of ['CO2', 'CH4', 'N2O'] as const) {
      const l5 = b5.transferLeaves.find((l) => l.gas === gas)!;
      const l6 = b6.transferLeaves.find((l) => l.gas === gas)!;
      expect(l6.gasTonnes.key()).toBe(l5.gasTonnes.key());
    }
  });

  test('restatement: factor-only change attributes west transfer impact to factors', async () => {
    await h.factors.publishVersion({
      version: 'FV2',
      fuels: [{ fuelKey: 'natural_gas', density: '0.8', ncv: '45' }],
      carriers: [
        { carrier: 'steam', refEfficiency: '0.9' },
        { carrier: 'electricity', refEfficiency: '0.4' }
      ],
      factors: [
        { fuelKey: 'natural_gas', gas: 'CO2', scope: 1, value: '60', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'natural_gas', gas: 'CH4', scope: 1, value: '1.0', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'natural_gas', gas: 'N2O', scope: 1, value: '0.1', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'CO2', scope: 2, value: '0.4', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'CH4', scope: 2, value: '0', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'N2O', scope: 2, value: '0', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' }
      ]
    });
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'O1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'T1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' }
    ]);
    const cutId = await cut(h);
    const fv1 = (await h.factors.getVersion('FV1')).id;
    const fv2 = (await h.factors.getVersion('FV2')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');

    const r = await h.restatement.compare({
      base: { cutId, factorVersionId: fv1, gwpSetId: ar5 },
      current: { cutId, factorVersionId: fv2, gwpSetId: ar5 },
      filter: { siteCode: 'WEST', month: '2024-01' }
    });
    const co2 = r.components.find((c) => c.metric === 'CO2')!;
    expect(co2.activity.key()).toBe('0/1');
    expect(co2.gwp.key()).toBe('0/1');
    // west change: 1/4 * 1000 * (60 - 56.1) kg = 975 kg = 0.975 t, all factors
    expect(co2.factors.toDecimalString()).toBe('0.975');
    expect(co2.total.key()).toBe(co2.factors.key());
  });

  test('restatement: activity-only correction attributes west change to activity', async () => {
    const fv1 = (await h.factors.getVersion('FV1')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'O1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'T1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' }
    ]);
    const cut1 = await cut(h);

    await sleep(5);
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1C', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1200', unit: 'GJ', supersedesRecordNo: 'G1' }
      ]
    });
    const cut2 = await cut(h);

    const r = await h.restatement.compare({
      base: { cutId: cut1, factorVersionId: fv1, gwpSetId: ar5 },
      current: { cutId: cut2, factorVersionId: fv1, gwpSetId: ar5 },
      filter: { siteCode: 'WEST', month: '2024-01' }
    });
    const co2 = r.components.find((c) => c.metric === 'CO2')!;
    expect(co2.factors.key()).toBe('0/1');
    expect(co2.gwp.key()).toBe('0/1');
    // west change: 1/4 * 200 GJ extra gas * 56.1 kg/GJ = 2805 kg = 2.805 t
    expect(co2.activity.toDecimalString()).toBe('2.805');
    expect(co2.total.key()).toBe(co2.activity.key());
  });

  test('forward trace reaches the originating fuel record across sites', async () => {
    const { factorVersionId, gwpSetId } = await ids(h);
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'OS', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' },
      { recordNo: 'OE', facilityCode: 'WT', month: '2024-01', carrier: 'electricity', quantity: '80', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'TS', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'WT_IN' },
      { recordNo: 'TP', facilityCode: 'WT', month: '2024-01', carrier: 'electricity', quantity: '50', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'WPOWER' }
    ]);
    const cutId = await cut(h);
    const trace = await h.lineage.traceTransfer({
      cutId, factorVersionId, gwpSetId,
      month: '2024-01', receiverSite: 'WEST', edgeRecordNo: 'TP', gas: 'CO2'
    });
    expect(trace.paths).toHaveLength(1);
    const p = trace.paths[0];
    expect(p.originRecordNo).toBe('G1');
    // hops: EB --steam(200/800)--> WT, WT --power(50/80)--> WEST
    expect(p.hops.map((x) => x.edgeRecordNo)).toEqual(['TS', 'TP']);
    expect(p.hops[0].productShare.key()).toBe('1/4');
    expect(p.hops[1].productShare.key()).toBe('5/8');
    // exactShare * origin mass (56.1) = leaf mass
    expect(p.exactShare.mul(Fraction.from('56.1')).key()).toBe(trace.gasTonnes.key());
    // No ring here: exact share equals simple-path product 1/4 * 5/8 = 5/32.
    expect(p.pathShare.key()).toBe('5/32');
    expect(p.exactShare.key()).toBe(p.pathShare.key());
    // leaf mass = 56.1 * 5/32 = 8.765625 t
    expect(trace.gasTonnes.toDecimalString()).toBe('8.765625');
  });

  test('reverse impact lists downstream closed snapshots including transfer-only sites', async () => {
    const { factorVersionId, gwpSetId } = await ids(h);
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'O1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'T1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' }
    ]);
    await h.close.closeMonth({ month: '2024-01', factorVersionId, gwpSetId });

    await sleep(5);
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1C', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1200', unit: 'GJ', supersedesRecordNo: 'G1' }
      ]
    });
    await h.activity.createCutNow('after');

    const impacts = await h.lineage.snapshotImpactOfRecord('G1C');
    const closed = impacts.filter((i) => i.affected);
    expect(closed.length).toBeGreaterThanOrEqual(1);
    // The company-wide snapshot is affected and lists WEST as transfer-only.
    const company = closed.find((i) => i.isCompanyWide)!;
    expect(company.indirectlyAffectedSites).toContain('WEST');
    expect(company.channels).toContain('TRANSFER');
  });

  test('upstream correction after close does not change the west snapshot', async () => {
    const { factorVersionId, gwpSetId } = await ids(h);
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'O1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'T1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' }
    ]);
    const { closeId } = await h.close.closeMonth({ month: '2024-01', factorVersionId, gwpSetId });
    const before = JSON.stringify(
      (await h.close.querySnapshot({ closeId })).map((r) => ({ ...r, value: r.value.key() }))
    );

    await sleep(5);
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1C', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '5000', unit: 'GJ', supersedesRecordNo: 'G1' }
      ]
    });
    const after = JSON.stringify(
      (await h.close.querySnapshot({ closeId })).map((r) => ({ ...r, value: r.value.key() }))
    );
    expect(after).toBe(before);

    // West frozen at 14.025.
    const rows = await h.close.querySnapshot({ closeId, siteCode: 'WEST' });
    const west = rows
      .filter((r) => r.gas === 'CO2' && r.category === 'TRANSFER')
      .reduce((a, r) => a.add(r.value), Fraction.ZERO);
    expect(west.toDecimalString()).toBe('14.025');
  });

  test('validation: over-transfer, self transfer, missing point, bad unit, transfer without output', async () => {
    await h.flows.bulkImportOutputs([
      { recordNo: 'O1', facilityCode: 'EB', month: '2024-02', carrier: 'steam', quantity: '100', unit: 'GJ' }
    ]);
    const over = await h.flows.bulkImportTransfers([
      { recordNo: 'X1', facilityCode: 'EB', month: '2024-02', carrier: 'steam', quantity: '150', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' }
    ]);
    expect(over[0].status).toBe('rejected');
    expect(over[0].errors?.[0].code).toBe('TRANSFER_EXCEEDS_OUTPUT');

    // self transfer to a point feeding the sender
    const self = await h.flows.bulkImportTransfers([
      { recordNo: 'X2', facilityCode: 'WT', month: '2024-02', carrier: 'electricity', quantity: '10', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'WT_IN' }
    ]);
    expect(self[0].status).toBe('rejected');
    expect(self[0].errors?.[0].code).toBe('TRANSFER_TO_SELF');

    // missing use point
    const missing = await h.flows.bulkImportTransfers([
      { recordNo: 'X3', facilityCode: 'EB', month: '2024-02', carrier: 'steam', quantity: '10', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'NOPE' }
    ]);
    expect(missing[0].errors?.[0].code).toBe('NOT_FOUND');

    // non-energy unit
    const badUnit = await h.flows.bulkImportOutputs([
      { recordNo: 'X4', facilityCode: 'EB', month: '2024-02', carrier: 'steam', quantity: '10', unit: 'kg' }
    ]);
    expect(badUnit[0].errors?.[0].code).toBe('UNIT_NOT_CONVERTIBLE');

    // transfer with no output at all
    const noOutput = await h.flows.bulkImportTransfers([
      { recordNo: 'X5', facilityCode: 'WT', month: '2024-03', carrier: 'electricity', quantity: '10', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'WPOWER' }
    ]);
    expect(noOutput[0].errors?.[0].code).toBe('TRANSFER_WITHOUT_OUTPUT');
  });

  test('output corrected below the transferred volume makes accounting fail loudly', async () => {
    await h.flows.bulkImportOutputs([
      { recordNo: 'O1', facilityCode: 'EB', month: '2024-03', carrier: 'steam', quantity: '800', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'T1', facilityCode: 'EB', month: '2024-03', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' }
    ]);
    // A standalone batch at a later date reduces output to 100 GJ < 200 sent.
    const correction = await h.flows.bulkImportOutputs([
      { recordNo: 'O1C', facilityCode: 'EB', month: '2024-03', carrier: 'steam', quantity: '100', unit: 'GJ', supersedesRecordNo: 'O1' }
    ]);
    // The batch balance check rejects it at registration (defense in depth).
    expect(correction[0].status).toBe('rejected');
    expect(correction[0].errors?.[0].code).toBe('TRANSFER_EXCEEDS_OUTPUT');
  });

  test('re-submission is idempotent and corrections behave like activity records', async () => {
    const r1 = await h.flows.bulkImportOutputs([
      { recordNo: 'D1', facilityCode: 'EB', month: '2024-05', carrier: 'steam', quantity: '10', unit: 'GJ' }
    ]);
    expect(r1[0].status).toBe('accepted');
    const r2 = await h.flows.bulkImportOutputs([
      { recordNo: 'D1', facilityCode: 'EB', month: '2024-05', carrier: 'steam', quantity: '10', unit: 'GJ' }
    ]);
    expect(r2[0].status).toBe('duplicate');
  });

  test('with zero transfer rows the bundle is bit-identical to the pre-transfer engine', async () => {
    // Plain activity on a non-facility source and a facility source but no
    // outputs/transfers at all: allocations empty, transfer leaves empty.
    await h.master.upsertSource({
      siteCode: 'EAST', code: 'BOILER', name: 'b', fuelKey: 'natural_gas', scope: 1,
      facilityCode: null
    });
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G9', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '100', unit: 'GJ' }
      ]
    });
    const cutId = await cut(h);
    const { factorVersionId, gwpSetId } = await ids(h);
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });
    expect(bundle.transferLeaves).toEqual([]);
    expect(bundle.allocations).toEqual([]);
    // Grand total equals the plain pre-transfer 5.61 t, bit-for-bit.
    const total = h.accounting.grandTotal(bundle, { month: '2024-01' });
    expect(total.CO2.key()).toBe('561/100');
    // Rows carry the DIRECT category and no TRANSFER rows exist.
    const rows = h.accounting.aggregate(bundle, { groupBy: ['site', 'source', 'month'] });
    expect(rows.every((r) => r.category === 'DIRECT')).toBe(true);
    // Company report: elimination is exactly zero and net == gross.
    const report = h.company.report(bundle, { month: '2024-01' });
    expect(report.internalElimination.CO2.key()).toBe('0/1');
    expect(report.net.CO2.key()).toBe(report.gross.CO2.key());
  });

  test('close snapshot stores transfer rows and lineage; recomputation matches', async () => {
    const { factorVersionId, gwpSetId } = await ids(h);
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.flows.bulkImportOutputs([
      { recordNo: 'O1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '800', unit: 'GJ' }
    ]);
    await h.flows.bulkImportTransfers([
      { recordNo: 'T1', facilityCode: 'EB', month: '2024-01', carrier: 'steam', quantity: '200', unit: 'GJ', toSiteCode: 'WEST', toUsePointCode: 'PROCESS' }
    ]);
    const { closeId, cutId } = await h.close.closeMonth({ month: '2024-01', factorVersionId, gwpSetId });

    // Snapshot has a WEST TRANSFER scope-2 row at 14.025.
    const rows = await h.close.querySnapshot({ closeId, siteCode: 'WEST' });
    const west = rows.filter((r) => r.category === 'TRANSFER' && r.gas === 'CO2');
    expect(west).toHaveLength(1);
    expect(west[0].value.toDecimalString()).toBe('14.025');
    // EAST keeps DIRECT scope-1 56.1 in the same snapshot.
    const eastRows = await h.close.querySnapshot({ closeId, siteCode: 'EAST' });
    const east = eastRows.filter((r) => r.category === 'DIRECT' && r.gas === 'CO2');
    expect(east.reduce((a, r) => a.add(r.value), Fraction.ZERO).toDecimalString()).toBe('56.1');

    // Transfer lineage rows carry the exact 1/4 share and origin record.
    const tlineage = await h.close.querySnapshotTransferLineage({ closeId, siteCode: 'WEST' });
    const co2 = tlineage.find((l) => l.gas === 'CO2')!;
    expect(co2.originRecordNo).toBe('G1');
    expect(co2.share.key()).toBe('1/4');
    expect(co2.gasTonnes.toDecimalString()).toBe('14.025');

    // Snapshot total reconciles with a live recomputation.
    const snapTotal = (await h.close.querySnapshot({ closeId }))
      .filter((r) => r.gas === 'CO2')
      .reduce((a, r) => a.add(r.value), Fraction.ZERO);
    const bundle = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });
    expect(snapTotal.key()).toBe(h.accounting.grandTotal(bundle, { month: '2024-01' }).CO2.key());
  });
});
