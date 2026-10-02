import { Injectable, Module } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbModule, DbService, type Queryer } from '../database/database.module';
import { ActivityDataModule, ActivityDataService, type ActivityRecord } from '../activity-data/activity-data.service';
import {
  FactorLibraryModule,
  FactorLibraryService
} from '../factor-library/factor-library.service';
import { GwpModule, GwpService } from '../factor-library/gwp.service';
import {
  aggregate,
  evaluateAll,
  grandTotal,
  type AggregateQuery,
  type AggregateRow,
  type Caliber,
  type FactorIndex,
  type RecordLeaf
} from './engine';
import {
  TransferAllocationModule,
  TransferAllocationService,
  type TransferLayer
} from '../transfer/transfer-allocation.service';
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
  /** Primary activity leaves (evaluated against factors), fixed order. */
  activityLeaves: RecordLeaf[];
  /** Scope-2 leaves from internal energy transfers (empty if none). */
  transferLeaves: RecordLeaf[];
  /** All leaves (activity + transfer); every aggregate is computed on this. */
  leaves: RecordLeaf[];
  /** Solved transfer network per month (balances, hops, coefficients). */
  transferLayer: TransferLayer;
}

@Injectable()
export class AccountingService {
  constructor(
    private readonly db: DbService,
    private readonly activity: ActivityDataService,
    private readonly factors: FactorLibraryService,
    private readonly gwp: GwpService,
    private readonly transfers: TransferAllocationService
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
    const [records, rows, props, gwpValues, referenceEfficiencies] = await Promise.all([
      this.activity.getEffectiveRecords(client, cut.asOf),
      this.factors.getFactors(client, caliber.factorVersionId),
      this.factors.getFuelProperties(client, caliber.factorVersionId),
      this.gwp.getValues(client, caliber.gwpSetId),
      this.factors.getReferenceEfficiencies(client, caliber.factorVersionId)
    ]);
    const index: FactorIndex = { rows, props, gwp: gwpValues, referenceEfficiencies };
    const activityLeaves = evaluateAll(records, index);
    // Internal-transfer layer: empty unless the database actually contains
    // outputs/transfers visible at this cut, in which case it produces
    // scope-2 TRANSFER leaves at receiving sites.
    const transferLayer = await this.transfers.buildLayer(
      client,
      cut.asOf,
      activityLeaves,
      records,
      index
    );
    const transferLeaves = transferLayer.leaves;
    // Deterministic merge: activity leaves are record-no sorted by
    // evaluateAll; transfer leaves are month/record-no sorted; concatenating
    // in that fixed order makes all downstream sums reproducible. With no
    // transfer data this array is exactly the pre-upgrade one, so every old
    // result stays bit-identical.
    const leaves = [...activityLeaves, ...transferLeaves];
    return {
      caliber,
      asOf: cut.asOf,
      factorVersion: version.version,
      gwpSetCode: gwpSet.rows[0].code,
      records,
      index,
      activityLeaves,
      transferLeaves,
      leaves,
      transferLayer
    };
  }

  aggregate(bundle: CaliberBundle, query: AggregateQuery = {}): AggregateRow[] {
    return aggregate(bundle.leaves, query);
  }

  grandTotal(bundle: CaliberBundle, query: AggregateQuery = {}) {
    return grandTotal(bundle.leaves, query);
  }

  /**
   * Company view with internal-transfer elimination.
   *
   *  - grossTotal: sum of all site views (ACTIVITY leaves + the TRANSFER
   *    scope-2 leaves received at sites) — "抵消前的各厂合计";
   *  - elimination: total embedded emissions on every internal transfer
   *    (the same mass is counted once as primary emissions at the producer
   *    and once as transfer scope 2 at the receiver) — "抵消额";
   *  - netTotal: gross − elimination, exactly the company-wide primary
   *    emissions: each unit of fuel burned is counted once.
   *
   * Only the TRANSFER leaves are eliminated; purchased-energy scope 2 and
   * all scope 1 are untouched. Gas masses are eliminated individually, and
   * CO2e is eliminated mass × GWP per gas, so changing only the GWP set
   * leaves every eliminated gas mass identical (the old GWP-invariance
   * property carries through the whole transfer chain).
   */
  companyTotals(bundle: CaliberBundle, query: Omit<AggregateQuery, 'category' | 'groupBy'> = {}): {
    grossTotal: import('./engine').GasTotals;
    elimination: import('./engine').GasTotals;
    netTotal: import('./engine').GasTotals;
  } {
    const grossTotal = this.grandTotal(bundle, query);
    const elim = grandTotal(bundle.leaves, { ...query, category: 'TRANSFER' });
    return {
      grossTotal,
      elimination: elim,
      netTotal: {
        CO2: grossTotal.CO2.sub(elim.CO2),
        CH4: grossTotal.CH4.sub(elim.CH4),
        N2O: grossTotal.N2O.sub(elim.N2O),
        CO2E: grossTotal.CO2E.sub(elim.CO2E)
      }
    };
  }

  /** Load a caliber bundle through the service's own pool. */
  loadCaliber(caliber: Caliber): Promise<CaliberBundle> {
    return this.loadBundle(this.db, caliber);
  }
}

@Module({
  imports: [DbModule, ActivityDataModule, FactorLibraryModule, GwpModule, TransferAllocationModule],
  providers: [AccountingService],
  exports: [AccountingService]
})
export class AccountingModule {}
