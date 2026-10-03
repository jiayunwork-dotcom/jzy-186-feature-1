import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService, type Queryer } from '../database/database.module';
import { ActivityDataModule, ActivityDataService, type ActivityRecord } from '../activity-data/activity-data.service';
import {
  FactorLibraryModule,
  FactorLibraryService
} from '../factor-library/factor-library.service';
import { GwpModule, GwpService } from '../factor-library/gwp.service';
import { EnergyFlowModule, EnergyFlowService } from '../transfer/energy-flow.service';
import {
  aggregate,
  evaluateAll,
  grandTotal,
  type AccountingLeaf,
  type AggregateQuery,
  type AggregateRow,
  type Caliber,
  type FactorIndex,
  type RecordLeaf,
  type TransferLeaf
} from './engine';
import {
  allocateMonth,
  type AllocationResult,
  type DirectEmission,
  type OutputQty,
  type TransferEdge
} from '../transfer/allocation';
import { convert } from '../units/units.service';
import { GASES, type Gas } from '../factor-library/factor-library.service';
import { NotFoundError } from '../common/errors';

/**
 * Resolution of a caliber against immutable database objects. Once built, a
 * Bundle contains no live references: all arithmetic runs on frozen in-memory
 * tables, which is what makes repeated queries bit-identical.
 */
export interface CaliberBundle {
  caliber: Caliber;
  asOf: Date;
  factorVersion: string;
  gwpSetCode: string;
  records: ActivityRecord[];
  index: FactorIndex;
  /** Terminal direct leaves (facility-bound inputs excluded). */
  directLeaves: RecordLeaf[];
  /** Transfer-allocated scope-2 leaves (empty when no transfer data exists). */
  transferLeaves: TransferLeaf[];
  leaves: AccountingLeaf[];
  allocations: AllocationResult[];
}

@Injectable()
export class AccountingService {
  constructor(
    private readonly db: DbService,
    private readonly activity: ActivityDataService,
    private readonly factors: FactorLibraryService,
    private readonly gwp: GwpService,
    private readonly flows: EnergyFlowService
  ) {}

