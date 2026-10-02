import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService, type Queryer } from '../database/database.module';
import { Fraction } from '../common/fraction';
import {
  AccountingModule,
  AccountingService,
  type CaliberBundle
} from '../accounting/accounting.service';
import { ActivityDataModule } from '../activity-data/activity-data.service';
import { MasterDataModule } from '../master-data/master-data.service';
import { facilityKey, traceTransfer, type AllocationHop } from './network';
import { type Carrier, type Gas } from '../factor-library/factor-library.service';
import type { RecordLeaf } from '../accounting/engine';

/**
 * Forward and reverse lineage over the internal transfer network.
 *
 * Forward (traceTransfer): from one receiver-side transfer scope-2 number,
 * give every primary activity record it ultimately came from, the factor
 * used, and the exact end-to-end allocation share of every hop. Ring effects
 * are the closed-form coefficients of (I − B)^{-1}, so the answer is finite
 * and never expands along the cycle.
 *
 * Reverse (impactOfRecord): after a record is corrected, list every already
 * closed snapshot that WOULD change if recomputed on latest data — including
 * sites affected only indirectly through transfers — with the propagation
 * path and the exact per-metric delta. Stored snapshots are never touched
 * (close semantics unchanged); this is an advisory "what would move" query.
 */

export interface TraceRequest {
  cutId: number;
  factorVersionId: number;
  gwpSetId: number;
  /** transfer record number as seen on the receiving site */
  transferRecordNo: string;
}

export interface TraceContribution {
  upstreamRecordNo: string;
  producerFacility: string;
  carrier: Carrier;
  /** end-to-end fraction of the producer record's gas mass on this transfer */
  share: Fraction;
  gasTonnes: Record<Gas, Fraction>;
  factorIdByGas: Record<Gas, number>;
  /** single-hop description of this transfer */
  hop: {
    recordNo: string;
    fromFacility: string;
    toSiteCode: string;
    toPointCode: string;
    hopShare: Fraction;
    carrier: Carrier;
  };
}

export interface TraceReport {
  transferRecordNo: string;
  contributions: TraceContribution[];
}

interface CloseRow {
  id: number;
  month: Date;
  is_company_wide: boolean;
  site_code: string | null;
  status: string;
}

export interface ImpactedSnapshot {
  closeId: number;
  month: string;
  isCompanyWide: boolean;
  siteCode: string | null;
  /** propagation chain of sites/facilities; length 1 for the direct site */
  propagationPath: string[];
  /** true when the impact reaches this site only through a transfer */
  viaTransfer: boolean;
  delta: {
    CO2: Fraction;
    CH4: Fraction;
    N2O: Fraction;
    CO2E: Fraction;
  };
}

export interface ImpactReport {
  recordNo: string;
  kind: 'ACTIVITY' | 'OUTPUT' | 'TRANSFER';
  impacted: ImpactedSnapshot[];
}

@Injectable()
export class TransferLineageService {
  constructor(
    private readonly db: DbService,
    private readonly accounting: AccountingService
  ) {}

  // --------------------------------------------------------------------------
  // Forward trace: transfer scope-2 number -> primary records + factors
  // --------------------------------------------------------------------------

