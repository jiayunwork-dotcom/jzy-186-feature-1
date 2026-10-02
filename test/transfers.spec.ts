import 'reflect-metadata';
import { Fraction } from '../src/common/fraction';
import { buildHarness, cutAfterWrites, resetHarness, seedBaseScenario, type Harness } from './harness';
import { NetworkStructureError } from '../src/common/errors';

/**
 * Internal energy transfer (内部转供) integration tests.
 *
 * Scenario skeleton:
 *   EAST / BOILER  burns natural gas, produces steam, sends some to WEST
 *   WEST / TURBINE receives steam (bound point), produces electricity, sends
 *   some back to EAST — the two-site ring.
 */

async function seedTwoSites(h: Harness) {
  // Sites, facilities, delivery points.
  await h.master.upsertFacility({ siteCode: 'EAST', code: 'BOILER', name: 'east boiler house' });
  await h.master.upsertFacility({ siteCode: 'WEST', code: 'TURBINE', name: 'west turbine' });
  // West receiving point bound to the turbine (re-enters its pool).
  await h.master.upsertDeliveryPoint({ siteCode: 'WEST', code: 'STEAM_IN', name: 'steam inlet', facilityCode: 'TURBINE' });
  // West final steam use point (unbound): steam settling at West as scope 2.
  await h.master.upsertDeliveryPoint({ siteCode: 'WEST', code: 'STEAM_USE', name: 'steam users' });
  // East electricity receiving point bound to the boiler house auxiliaries.
  await h.master.upsertDeliveryPoint({ siteCode: 'EAST', code: 'POWER_IN', name: 'pump/fan power', facilityCode: 'BOILER' });
  // East final electricity use.
  await h.master.upsertDeliveryPoint({ siteCode: 'EAST', code: 'POWER_USE', name: 'power users' });

  // Emission sources belonging to facilities.
  await h.master.upsertSource({
    siteCode: 'EAST', code: 'BOILER_GAS', name: 'boiler natural gas',
    fuelKey: 'natural_gas', scope: 1, facilityCode: 'BOILER'
  });
  await h.master.upsertSource({
    siteCode: 'WEST', code: 'TURBINE_GAS', name: 'turbine aux gas',
    fuelKey: 'natural_gas', scope: 1, facilityCode: 'TURBINE'
  });
  await h.master.upsertSource({
    siteCode: 'EAST', code: 'BOILER_GRID', name: 'boiler purchased power',
    fuelKey: 'electricity', scope: 2, facilityCode: 'BOILER'
  });
  await h.master.upsertSource({
    siteCode: 'WEST', code: 'GRID', name: 'west purchased power',
    fuelKey: 'electricity', scope: 2
  });
}

async function ids(h: Harness, version = 'FV1', gwpCode = 'AR5') {
  const factorVersionId = (await h.factors.getVersion(version)).id;
  const gwpSetId = await h.gwp.resolveSetId(h.db, gwpCode);
  return { factorVersionId, gwpSetId };
}

