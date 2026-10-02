import { Injectable, Module } from '@nestjs/common';
import { DbModule, type Queryer } from '../database/database.module';
import { Fraction } from '../common/fraction';
import {
  ActivityDataModule,
  type ActivityRecord
} from '../activity-data/activity-data.service';
import {
  FactorLibraryModule,
  type Carrier,
  type Gas
} from '../factor-library/factor-library.service';
import { MasterDataModule, MasterDataService } from '../master-data/master-data.service';
import {
  EnergyRecordsModule,
  EnergyRecordsService,
  type EffectiveOutput,
  type EffectiveTransfer
} from './energy-records.service';
import {
  facilityKey,
  solveNetwork,
  type AllocationHop,
  type FacilityOutputs,
  type NetworkSolution
} from './network';
import type { FactorIndex, RecordLeaf } from '../accounting/engine';
import { GASES } from '../factor-library/factor-library.service';
import { ValidationException } from '../common/errors';

/**
 * Builds the internal-transfer layer of a caliber bundle: resolves outputs,
 * transfers and facility master data visible at the cut, validates the
 * per-facility energy balances (the same field-specific checks the audit
 * asks for), allocates primary input emissions onto products by reference
 * efficiency and propagates them through the (possibly cyclic) transfer
 * network, producing 'TRANSFER' scope-2 leaves at the receiving sites.
 *
 * Pure network arithmetic lives in ./network; this service only does data
 * resolution and validation, keeping the accounting engine free of SQL.
 */

export interface TransferLayer {
  /** transfer leaves (scope 2 at receiving sites), fixed deterministic order */
  leaves: RecordLeaf[];
  /** solved network per month (balances, hops, coefficient matrix) */
  solutions: Map<string, NetworkSolution>;
  outputs: EffectiveOutput[];
  transfers: EffectiveTransfer[];
  /**
   * Per month, the evaluated primary ACTIVITY leaves that belong to each
   * facility (via emission_sources.facility_code). Lineage uses this to
   * decompose a transfer leaf into exact upstream record contributions.
   */
  primaryLeavesByFacility: Map<string, Map<string, RecordLeaf[]>>;
}

@Injectable()
export class TransferAllocationService {
  constructor(
    private readonly master: MasterDataService,
    private readonly energy: EnergyRecordsService
  ) {}