  /** Load everything one caliber needs. Read-only; may run in any snapshot. */
  async loadBundle(client: Queryer, caliber: Caliber): Promise<CaliberBundle> {
    const cut = await this.activity.getCutOn(client, caliber.cutId);
    const version = await this.factors.getVersionOn(client, caliber.factorVersionId);
    const gwpSet = await client.query<{ id: number; code: string }>(
      'SELECT id, code FROM gwp_sets WHERE id = $1',
      [caliber.gwpSetId]
    );
    if (!gwpSet.rows[0]) {
      throw new NotFoundError(`GWP set not found: ${caliber.gwpSetId}`);
    }
    const [records, rows, props, gwpValues, carrierEta, outputs, transfers, usePoints] =
      await Promise.all([
        this.activity.getEffectiveRecords(client, cut.asOf),
        this.factors.getFactors(client, caliber.factorVersionId),
        this.factors.getFuelProperties(client, caliber.factorVersionId),
        this.gwp.getValues(client, caliber.gwpSetId),
        this.factors.getCarrierEfficiencies(client, caliber.factorVersionId),
        this.flows.getEffectiveOutputs(client, cut.asOf),
        this.flows.getEffectiveTransfers(client, cut.asOf),
        this.flows.getAllUsePoints(client)
      ]);
    const index: FactorIndex = { rows, props, gwp: gwpValues };
    const allLeaves = evaluateAll(records, index);

    // The producer site keeps its full direct leaves (scope-1 combustion is
    // never removed from it); transfer allocation *adds* scope-2 leaves at
    // receiving sites, which the company view then eliminates on
    // consolidation. Facility-bound records additionally serve as the
    // facility *inputs* feeding the allocation.
    const directLeaves = allLeaves;
    const facilityLeaves = allLeaves.filter((l) => l.facilityCode);

    // month lookup tables
    const outMonth = new Map(outputs.map((o) => [o.recordNo, o.month]));
    const trMonth = new Map(transfers.map((t) => [t.recordNo, t.month]));

    const outQty: OutputQty[] = outputs.map((o) => ({
      facility: o.facilityCode,
      carrier: o.carrier,
      quantity: convert(o.quantityFraction, o.unit, 'GJ'),
      recordNo: o.recordNo
    }));
    const pointIndex = new Map(usePoints.map((p) => [`${p.siteCode}|${p.code}`, p]));
    const edges: TransferEdge[] = transfers.map((t) => {
      const point = pointIndex.get(`${t.toSiteCode}|${t.toUsePointCode}`);
      if (!point) {
        throw new NotFoundError(
          `transfer ${t.recordNo} targets missing use point ${t.toSiteCode}/${t.toUsePointCode}`
        );
      }
      return {
        recordNo: t.recordNo,
        facility: t.facilityCode,
        carrier: t.carrier,
        quantity: convert(t.quantityFraction, t.unit, 'GJ'),
        toSite: t.toSiteCode,
        toUsePoint: t.toUsePointCode,
        toFacility: point.facilityCode
      };
    });

    // Facility input emissions grouped by month.
    const directByMonth = new Map<string, DirectEmission[]>();
    for (const leaf of facilityLeaves) {
      const byGas = {} as DirectEmission['byGas'];
      for (const gas of GASES) {
        byGas[gas] = {
          factorId: leaf.byGas[gas].factorId,
          gasTonnes: leaf.byGas[gas].gasTonnes
        };
      }
      const d: DirectEmission = {
        recordNo: leaf.recordNo,
        facility: leaf.facilityCode!,
        siteCode: leaf.siteCode,
        sourceCode: leaf.sourceCode,
        month: leaf.month,
        scope: leaf.scope,
        byGas
      };
      const arr = directByMonth.get(leaf.month) ?? [];
      arr.push(d);
      directByMonth.set(leaf.month, arr);
    }

    const months = new Set<string>();
    outputs.forEach((o) => months.add(o.month));
    transfers.forEach((t) => months.add(t.month));
    directByMonth.forEach((_, m) => months.add(m));

    const allocations: AllocationResult[] = [];
    const transferLeaves: TransferLeaf[] = [];
    for (const month of [...months].sort()) {
      const result = allocateMonth({
        month,
        outputs: outQty.filter((o) => outMonth.get(o.recordNo) === month),
        transfers: edges.filter((e) => trMonth.get(e.recordNo) === month),
        direct: directByMonth.get(month) ?? [],
        carrierEta
      });
      allocations.push(result);
      for (const e of result.edges) {
        for (const gas of GASES) {
          const g = e.perGas[gas];
          transferLeaves.push({
            kind: 'transfer',
            category: 'TRANSFER',
            siteCode: e.siteCode,
            sourceCode: `TRANSFER:${e.usePoint}`,
            month,
            scope: 2,
            gas,
            gasTonnes: g.gasTonnes,
            co2eTonnes: g.gasTonnes.mul(gwpValues[gas as Gas]),
            edge: {
              recordNo: e.edge.recordNo,
              fromFacility: e.edge.fromFacility,
              toSite: e.edge.toSite,
              toUsePoint: e.edge.toUsePoint,
              carrier: e.edge.carrier,
              quantity: e.edge.quantity,
              toFacility: e.edge.toFacility,
              coefficient: e.edge.coefficient
            },
            origins: g.origins.map((o) => ({ ...o }))
          });
        }
      }
    }
    transferLeaves.sort((a, b) => {
      const ka = `${a.month}|${a.siteCode}|${a.sourceCode}|${a.edge.recordNo}|${a.gas}`;
      const kb = `${b.month}|${b.siteCode}|${b.sourceCode}|${b.edge.recordNo}|${b.gas}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    return {
      caliber,
      asOf: cut.asOf,
      factorVersion: version.version,
      gwpSetCode: gwpSet.rows[0].code,
      records,
      index,
      directLeaves,
      transferLeaves,
      leaves: [...directLeaves, ...transferLeaves],
      allocations
    };
  }

  aggregate(bundle: CaliberBundle, query: AggregateQuery = {}): AggregateRow[] {
    return aggregate(bundle.leaves, query);
  }

  grandTotal(bundle: CaliberBundle, query: AggregateQuery = {}) {
    return grandTotal(bundle.leaves, query);
  }

  /** Load a caliber bundle through the service's own pool. */
  loadCaliber(caliber: Caliber): Promise<CaliberBundle> {
    return this.loadBundle(this.db, caliber);
  }
}

@Module({
  imports: [DbModule, ActivityDataModule, FactorLibraryModule, GwpModule, EnergyFlowModule],
  providers: [AccountingService],
  exports: [AccountingService]
})
export class AccountingModule {}