  async trace(request: TraceRequest): Promise<TraceReport> {
    const bundle = await this.accounting.loadCaliber({
      cutId: request.cutId,
      factorVersionId: request.factorVersionId,
      gwpSetId: request.gwpSetId
    });
    const leaf = bundle.transferLeaves.find((l) => l.recordNo === request.transferRecordNo);
    if (!leaf) {
      return { transferRecordNo: request.transferRecordNo, contributions: [] };
    }
    const solution = bundle.transferLayer.solutions.get(leaf.month);
    if (!solution || !leaf.transfer) return { transferRecordNo: request.transferRecordNo, contributions: [] };
    const traced = traceTransfer(solution, request.transferRecordNo);
    if (!traced) return { transferRecordNo: request.transferRecordNo, contributions: [] };

    const contributions: TraceContribution[] = [];
    const primaryByFacility = bundle.transferLayer.primaryLeavesByFacility.get(leaf.month);
    for (const [producerKey, coeff] of [...traced.producerCoefficients.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      const recs = primaryByFacility?.get(producerKey) ?? [];
      for (const rec of [...recs].sort((a, b) => a.recordNo.localeCompare(b.recordNo))) {
        // Exact attribution. T_sender = Σ_p C[sender][p]·P_p, where P_p is
        // p's own primary input (its activity records). The hop mass coming
        // from producer p is hopShare·C[sender][p]·P_p; within p, P_p is
        // exactly the sum of its primary records' gas masses, so this
        // record contributes hopShare·C[sender][p]·recordMass. Summing over
        // every upstream record equals the transfer leaf mass bit-for-bit.
        const share = traced.hop.share.mul(coeff);
        contributions.push({
          upstreamRecordNo: rec.recordNo,
          producerFacility: producerKey,
          carrier: leaf.transfer.carrier,
          share,
          gasTonnes: {
            CO2: share.mul(rec.byGas.CO2.gasTonnes),
            CH4: share.mul(rec.byGas.CH4.gasTonnes),
            N2O: share.mul(rec.byGas.N2O.gasTonnes)
          },
          factorIdByGas: {
            CO2: rec.byGas.CO2.factorId!,
            CH4: rec.byGas.CH4.factorId!,
            N2O: rec.byGas.N2O.factorId!
          },
          hop: serializeHop(traced.hop)
        });
      }
    }
    return { transferRecordNo: request.transferRecordNo, contributions };
  }

  // --------------------------------------------------------------------------
  // Reverse impact: corrected record -> closed snapshots that would move
  // --------------------------------------------------------------------------

  async impactOfRecord(
    recordNo: string,
    latestCaliber?: { factorVersionId?: number; gwpSetId?: number }
  ): Promise<ImpactReport> {
    // Locate the record in any of the three activity tables.
    const kind = await this.classify(recordNo);

    // Build the "latest data" bundle (a fresh cut = everything committed).
    const client = this.db;
    const cut = await this.createCutOn(client, `impact ${recordNo} ${Date.now()}`);
    // Use the most recently published factor version/GWP unless overridden.
    const factorVersionId =
      latestCaliber?.factorVersionId ?? (await this.latestFactorVersionId(client));
    const gwpSetId = latestCaliber?.gwpSetId ?? (await this.latestGwpSetId(client));
    const latest = await this.accounting.loadBundle(client, {
      cutId: cut.id,
      factorVersionId,
      gwpSetId
    });

    const closes = await client.query<CloseRow>(
      `SELECT id, month, is_company_wide, site_code, status
       FROM close_periods WHERE status = 'closed' ORDER BY id`
    );

    // Direct site (where the record physically lives) for ACTIVITY records.
    let directSite: string | null = null;
    if (kind === 'ACTIVITY') {
      const r = await client.query<{ site_code: string }>(
        'SELECT site_code FROM activity_records WHERE record_no = $1',
        [recordNo]
      );
      directSite = r.rows[0]?.site_code ?? null;
    }

    // Sites the record can reach through the transfer network (latest data),
    // including the propagation path. Outputs/transfers affect their sender
    // site directly; downstream receivers are reached through hops.
    const reachable = this.reachableSites(latest, recordNo, kind, directSite);

    const impacted: ImpactedSnapshot[] = [];
    for (const cp of closes.rows) {
      const month = cp.month.toISOString().slice(0, 7);
      // Reconstruct the close caliber bundle: same locked cut/version/GWP.
      const meta = await client.query<{
        cut_id: number;
        factor_version_id: number;
        gwp_set_id: number;
      }>(
        'SELECT cut_id, factor_version_id, gwp_set_id FROM close_periods WHERE id = $1',
        [cp.id]
      );
      const m = meta.rows[0];
      const closed = await this.accounting.loadBundle(client, {
        cutId: m.cut_id,
        factorVersionId: m.factor_version_id,
        gwpSetId: m.gwp_set_id
      });

      const filter = { month };
      if (cp.is_company_wide) {
        const before = this.accounting.grandTotal(closed, filter);
        const after = this.accounting.grandTotal(latest, filter);
        const delta = deltaTotals(before, after);
        if (!isZeroDelta(delta)) {
          impacted.push({
            closeId: cp.id,
            month,
            isCompanyWide: true,
            siteCode: null,
            propagationPath: ['*'],
            viaTransfer: false,
            delta
          });
        }
      } else {
        const site = cp.site_code!;
        const reach = reachable.get(site);
        if (!reach) continue;
        const before = this.accounting.grandTotal(closed, { ...filter, siteCode: site });
        const after = this.accounting.grandTotal(latest, { ...filter, siteCode: site });
        const delta = deltaTotals(before, after);
        if (!isZeroDelta(delta)) {
          impacted.push({
            closeId: cp.id,
            month,
            isCompanyWide: false,
            siteCode: site,
            propagationPath: reach.path,
            viaTransfer: reach.viaTransfer,
            delta
          });
        }
      }
    }

    impacted.sort((a, b) => a.closeId - b.closeId);
    return { recordNo, kind, impacted };
  }

  /**
   * Sites a change of `recordNo` can influence, with the shortest propagation
   * path. BFS over the monthly transfer hops (final-use points attach the
   * sender's influence to the receiving site; bound points propagate through
   * the receiving facility's later outputs).
   */
  private reachableSites(
    bundle: CaliberBundle,
    recordNo: string,
    kind: ImpactReport['kind'],
    directSite: string | null
  ): Map<string, { path: string[]; viaTransfer: boolean }> {
    const out = new Map<string, { path: string[]; viaTransfer: boolean }>();

    // Start sites.
    let startSite = directSite;
    for (const o of bundle.transferLayer.outputs) {
      if (kind === 'OUTPUT' && o.recordNo === recordNo) startSite = o.siteCode;
    }
    for (const t of bundle.transferLayer.transfers) {
      if (kind === 'TRANSFER' && t.recordNo === recordNo) {
        startSite = t.fromSiteCode;
        // The receiver is directly affected by a transfer correction.
        out.set(t.toSiteCode, {
          path: [`${t.fromSiteCode} -> ${t.toSiteCode} (${t.recordNo})`],
          viaTransfer: true
        });
      }
    }
    if (startSite && !out.has(startSite)) out.set(startSite, { path: [startSite], viaTransfer: false });

    // All hops across months as edges (deterministic order).
    const allHops: AllocationHop[] = [];
    for (const [, solution] of [...bundle.transferLayer.solutions.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      allHops.push(...solution.transfers);
    }
    allHops.sort((a, b) => a.recordNo.localeCompare(b.recordNo));

    // Fixed-point expansion (BFS by path length); ring edges only re-visit
    // already reached sites, and there are finitely many sites, so this ends.
    let changed = true;
    while (changed) {
      changed = false;
      for (const hop of allHops) {
        const base = out.get(hop.fromSiteCode);
        if (!base) continue;
        const path = [...base.path, `${hop.fromSiteCode} -> ${hop.toSiteCode} (${hop.recordNo})`];
        const existing = out.get(hop.toSiteCode);
        if (!existing) {
          out.set(hop.toSiteCode, { path, viaTransfer: true });
          changed = true;
        } else if (path.length < existing.path.length) {
          existing.path = path;
          changed = true;
        }
      }
    }
    return out;
  }

  private async classify(recordNo: string): Promise<ImpactReport['kind']> {
    const a = await this.db.query('SELECT 1 FROM activity_records WHERE record_no = $1', [recordNo]);
    if (a.rows[0]) return 'ACTIVITY';
    const o = await this.db.query('SELECT 1 FROM energy_outputs WHERE record_no = $1', [recordNo]);
    if (o.rows[0]) return 'OUTPUT';
    const t = await this.db.query('SELECT 1 FROM energy_transfers WHERE record_no = $1', [recordNo]);
    if (t.rows[0]) return 'TRANSFER';
    return 'ACTIVITY';
  }

  private async createCutOn(client: Queryer, label: string): Promise<{ id: number }> {
    // "Everything committed up to now": the effective-record SQL uses
    // created_at <= as_of under the current statement snapshot.
    const r = await client.query<{ id: number }>(
      'INSERT INTO activity_cuts(label, as_of) VALUES ($1, now()) RETURNING id',
      [label]
    );
    return { id: r.rows[0].id };
  }

  private async latestFactorVersionId(client: Queryer): Promise<number> {
    const r = await client.query<{ id: number }>(
      'SELECT id FROM factor_versions ORDER BY id DESC LIMIT 1'
    );
    return r.rows[0].id;
  }

  private async latestGwpSetId(client: Queryer): Promise<number> {
    const r = await client.query<{ id: number }>(
      'SELECT id FROM gwp_sets ORDER BY id DESC LIMIT 1'
    );
    return r.rows[0].id;
  }
}

function serializeHop(hop: AllocationHop): TraceContribution['hop'] {
  return {
    recordNo: hop.recordNo,
    fromFacility: facilityKey(hop.fromSiteCode, hop.fromFacilityCode),
    toSiteCode: hop.toSiteCode,
    toPointCode: hop.toPointCode,
    hopShare: hop.share,
    carrier: hop.carrier
  };
}

function deltaTotals(
  before: { CO2: Fraction; CH4: Fraction; N2O: Fraction; CO2E: Fraction },
  after: { CO2: Fraction; CH4: Fraction; N2O: Fraction; CO2E: Fraction }
) {
  return {
    CO2: after.CO2.sub(before.CO2),
    CH4: after.CH4.sub(before.CH4),
    N2O: after.N2O.sub(before.N2O),
    CO2E: after.CO2E.sub(before.CO2E)
  };
}

function isZeroDelta(d: { CO2: Fraction; CH4: Fraction; N2O: Fraction; CO2E: Fraction }): boolean {
  return (
    d.CO2.sign() === 0 && d.CH4.sign() === 0 && d.N2O.sign() === 0 && d.CO2E.sign() === 0
  );
}

@Module({
  imports: [DbModule, AccountingModule, ActivityDataModule, MasterDataModule],
  providers: [TransferLineageService],
  exports: [TransferLineageService]
})
export class TransferLineageModule {}

// Keep type import used for the leaf mapping.
export type { RecordLeaf };