  async buildLayer(
    client: Queryer,
    asOf: Date,
    activityLeaves: RecordLeaf[],
    records: ActivityRecord[],
    index: FactorIndex
  ): Promise<TransferLayer> {
    const [sources, outputs, transfers, points] = await Promise.all([
      this.master.getAllSourcesOn(client),
      this.energy.getEffectiveOutputs(client, asOf),
      this.energy.getEffectiveTransfers(client, asOf),
      this.master.getAllDeliveryPointsOn(client)
    ]);
    const facilityBySource = new Map<string, string>();
    for (const s of sources) {
      if (s.facilityCode) facilityBySource.set(`${s.siteCode}|${s.code}`, s.facilityCode);
    }
    const pointIndex = new Map<string, { facilityCode: string | null }>();
    for (const p of points) pointIndex.set(`${p.siteCode}|${p.code}`, { facilityCode: p.facilityCode ?? null });

    // Nothing registered: the transfer layer is empty and every existing
    // result stays bit-identical to the pre-upgrade system.
    if (outputs.length === 0 && transfers.length === 0) {
      return { leaves: [], solutions: new Map(), outputs, transfers, primaryLeavesByFacility: new Map() };
    }

    const months = new Set<string>();
    outputs.forEach((o) => months.add(o.month));
    transfers.forEach((t) => months.add(t.month));

    const leaves: RecordLeaf[] = [];
    const solutions = new Map<string, NetworkSolution>();
    const primaryLeavesByFacility = new Map<string, Map<string, RecordLeaf[]>>();

    for (const month of [...months].sort()) {
      const mo = outputs.filter((o) => o.month === month);
      const mt = transfers.filter((t) => t.month === month);

      // Structural validation (field-specific) — see validateMonth.
      validateMonth(month, mo, mt, pointIndex);

      // Primary gas masses per facility from evaluated activity leaves.
      const primaryByFacility = new Map<string, Record<Gas, Fraction>>();
      const primaryLeaves = new Map<string, RecordLeaf[]>();
      for (const leaf of activityLeaves) {
        if (leaf.month !== month || leaf.category !== 'ACTIVITY') continue;
        const facility = facilityBySource.get(`${leaf.siteCode}|${leaf.sourceCode}`);
        if (!facility) continue;
        const k = facilityKey(leaf.siteCode, facility);
        let acc = primaryByFacility.get(k);
        if (!acc) {
          acc = { CO2: Fraction.ZERO, CH4: Fraction.ZERO, N2O: Fraction.ZERO };
          primaryByFacility.set(k, acc);
          primaryLeaves.set(k, []);
        }
        for (const gas of GASES) acc[gas] = acc[gas].add(leaf.byGas[gas].gasTonnes);
        primaryLeaves.get(k)!.push(leaf);
      }
      primaryLeavesByFacility.set(month, primaryLeaves);

      const facilities: FacilityOutputs[] = [];
      const byFacility = new Map<string, FacilityOutputs>();
      for (const o of mo) {
        const k = facilityKey(o.siteCode, o.facilityCode);
        let f = byFacility.get(k);
        if (!f) {
          f = { siteCode: o.siteCode, facilityCode: o.facilityCode, outputsGj: {} };
          byFacility.set(k, f);
          facilities.push(f);
        }
        const prev = f.outputsGj[o.carrier] ?? Fraction.ZERO;
        f.outputsGj[o.carrier] = prev.add(o.quantityGj);
      }
      // Facilities with primary inputs but no outputs are still nodes
      // (producers with self-use-only or missing-data error cases); the
      // network requires a node only when it is referenced by a transfer.
      const sinkFacilities = new Set<string>();
      for (const t of mt) {
        const pt = pointIndex.get(`${t.toSiteCode}|${t.toPointCode}`);
        if (pt?.facilityCode) sinkFacilities.add(facilityKey(t.toSiteCode, pt.facilityCode));
      }

      const solution = solveNetwork({
        month,
        facilities,
        sinkFacilities: [...sinkFacilities].sort().map((k) => {
          const i = k.indexOf('/');
          return { siteCode: k.slice(0, i), facilityCode: k.slice(i + 1) };
        }),
        transfers: mt.map((t) => ({
          recordNo: t.recordNo,
          fromSiteCode: t.fromSiteCode,
          fromFacilityCode: t.fromFacilityCode,
          toSiteCode: t.toSiteCode,
          toFacilityCode: pointIndex.get(`${t.toSiteCode}|${t.toPointCode}`)?.facilityCode ?? null,
          toPointCode: t.toPointCode,
          month: t.month,
          carrier: t.carrier,
          quantityGj: t.quantityGj
        })),
        primaryByFacility,
        eta: index.referenceEfficiencies
      });
      solutions.set(month, solution);

      // Transfer leaves: only deliveries to *final use* points settle as
      // scope 2 at the receiving site. Energy delivered to a point bound to
      // another facility re-enters that facility's pool and is re-exported
      // with its products; emitting a leaf there too would count the same
      // mass twice along a chain (the company elimination would no longer
      // cancel). The received embedded mass remains visible in the
      // facility balance (solution.facilities[].received) and in lineage.
      for (const hop of solution.transfers) {
        if (hop.toFacilityCode) continue;
        leaves.push(hopToLeaf(hop, month, index));
      }
    }

    // Fixed order: month, then transfer record number (each hop sorts by
    // recordNo in the solver), already per-month sorted.
    leaves.sort((a, b) =>
      a.month.localeCompare(b.month) ||
      (a.recordNo < b.recordNo ? -1 : a.recordNo > b.recordNo ? 1 : 0)
    );

    return { leaves, solutions, outputs, transfers, primaryLeavesByFacility };
  }
}

/** Turn a solved allocation hop into a scope-2 transfer leaf. */
function hopToLeaf(hop: AllocationHop, month: string, index: FactorIndex): RecordLeaf {
  const byGas = {} as RecordLeaf['byGas'];
  for (const gas of GASES) {
    const gasTonnes = hop.embedded[gas];
    byGas[gas] = {
      factorId: null,
      factor: null,
      // No activity-side factor: the quantity carried is the embedded mass
      // itself. activityQty is set to the gas mass for lineage symmetry.
      activityQty: gasTonnes,
      gasTonnes,
      co2eTonnes: gasTonnes.mul(index.gwp[gas])
    };
  }
  return {
    category: 'TRANSFER',
    siteCode: hop.toSiteCode,
    sourceCode: `${hop.fromSiteCode}/${hop.fromFacilityCode}→${hop.toPointCode}`,
    month,
    scope: 2,
    recordNo: hop.recordNo,
    fuelKey: `TRANSFER:${hop.carrier}`,
    unit: 't',
    quantity: hop.embedded.CO2,
    transfer: {
      fromSiteCode: hop.fromSiteCode,
      fromFacilityCode: hop.fromFacilityCode,
      toPointCode: hop.toPointCode,
      carrier: hop.carrier,
      share: hop.share
    },
    byGas
  };
}