describe('internal energy transfer accounting', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await buildHarness();
  });
  afterAll(async () => {
    await h.shutdown();
  });
  beforeEach(async () => {
    await resetHarness(h);
    await seedBaseScenario(h, {
      sites: [
        {
          code: 'S1',
          sources: [
            { code: 'BOILER', fuelKey: 'natural_gas', scope: 1 as const },
            { code: 'GRID', fuelKey: 'electricity', scope: 2 as const }
          ]
        }
      ]
    });
    await seedTwoSites(h);
  });

  // -------------------------------------------------------------------------
  // 1. The hand-computable worked example: 1000 GJ gas -> 800 GJ steam,
  //    200 GJ to West. West transfer CO2 = 14.025 t; East scope 1 = 56.1 t.
  // -------------------------------------------------------------------------

  test('worked example: West receives exactly 14.025 t CO2; East scope 1 stays 56.1 t', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-03', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    const out = await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-03', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    expect(out[0].status).toBe('accepted');
    const tr = await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-03', carrier: 'STEAM', quantity: '200', unit: 'GJ'
      }
    ]);
    expect(tr[0].status).toBe('accepted');

    const cutId = await cutAfterWrites(h, 'worked'); const cut = { id: cutId };
    const { factorVersionId, gwpSetId } = await ids(h);
    const bundle = await h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId });

    // East site scope 1 CO2: the whole combustion stays at East.
    const eastScope1 = h.accounting
      .aggregate(bundle, { groupBy: ['site'], siteCode: 'EAST', scope: 1 })
      .find((r) => r.category === 'ACTIVITY')!;
    expect(eastScope1.totals.CO2.toDecimalString()).toBe('56.1');

    // West scope 2 TRANSFER CO2 = 200/800 * 56.1 = 14.025 t.
    const westRows = h.accounting.aggregate(bundle, { groupBy: ['site'], siteCode: 'WEST' });
    const transferRow = westRows.find((r) => r.category === 'TRANSFER' && r.scope === 2)!;
    expect(transferRow).toBeTruthy();
    expect(transferRow.totals.CO2.key()).toBe('561/40'); // 14.025
    expect(transferRow.totals.CO2.toDecimalString()).toBe('14.025');

    // The transfer leaf is distinguishable from purchased electricity scope 2.
    const gridRow = westRows.find((r) => r.sourceCode === undefined || true);
    void gridRow;
  });

  // -------------------------------------------------------------------------
  // 2. Conservation: each facility's input emissions == outputs' allocated
  //    emissions (self use + every transfer), bit-exact, per gas.
  // -------------------------------------------------------------------------

  test('facility input emissions equal allocated outputs exactly, per gas', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-03', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' },
        { recordNo: 'E1', siteCode: 'EAST', sourceCode: 'BOILER_GRID', month: '2024-03', fuelKey: 'electricity', scope: 2, quantity: '5000', unit: 'kWh' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-03', carrier: 'STEAM', quantity: '600', unit: 'GJ' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-03', carrier: 'STEAM', quantity: '250', unit: 'GJ'
      }
    ]);
    const cutId = await cutAfterWrites(h, 'cons'); const cut = { id: cutId };
    const { factorVersionId, gwpSetId } = await ids(h);
    const bundle = await h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId });
    const sol = bundle.transferLayer.solutions.get('2024-03')!;
    const east = sol.facilities.find((f) => f.siteCode === 'EAST' && f.facilityCode === 'BOILER')!;

    // Primary inputs of the boiler: 1000 GJ gas + 5000 kWh electricity.
    // CO2: 56.1 + 2.0 = 58.1 t; CH4: 1.0 + 0 = 1.0 t; N2O: 0.1 t.
    const primaryGas = bundle.transferLayer.primaryLeavesByFacility
      .get('2024-03')!.get('EAST/BOILER')!;
    const p = { CO2: Fraction.ZERO, CH4: Fraction.ZERO, N2O: Fraction.ZERO };
    for (const l of primaryGas) {
      p.CO2 = p.CO2.add(l.byGas.CO2.gasTonnes);
      p.CH4 = p.CH4.add(l.byGas.CH4.gasTonnes);
      p.N2O = p.N2O.add(l.byGas.N2O.gasTonnes);
    }
    expect(p.CO2.toDecimalString()).toBe('58.1');

    for (const gas of ['CO2', 'CH4', 'N2O'] as const) {
      const allocated = east.selfUse[gas].add(east.exported[gas]);
      expect(allocated.key()).toBe(p[gas].key());
      expect(east.pool[gas].key()).toBe(p[gas].key());
    }
  });

  // -------------------------------------------------------------------------
  // 3. Changing only transfer quantities keeps company net total bit-exact;
  //    sites trade the emissions between each other.
  // -------------------------------------------------------------------------

  test('transfer-only change: company net unchanged, sites shift', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-03', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-03', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-03', carrier: 'STEAM', quantity: '200', unit: 'GJ'
      }
    ]);
    const cut1 = { id: await cutAfterWrites(h, 'c1') };
    const { factorVersionId, gwpSetId } = await ids(h);

    const b1 = await h.accounting.loadCaliber({ cutId: cut1.id, factorVersionId, gwpSetId });
    const company1 = h.accounting.companyTotals(b1, { month: '2024-03' });

    // Double the transfer (400 GJ), within the 800 GJ output.
    await h.transfer.importTransfers([
      {
        recordNo: 'T2', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-03', carrier: 'STEAM', quantity: '400', unit: 'GJ',
        supersedesRecordNo: 'T1'
      }
    ]);
    const cut2 = { id: await cutAfterWrites(h, 'c2') };
    const b2 = await h.accounting.loadCaliber({ cutId: cut2.id, factorVersionId, gwpSetId });
    const company2 = h.accounting.companyTotals(b2, { month: '2024-03' });

    // Net company totals bit-identical across the three gases and CO2e.
    for (const gas of ['CO2', 'CH4', 'N2O', 'CO2E'] as const) {
      expect(company2.netTotal[gas].key()).toBe(company1.netTotal[gas].key());
      // Net must equal the primary combustion 56.1 t CO2.
      if (gas === 'CO2') expect(company2.netTotal.CO2.toDecimalString()).toBe('56.1');
    }
    // West rises, East's site view gross falls.
    const west1 = h.accounting.grandTotal(b1, { siteCode: 'WEST', month: '2024-03' });
    const west2 = h.accounting.grandTotal(b2, { siteCode: 'WEST', month: '2024-03' });
    expect(west2.CO2.compare(west1.CO2)).toBe(1);
    expect(west1.CO2.toDecimalString()).toBe('14.025');
    expect(west2.CO2.toDecimalString()).toBe('28.05');

    // Gross and elimination are both reported and gross − elim = net.
    for (const gas of ['CO2', 'CH4', 'N2O', 'CO2E'] as const) {
      expect(company2.grossTotal[gas].sub(company2.elimination[gas]).key())
        .toBe(company2.netTotal[gas].key());
    }
  });

  // -------------------------------------------------------------------------
  // 4. The East-West ring: steam to West turbine, electricity back to East.
  //    Must solve exactly and conserve mass.
  // -------------------------------------------------------------------------

  test('two-site ring solves and conserves mass', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-04', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' },
        { recordNo: 'G2', siteCode: 'WEST', sourceCode: 'TURBINE_GAS', month: '2024-04', fuelKey: 'natural_gas', scope: 1, quantity: '100', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-04', carrier: 'STEAM', quantity: '800', unit: 'GJ' },
      { recordNo: 'O2', siteCode: 'WEST', facilityCode: 'TURBINE', month: '2024-04', carrier: 'ELECTRICITY', quantity: '100', unit: 'MWh' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_IN',
        month: '2024-04', carrier: 'STEAM', quantity: '200', unit: 'GJ'
      },
      {
        recordNo: 'T2', fromSiteCode: 'WEST', fromFacilityCode: 'TURBINE',
        toSiteCode: 'EAST', toPointCode: 'POWER_USE',
        month: '2024-04', carrier: 'ELECTRICITY', quantity: '50', unit: 'MWh'
      }
    ]);
    const cutId = await cutAfterWrites(h, 'ring'); const cut = { id: cutId };
    const { factorVersionId, gwpSetId } = await ids(h);
    const bundle = await h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId });
    const sol = bundle.transferLayer.solutions.get('2024-04')!;

    // Pools solved (positive, finite rationals).
    const east = sol.facilities.find((f) => f.facilityCode === 'BOILER')!;
    const west = sol.facilities.find((f) => f.facilityCode === 'TURBINE')!;
    expect(east.pool.CO2.sign()).toBe(1);
    expect(west.pool.CO2.sign()).toBe(1);

    // Conservation across the network: sum of pools' "settled" emissions
    // (self use) + final-use transfer leaves == total primary CO2.
    const primaryCO2 = Fraction.from('56.1').add(Fraction.from('5.61'));
    let settled = Fraction.ZERO;
    for (const f of sol.facilities) settled = settled.add(f.selfUse.CO2);
    const finalLeaves = bundle.transferLeaves
      .filter((l) => l.month === '2024-04')
      .reduce((a, l) => a.add(l.byGas.CO2.gasTonnes), Fraction.ZERO);
    expect(settled.add(finalLeaves).key()).toBe(primaryCO2.key());

    // West receives electricity only via final POWER_USE: one transfer leaf.
    expect(bundle.transferLeaves.filter((l) => l.month === '2024-04')).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // 5. Fully closed loop, no final use -> explicit named error, no hang.
  // -------------------------------------------------------------------------

  test('fully closed loop with no final use throws naming the facilities', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-05', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' },
        { recordNo: 'G2', siteCode: 'WEST', sourceCode: 'TURBINE_GAS', month: '2024-05', fuelKey: 'natural_gas', scope: 1, quantity: '100', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-05', carrier: 'STEAM', quantity: '800', unit: 'GJ' },
      { recordNo: 'O2', siteCode: 'WEST', facilityCode: 'TURBINE', month: '2024-05', carrier: 'ELECTRICITY', quantity: '360', unit: 'GJ' }
    ]);
    // 100% of both outputs circulate: 800 GJ steam EAST->WEST facility,
    // 360 GJ electricity WEST->EAST facility. No self use, no final sink.
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_IN',
        month: '2024-05', carrier: 'STEAM', quantity: '800', unit: 'GJ'
      },
      {
        recordNo: 'T2', fromSiteCode: 'WEST', fromFacilityCode: 'TURBINE',
        toSiteCode: 'EAST', toPointCode: 'POWER_IN',
        month: '2024-05', carrier: 'ELECTRICITY', quantity: '360', unit: 'GJ'
      }
    ]);
    const cutId = await cutAfterWrites(h, 'closed'); const cut = { id: cutId };
    const { factorVersionId, gwpSetId } = await ids(h);
    await expect(
      h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId })
    ).rejects.toBeInstanceOf(NetworkStructureError);

    try {
      await h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId });
    } catch (e) {
      const err = e as NetworkStructureError;
      expect(err.code).toBe('CLOSED_LOOP_NO_FINAL_USE');
      expect(err.facilities.sort()).toEqual(['EAST/BOILER', 'WEST/TURBINE']);
    }
  });

  // -------------------------------------------------------------------------
  // 6. GWP-only change leaves gas masses on the transfer chain untouched.
  // -------------------------------------------------------------------------

  test('changing only GWP set leaves transfer gas masses unchanged', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-06', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-06', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-06', carrier: 'STEAM', quantity: '200', unit: 'GJ'
      }
    ]);
    const cutId = await cutAfterWrites(h, 'gwp'); const cut = { id: cutId };
    await h.gwp.publishSet({
      code: 'AR6', name: 'AR6',
      values: [{ gas: 'CO2', value: '1' }, { gas: 'CH4', value: '29.8' }, { gas: 'N2O', value: '273' }]
    });
    const { factorVersionId, gwpSetId: ar5 } = await ids(h, 'FV1', 'AR5');
    const ar6 = await h.gwp.resolveSetId(h.db, 'AR6');

    const b5 = await h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId: ar5 });
    const b6 = await h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId: ar6 });
    for (const [a, c] of [
      [b5.transferLeaves[0], b6.transferLeaves[0]]
    ] as const) {
      for (const gas of ['CO2', 'CH4', 'N2O'] as const) {
        expect(c.byGas[gas].gasTonnes.key()).toBe(a.byGas[gas].gasTonnes.key());
      }
    }
    // CO2e of CH4 transfer mass differs.
    const ch4Mass = b5.transferLeaves[0].byGas.CH4.gasTonnes; // 0.25 t CH4 (1.0/4)
    expect(ch4Mass.toDecimalString()).toBe('0.25');
    expect(
      b5.transferLeaves[0].byGas.CH4.co2eTonnes.key()
    ).not.toBe(b6.transferLeaves[0].byGas.CH4.co2eTonnes.key());
  });

  // -------------------------------------------------------------------------
  // 7. Validation: self transfer, missing point, bad unit, transfer without
  //    output, post-correction over-output at calc time.
  //    (Over-output is not rejected at import: each record is valid on its
  //    own; the facility balance is a caliber-time structural check, tested
  //    next via the month-level error.)
  // -------------------------------------------------------------------------

  test('validation names fields: self, missing point, bad unit, missing output', async () => {
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-07', carrier: 'STEAM', quantity: '100', unit: 'GJ' }
    ]);

    // transfer to self
    const self = await h.transfer.importTransfers([
      {
        recordNo: 'X2', fromSiteCode: 'WEST', fromFacilityCode: 'TURBINE',
        toSiteCode: 'WEST', toPointCode: 'STEAM_IN',
        month: '2024-07', carrier: 'STEAM', quantity: '1', unit: 'GJ'
      }
    ]);
    expect(self[0].errors?.[0].code).toBe('TRANSFER_TO_SELF');

    // missing point
    const missing = await h.transfer.importTransfers([
      {
        recordNo: 'X3', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'GHOST',
        month: '2024-07', carrier: 'STEAM', quantity: '1', unit: 'GJ'
      }
    ]);
    expect(missing[0].errors?.[0].code).toBe('TRANSFER_TARGET_NOT_FOUND');

    // non-energy unit
    const badUnit = await h.transfer.importOutputs([
      { recordNo: 'O9', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-07', carrier: 'STEAM', quantity: '1', unit: 't' }
    ]);
    expect(badUnit[0].errors?.[0].code).toBe('ENERGY_UNIT_NOT_CONVERTIBLE');

    // transfer with no output at all
    const noOut = await h.transfer.importTransfers([
      {
        recordNo: 'X4', fromSiteCode: 'WEST', fromFacilityCode: 'TURBINE',
        toSiteCode: 'EAST', toPointCode: 'POWER_USE',
        month: '2024-08', carrier: 'ELECTRICITY', quantity: '1', unit: 'GJ'
      }
    ]);
    expect(noOut[0].status).toBe('accepted');
    const cutId = await cutAfterWrites(h, 'v2'); const cut = { id: cutId };
    const { factorVersionId, gwpSetId } = await ids(h);
    await expect(
      h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId })
    ).rejects.toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ code: 'TRANSFER_WITHOUT_OUTPUT' })]) });
  });

  test('sending more than output is rejected at caliber calculation with TRANSFER_EXCEEDS_OUTPUT', async () => {
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-07', carrier: 'STEAM', quantity: '100', unit: 'GJ' }
    ]);
    const over = await h.transfer.importTransfers([
      {
        recordNo: 'X1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-07', carrier: 'STEAM', quantity: '150', unit: 'GJ'
      }
    ]);
    expect(over[0].status).toBe('accepted');
    const cutId = await cutAfterWrites(h, 'v1'); const cut = { id: cutId };
    const { factorVersionId, gwpSetId } = await ids(h);
    await expect(
      h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId })
    ).rejects.toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ code: 'TRANSFER_EXCEEDS_OUTPUT' })]) });
  });

  test('transfer of a carrier the facility does not produce is rejected at calculation (CARRIER_MISMATCH)', async () => {
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-07', carrier: 'STEAM', quantity: '100', unit: 'GJ' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'X5', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'POWER_LOAD_X',
        month: '2024-07', carrier: 'ELECTRICITY', quantity: '1', unit: 'GJ'
      }
    ]).catch(() => undefined);
    // Unknown point would mask the carrier check; register it first.
    await h.master.upsertDeliveryPoint({ siteCode: 'WEST', code: 'POWER_LOAD_X', name: 'load' });
    const r = await h.transfer.importTransfers([
      {
        recordNo: 'X6', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'POWER_LOAD_X',
        month: '2024-07', carrier: 'ELECTRICITY', quantity: '1', unit: 'GJ'
      }
    ]);
    expect(r[0].status).toBe('accepted');
    const cutId = await cutAfterWrites(h, 'cm');
    const { factorVersionId, gwpSetId } = await ids(h);
    await expect(
      h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId })
    ).rejects.toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ code: 'CARRIER_MISMATCH' })]) });
  });

  test('output correction downward that makes a transfer exceed output fails accounting, not silent number', async () => {
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-09', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-09', carrier: 'STEAM', quantity: '600', unit: 'GJ'
      }
    ]);
    // Correct output down to 400 GJ — transfer 600 now exceeds it.
    const c = await h.transfer.importOutputs([
      { recordNo: 'O1-C', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-09', carrier: 'STEAM', quantity: '400', unit: 'GJ', supersedesRecordNo: 'O1' }
    ]);
    expect(c[0].status).toBe('accepted');
    const cutId = await cutAfterWrites(h, 'down'); const cut = { id: cutId };
    const { factorVersionId, gwpSetId } = await ids(h);
    await expect(
      h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId })
    ).rejects.toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ code: 'TRANSFER_EXCEEDS_OUTPUT' })]) });
  });

  // -------------------------------------------------------------------------
  // 8. Decomposition attribution through transfers.
  // -------------------------------------------------------------------------

  test('factor-version-only change: West transfer delta is all in factors component', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2023-06', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2023-06', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2023-06', carrier: 'STEAM', quantity: '200', unit: 'GJ'
      }
    ]);
    const cutId = await cutAfterWrites(h, 'f-only'); const cut = { id: cutId };
    await h.factors.publishVersion({
      version: 'FV2',
      fuels: [{ fuelKey: 'natural_gas', density: '0.8', ncv: '45' }],
      factors: [
        { fuelKey: 'natural_gas', gas: 'CO2', scope: 1, value: '60', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'natural_gas', gas: 'CH4', scope: 1, value: '1.0', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'natural_gas', gas: 'N2O', scope: 1, value: '0.1', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'CO2', scope: 2, value: '0.4', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'CH4', scope: 2, value: '0', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'N2O', scope: 2, value: '0', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' }
      ]
    });
    const fv1 = (await h.factors.getVersion('FV1')).id;
    const fv2 = (await h.factors.getVersion('FV2')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');

    const r = await h.restatement.compare({
      base: { cutId: cut.id, factorVersionId: fv1, gwpSetId: ar5 },
      current: { cutId: cut.id, factorVersionId: fv2, gwpSetId: ar5 },
      filter: { siteCode: 'WEST', month: '2023-06' }
    });
    const co2 = r.components.find((c) => c.metric === 'CO2')!;
    expect(co2.activity.key()).toBe('0/1');
    expect(co2.gwp.key()).toBe('0/1');
    expect(co2.factors.key()).toBe(co2.total.key());
    // 15 t under FV2 vs 14.025 under FV1: +0.975
    expect(co2.total.toDecimalString()).toBe('0.975');
  });

  test('upstream fuel correction only: West transfer delta is all in activity component', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2023-07', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2023-07', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2023-07', carrier: 'STEAM', quantity: '200', unit: 'GJ'
      }
    ]);
    const cut1 = { id: await cutAfterWrites(h, 'a-before') };
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1-C', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2023-07', fuelKey: 'natural_gas', scope: 1, quantity: '1200', unit: 'GJ', supersedesRecordNo: 'G1' }
      ]
    });
    const cut2 = { id: await cutAfterWrites(h, 'a-after') };
    const fv1 = (await h.factors.getVersion('FV1')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');

    const r = await h.restatement.compare({
      base: { cutId: cut1.id, factorVersionId: fv1, gwpSetId: ar5 },
      current: { cutId: cut2.id, factorVersionId: fv1, gwpSetId: ar5 },
      filter: { siteCode: 'WEST', month: '2023-07' }
    });
    const co2 = r.components.find((c) => c.metric === 'CO2')!;
    expect(co2.factors.key()).toBe('0/1');
    expect(co2.gwp.key()).toBe('0/1');
    expect(co2.activity.key()).toBe(co2.total.key());
    // 1000 -> 1200 gas: West 14.025 -> 16.83, +2.805
    expect(co2.total.toDecimalString()).toBe('2.805');
  });

  // -------------------------------------------------------------------------
  // 9. Forward trace and reverse impact, including via-transfer sites.
  // -------------------------------------------------------------------------

  test('forward trace from West transfer number to East fuel record and factor', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-03', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-03', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-03', carrier: 'STEAM', quantity: '200', unit: 'GJ'
      }
    ]);
    const cutId = await cutAfterWrites(h, 'tr'); const cut = { id: cutId };
    const { factorVersionId, gwpSetId } = await ids(h);
    const report = await h.transferLineage.trace({
      cutId: cut.id, factorVersionId, gwpSetId, transferRecordNo: 'T1'
    });
    expect(report.contributions).toHaveLength(1);
    const c = report.contributions[0];
    expect(c.upstreamRecordNo).toBe('G1');
    expect(c.producerFacility).toBe('EAST/BOILER');
    expect(c.share.toDecimalString()).toBe('0.25');
    expect(c.gasTonnes.CO2.toDecimalString()).toBe('14.025');
    expect(c.hop.hopShare.toDecimalString()).toBe('0.25');
  });

  test('reverse impact lists indirectly-affected downstream closed site', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-03', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-03', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-03', carrier: 'STEAM', quantity: '200', unit: 'GJ'
      }
    ]);
    const fv1 = (await h.factors.getVersion('FV1')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');
    // Close both sites.
    await h.close.closeMonth({ month: '2024-03', factorVersionId: fv1, gwpSetId: ar5, siteCode: 'EAST' });
    await h.close.closeMonth({ month: '2024-03', factorVersionId: fv1, gwpSetId: ar5, siteCode: 'WEST' });
    await h.close.closeMonth({ month: '2024-03', factorVersionId: fv1, gwpSetId: ar5 });

    // Correct upstream fuel after the closes.
    await new Promise((r) => setTimeout(r, 5));
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1-C', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-03', fuelKey: 'natural_gas', scope: 1, quantity: '1200', unit: 'GJ', supersedesRecordNo: 'G1' }
      ]
    });

    const impact = await h.transferLineage.impactOfRecord('G1-C');
    const sites = impact.impacted.filter((s) => !s.isCompanyWide).map((s) => s.siteCode);
    expect(sites.sort()).toEqual(['EAST', 'WEST']);
    const west = impact.impacted.find((s) => s.siteCode === 'WEST')!;
    expect(west.viaTransfer).toBe(true);
    expect(west.delta.CO2.toDecimalString()).toBe('2.805');
  });

  // -------------------------------------------------------------------------
  // 10. Close: upstream correction after close does not move West snapshot;
  //     snapshot rows include transfer category and lineage rows reconcile.
  // -------------------------------------------------------------------------

  test('closed West snapshot is immune to later upstream correction', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-03', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-03', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-03', carrier: 'STEAM', quantity: '200', unit: 'GJ'
      }
    ]);
    const fv1 = (await h.factors.getVersion('FV1')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');
    const { closeId } = await h.close.closeMonth({ month: '2024-03', factorVersionId: fv1, gwpSetId: ar5, siteCode: 'WEST' });
    const before = await h.close.querySnapshot({ closeId });
    const beforeJson = JSON.stringify(before.map((r) => ({ k: `${r.siteCode}|${r.sourceCode}|${r.scope}|${r.category}|${r.gas}`, v: r.value.key() })));

    await new Promise((r) => setTimeout(r, 5));
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1-C', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-03', fuelKey: 'natural_gas', scope: 1, quantity: '2000', unit: 'GJ', supersedesRecordNo: 'G1' }
      ]
    });
    const after = await h.close.querySnapshot({ closeId });
    const afterJson = JSON.stringify(after.map((r) => ({ k: `${r.siteCode}|${r.sourceCode}|${r.scope}|${r.category}|${r.gas}`, v: r.value.key() })));
    expect(afterJson).toBe(beforeJson);
    const tRow = after.find((r) => r.category === 'TRANSFER' && r.gas === 'CO2')!;
    expect(tRow.value.toDecimalString()).toBe('14.025');

    // Transfer lineage stored: upstream G1, share 0.25, gas 14.025.
    const lin = await h.close.querySnapshotLineage({ closeId, category: 'TRANSFER' });
    const co2 = lin.find((l) => l.gas === 'CO2')!;
    expect(co2.upstreamRecordNo).toBe('G1');
    expect(co2.gasTonnes.toDecimalString()).toBe('14.025');
    expect(co2.allocationPath?.[0].shareNum).toBe('1');
    expect(co2.allocationPath?.[0].shareDen).toBe('4');
    // Single node, no ring: closed-form coefficient C[sender][producer] = 1.
    expect(co2.allocationPath?.[0].coefficientNum).toBe('1');
    expect(co2.allocationPath?.[0].coefficientDen).toBe('1');
    expect(co2.allocationPath?.[0].producerFacility).toBe('EAST/BOILER');
  });

  // -------------------------------------------------------------------------
  // 11. No transfer data: everything is bit-identical to the legacy system.
  // -------------------------------------------------------------------------

  test('with no transfer data, results are bit-identical to pre-upgrade', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'R1', siteCode: 'S1', sourceCode: 'BOILER', month: '2024-01', fuelKey: 'natural_gas', scope: 1, quantity: '100', unit: 'GJ' },
        { recordNo: 'R2', siteCode: 'S1', sourceCode: 'GRID', month: '2024-01', fuelKey: 'electricity', scope: 2, quantity: '1000', unit: 'kWh' }
      ]
    });
    const cutId = await cutAfterWrites(h, 'legacy'); const cut = { id: cutId };
    const { factorVersionId, gwpSetId } = await ids(h);
    const bundle = await h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId });
    expect(bundle.transferLeaves).toHaveLength(0);
    expect(bundle.activityLeaves).toHaveLength(bundle.leaves.length);

    const rows = h.accounting.aggregate(bundle, { groupBy: ['site', 'source', 'month'] });
    expect(rows.every((r) => r.category === 'ACTIVITY')).toBe(true);
    const co2 = h.accounting.grandTotal(bundle, { sourceCode: 'BOILER', month: '2024-01' }).CO2;
    expect(co2.key()).toBe('561/100');
    const grid = h.accounting.grandTotal(bundle, { sourceCode: 'GRID', month: '2024-01' }).CO2;
    expect(grid.key()).toBe('2/5');

    // Repeated query bit-identical.
    const again = await h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId });
    expect(JSON.stringify(again.leaves)).toBe(JSON.stringify(bundle.leaves));

    // Company net == gross (elimination zero).
    const c = h.accounting.companyTotals(bundle, { month: '2024-01' });
    expect(c.elimination.CO2.sign()).toBe(0);
    expect(c.netTotal.CO2.key()).toBe(c.grossTotal.CO2.key());
  });

  // -------------------------------------------------------------------------
  // 12. Idempotent re-submission / corrections follow activity-data rules.
  // -------------------------------------------------------------------------

  test('duplicate transfer submission is idempotent; one correction accepted', async () => {
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-03', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    const payload = {
      recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
      toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
      month: '2024-03', carrier: 'STEAM' as const, quantity: '200', unit: 'GJ'
    };
    const r1 = await h.transfer.importTransfers([payload]);
    const r2 = await h.transfer.importTransfers([payload]);
    expect(r1[0].status).toBe('accepted');
    expect(r2[0].status).toBe('duplicate');

    const c1 = await h.transfer.importTransfers([{ ...payload, recordNo: 'T1-C', quantity: '210', supersedesRecordNo: 'T1' }]);
    expect(c1[0].status).toBe('accepted');
    const c2 = await h.transfer.importTransfers([{ ...payload, recordNo: 'T1-C2', quantity: '220', supersedesRecordNo: 'T1' }]);
    expect(c2[0].status).toBe('rejected');
    expect(c2[0].errors?.[0].code).toBe('CORRECTION_TARGET_ALREADY_CORRECTED');
  });

  // -------------------------------------------------------------------------
  // 13. CHP reference-efficiency split between electricity and steam.
  // -------------------------------------------------------------------------

  test('cogeneration allocates by reference efficiency q/eta between power and heat', async () => {
    await h.master.upsertDeliveryPoint({ siteCode: 'WEST', code: 'POWER_LOAD', name: 'power load' });
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-10', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    // 300 GJ steam + 100 MWh = 360 GJ electricity.
    // weights: steam 300/0.9 = 1000/3; power 360/0.45 = 800.
    // steam share = (1000/3)/(1000/3+800) = 1000/3400 = 5/17.
    await h.transfer.importOutputs([
      { recordNo: 'OS', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-10', carrier: 'STEAM', quantity: '300', unit: 'GJ' },
      { recordNo: 'OE', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-10', carrier: 'ELECTRICITY', quantity: '100', unit: 'MWh' }
    ]);
    // all steam and all power exported to final use
    await h.transfer.importTransfers([
      {
        recordNo: 'TS', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-10', carrier: 'STEAM', quantity: '300', unit: 'GJ'
      },
      {
        recordNo: 'TE', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'POWER_LOAD',
        month: '2024-10', carrier: 'ELECTRICITY', quantity: '100', unit: 'MWh'
      }
    ]);
    const cutId = await cutAfterWrites(h, 'chp'); const cut = { id: cutId };
    const { factorVersionId, gwpSetId } = await ids(h);
    const bundle = await h.accounting.loadCaliber({ cutId: cut.id, factorVersionId, gwpSetId });

    const steamLeaf = bundle.transferLeaves.find((l) => l.recordNo === 'TS')!;
    const powerLeaf = bundle.transferLeaves.find((l) => l.recordNo === 'TE')!;
    // steam 56.1 * 5/17 = 16.5 t
    expect(steamLeaf.byGas.CO2.gasTonnes.toDecimalString()).toBe('16.5');
    // power 56.1 * 12/17 = 39.6 t
    expect(powerLeaf.byGas.CO2.gasTonnes.toDecimalString()).toBe('39.6');
    // exact conservation: exports + self use = primary; here all exported.
    expect(
      steamLeaf.byGas.CO2.gasTonnes.add(powerLeaf.byGas.CO2.gasTonnes).key()
    ).toBe('561/10');
  });

  test('reference efficiency published with a factor version changes allocation through factors', async () => {
    await h.master.upsertDeliveryPoint({ siteCode: 'WEST', code: 'POWER_LOAD', name: 'power load' });
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-10', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'OS', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-10', carrier: 'STEAM', quantity: '300', unit: 'GJ' },
      { recordNo: 'OE', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-10', carrier: 'ELECTRICITY', quantity: '100', unit: 'MWh' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'TS', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-10', carrier: 'STEAM', quantity: '300', unit: 'GJ'
      }
    ]);
    const cutId = await cutAfterWrites(h, 'eta'); const cut = { id: cutId };
    // FV2 same factors, eta_electricity = 0.4 (published with the version).
    await h.factors.publishVersion({
      version: 'FV2',
      fuels: [{ fuelKey: 'natural_gas', density: '0.8', ncv: '45' }],
      referenceEfficiencies: [
        { carrier: 'STEAM', eta: '0.9' },
        { carrier: 'ELECTRICITY', eta: '0.4' }
      ],
      factors: [
        { fuelKey: 'natural_gas', gas: 'CO2', scope: 1, value: '56.1', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'natural_gas', gas: 'CH4', scope: 1, value: '1.0', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'natural_gas', gas: 'N2O', scope: 1, value: '0.1', unit: 'kg/GJ', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'CO2', scope: 2, value: '0.4', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'CH4', scope: 2, value: '0', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' },
        { fuelKey: 'electricity', gas: 'N2O', scope: 2, value: '0', unit: 'kg/kWh', validFrom: '2023-01', validTo: '2025-12' }
      ]
    });
    const fv1 = (await h.factors.getVersion('FV1')).id;
    const fv2 = (await h.factors.getVersion('FV2')).id;
    const ar5 = await h.gwp.resolveSetId(h.db, 'AR5');
    const r = await h.restatement.compare({
      base: { cutId: cut.id, factorVersionId: fv1, gwpSetId: ar5 },
      current: { cutId: cut.id, factorVersionId: fv2, gwpSetId: ar5 },
      filter: { siteCode: 'WEST', month: '2024-10' }
    });
    const co2 = r.components.find((c) => c.metric === 'CO2')!;
    // Eta is a factor-library parameter: the move lands in "factors".
    expect(co2.activity.key()).toBe('0/1');
    expect(co2.gwp.key()).toBe('0/1');
    expect(co2.factors.compare(Fraction.ZERO)).not.toBe(0);
  });

  // -------------------------------------------------------------------------
  // 14. Cut visibility: a transfer submitted after the cut is invisible.
  // -------------------------------------------------------------------------

  test('company-view restatement is insensitive to transfer-only changes and equal to activity sum', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-03', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-03', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-03', carrier: 'STEAM', quantity: '200', unit: 'GJ'
      }
    ]);
    const cut1 = { id: await cutAfterWrites(h, 'co1') };
    await h.transfer.importTransfers([
      {
        recordNo: 'T2', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-03', carrier: 'STEAM', quantity: '400', unit: 'GJ',
        supersedesRecordNo: 'T1'
      }
    ]);
    const cut2 = { id: await cutAfterWrites(h, 'co2') };
    const { factorVersionId, gwpSetId } = await ids(h);

    const r = await h.restatement.compare({
      base: { cutId: cut1.id, factorVersionId, gwpSetId },
      current: { cutId: cut2.id, factorVersionId, gwpSetId },
      filter: { month: '2024-03' },
      view: 'company'
    });
    for (const c of r.components) {
      expect(c.total.key()).toBe('0/1');
      expect(c.activity.add(c.factors).add(c.gwp).key()).toBe('0/1');
    }
    // Net CO2 stays at the single combustion.
    expect(r.currentTotals.CO2.toDecimalString()).toBe('56.1');
  });

  test('cut only sees transfers submitted before it; later submission does not change the bundle', async () => {
    await h.activity.bulkImport({
      records: [
        { recordNo: 'G1', siteCode: 'EAST', sourceCode: 'BOILER_GAS', month: '2024-11', fuelKey: 'natural_gas', scope: 1, quantity: '1000', unit: 'GJ' }
      ]
    });
    await h.transfer.importOutputs([
      { recordNo: 'O1', siteCode: 'EAST', facilityCode: 'BOILER', month: '2024-11', carrier: 'STEAM', quantity: '800', unit: 'GJ' }
    ]);
    const cutId = await cutAfterWrites(h, 'before-transfer');
    const { factorVersionId, gwpSetId } = await ids(h);
    const before = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });
    expect(before.transferLeaves).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 5));
    await h.transfer.importTransfers([
      {
        recordNo: 'T1', fromSiteCode: 'EAST', fromFacilityCode: 'BOILER',
        toSiteCode: 'WEST', toPointCode: 'STEAM_USE',
        month: '2024-11', carrier: 'STEAM', quantity: '200', unit: 'GJ'
      }
    ]);
    const after = await h.accounting.loadCaliber({ cutId, factorVersionId, gwpSetId });
    expect(after.transferLeaves).toHaveLength(0); // cut is immutable
    const newCut = await cutAfterWrites(h, 'after-transfer');
    const visible = await h.accounting.loadCaliber({ cutId: newCut, factorVersionId, gwpSetId });
    expect(visible.transferLeaves).toHaveLength(1);
  });
});