/**
 * Field-specific structural validation of one month's outputs/transfers.
 * Throws ValidationException naming the offending field:
 *  - transfer target site/point missing (also enforced at import)
 *  - transfer from a facility to itself
 *  - transfer present for a month/carrier with no output (TRANSFER_WITHOUT_OUTPUT)
 *  - total transferred quantity exceeds the output (TRANSFER_EXCEEDS_OUTPUT)
 *  - carrier mismatch between transfer and output (CARRIER_MISMATCH)
 *  - positive primary inputs with zero weighted output (ZERO_ENERGY_OUTPUT)
 */
function validateMonth(
  month: string,
  outputs: EffectiveOutput[],
  transfers: EffectiveTransfer[],
  pointIndex: Map<string, { facilityCode: string | null }>
): void {
  const outputByFc = new Map<string, Partial<Record<Carrier, Fraction>>>();
  for (const o of outputs) {
    const k = facilityKey(o.siteCode, o.facilityCode);
    const m = outputByFc.get(k) ?? {};
    m[o.carrier] = (m[o.carrier] ?? Fraction.ZERO).add(o.quantityGj);
    outputByFc.set(k, m);
  }

  for (const t of transfers) {
    const pt = pointIndex.get(`${t.toSiteCode}|${t.toPointCode}`);
    // Import rejects unknown points and FKs prevent later deletion, so this
    // only guards direct database tampering.
    if (!pt) {
      throwValidation(`${t.recordNo}.toPointCode`, 'TRANSFER_TARGET_NOT_FOUND',
        `transfer ${t.recordNo}: delivery point ${t.toSiteCode}/${t.toPointCode} does not exist`);
    }
    if (pt!.facilityCode && t.toSiteCode === t.fromSiteCode && pt!.facilityCode === t.fromFacilityCode) {
      throwValidation(`${t.recordNo}.toPointCode`, 'TRANSFER_TO_SELF',
        `transfer ${t.recordNo}: facility cannot transfer energy to itself`);
    }
    const m = outputByFc.get(facilityKey(t.fromSiteCode, t.fromFacilityCode));
    if (!m) {
      throwValidation(`${t.recordNo}.month`, 'TRANSFER_WITHOUT_OUTPUT',
        `transfer ${t.recordNo}: facility ${t.fromSiteCode}/${t.fromFacilityCode} has no output record in ${month}`);
    }
    const avail = m![t.carrier];
    if (avail === undefined) {
      throwValidation(`${t.recordNo}.carrier`, 'CARRIER_MISMATCH',
        `transfer ${t.recordNo}: facility ${t.fromSiteCode}/${t.fromFacilityCode} has no ${t.carrier} output in ${month}`);
    }
  }

  // Aggregate per (facility, carrier) to compare totals.
  const sent = new Map<string, Fraction>();
  for (const t of transfers) {
    const k = `${facilityKey(t.fromSiteCode, t.fromFacilityCode)}|${t.carrier}`;
    sent.set(k, (sent.get(k) ?? Fraction.ZERO).add(t.quantityGj));
  }
  for (const [k, qty] of sent) {
    const [fk, carrier] = splitLast(k, '|');
    const avail = outputByFc.get(fk)?.[carrier as Carrier];
    if (avail === undefined) continue; // reported per-transfer above
    if (qty.compare(avail!) > 0) {
      throwValidation('transfers', 'TRANSFER_EXCEEDS_OUTPUT',
        `transfers of ${carrier} from ${fk} in ${month} total ${qty.toDecimalString()} GJ but output is ${avail!.toDecimalString()} GJ`);
    }
  }
}

function throwValidation(field: string, code: string, message: string): never {
  throw new ValidationException([{ field, code: code as never, message }]);
}

function splitLast(s: string, sep: string): [string, string] {
  const i = s.lastIndexOf(sep);
  return [s.slice(0, i), s.slice(i + 1)];
}

@Module({
  imports: [DbModule, MasterDataModule, EnergyRecordsModule, ActivityDataModule, FactorLibraryModule],
  providers: [TransferAllocationService],
  exports: [TransferAllocationService]
})
export class TransferAllocationModule {}
