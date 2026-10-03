import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService } from '../database/database.module';
import {
  AccountingModule,
  AccountingService,
  type CaliberBundle
} from '../accounting/accounting.service';
import { GASES, type Gas } from '../factor-library/factor-library.service';
import { Fraction } from '../common/fraction';
import type { AggregateQuery, TransferLeaf } from '../accounting/engine';
import type { AllocationResult, TransferEdge } from '../transfer/allocation';

export interface LineageRequest {
  cutId: number;
  factorVersionId: number;
  gwpSetId: number;
  filter?: AggregateQuery;
}

export interface LineageContribution {
  siteCode: string;
  sourceCode: string;
  month: string;
  scope: 1 | 2;
  recordNo: string;
  fuelKey: string;
  inputQuantity: { value: Fraction; unit: string };
  perGas: Array<{
    gas: Gas;
    factorId: number;
    factorValue: Fraction;
    factorUnit: string;
    factorValidFrom: string;
    factorValidTo: string;
    activityQty: Fraction;
    activityUnit: string;
    gasTonnes: Fraction;
    gwp: Fraction;
    co2eTonnes: Fraction;
  }>;
}

export interface TransferContribution {
  month: string;
  receiverSite: string;
  usePoint: string;
  edgeRecordNo: string;
  carrier: string;
  fromFacility: string;
  perGas: Array<{
    gas: Gas;
    gasTonnes: Fraction;
    origins: Array<{ recordNo: string; facility: string; factorId: number; share: Fraction; gasTonnes: Fraction }>;
  }>;
}

export interface TraceHop {
  /** facility sending on this hop */
  fromFacility: string;
  /** receiving site/point */
  toSite: string;
  toUsePoint: string;
  /** facility the receiving point feeds, null when the hop ends in final use */
  toFacility: string | null;
  edgeRecordNo: string;
  carrier: string;
  /** exact product share applied on this hop */
  productShare: Fraction;
}

export interface TransferTraceResult {
  month: string;
  receiverSite: string;
  usePoint: string;
  edgeRecordNo: string;
  gas: Gas;
  gasTonnes: Fraction;
  /** One representative simple route per originating record (never cycles). */
  paths: Array<{
    originRecordNo: string;
    originFacility: string;
    factorId: number;
    /** exact fraction of the origin record's gas mass arriving at the point */
    exactShare: Fraction;
    /** product of hop product shares along the simple path */
    pathShare: Fraction;
    /**
     * exactShare / pathShare: the multiplier due to recirculation around
     * rings (1 when no ring is involved); keeps the walk finite while the
     * share stays exact.
     */
    circulationFactor: Fraction;
    hops: TraceHop[];
  }>;
}

export interface LineageReport {
  caliber: {
    cutId: number;
    cutAsOf: Date;
    factorVersionId: number;
    factorVersion: string;
    gwpSetId: number;
    gwpSetCode: string;
  };
  contributions: LineageContribution[];
  transferredContributions: TransferContribution[];
}

export interface SnapshotImpact {
  closeId: number;
  month: string;
  isCompanyWide: boolean;
  siteCode: string | null;
  affected: boolean;
  /** 'DIRECT' = the record backs the snapshot directly; 'TRANSFER' = only via the transfer chain */
  channels: Array<'DIRECT' | 'TRANSFER'>;
  /** sites (other than the record's) whose snapshot moves only through transfers */
  indirectlyAffectedSites: string[];
  changedRows: Array<{
    siteCode: string;
    sourceCode: string;
    scope: number;
    category: 'DIRECT' | 'TRANSFER';
    gas: string;
    stored: Fraction;
    recomputed: Fraction;
    delta: Fraction;
  }>;
  error?: string;
}

@Injectable()
export class LineageService {
  constructor(
    private readonly db: DbService,
    private readonly accounting: AccountingService
  ) {}

  /**
   * Direct-leaf lineage plus the transfer-allocated scope-2 leaves, each with
   * its exact per-origin decomposition. Recomputed from immutable caliber
   * objects, so an answer for one caliber never changes.
   */
  async explain(request: LineageRequest): Promise<LineageReport> {
    const q = request.filter ?? {};
    const bundle: CaliberBundle = await this.accounting.loadBundle(this.db, {
      cutId: request.cutId,
      factorVersionId: request.factorVersionId,
      gwpSetId: request.gwpSetId
    });

    const matches = bundle.directLeaves.filter((l) => {
      if (q.siteCode && l.siteCode !== q.siteCode) return false;
      if (q.sourceCode && l.sourceCode !== q.sourceCode) return false;
      if (q.month && l.month !== q.month) return false;
      if (q.scope && l.scope !== q.scope) return false;
      return true;
    });

    const contributions: LineageContribution[] = matches.map((l) => ({
      siteCode: l.siteCode,
      sourceCode: l.sourceCode,
      month: l.month,
      scope: l.scope,
      recordNo: l.recordNo,
      fuelKey: l.fuelKey,
      inputQuantity: { value: l.quantity, unit: l.unit },
      perGas: GASES.map((gas) => {
        const g = l.byGas[gas];
        return {
          gas,
          factorId: g.factorId,
          factorValue: g.factor.value,
          factorUnit: g.factor.factorUnit,
          factorValidFrom: g.factor.validFrom,
          factorValidTo: g.factor.validTo,
          activityQty: g.activityQty,
          activityUnit: g.factor.activityUnit,
          gasTonnes: g.gasTonnes,
          gwp: bundle.index.gwp[gas],
          co2eTonnes: g.co2eTonnes
        };
      })
    }));
    contributions.sort((a, b) => a.recordNo.localeCompare(b.recordNo));

    const tmatches = bundle.transferLeaves.filter((l) => {
      if (q.siteCode && l.siteCode !== q.siteCode) return false;
      if (q.sourceCode && l.sourceCode !== q.sourceCode) return false;
      if (q.month && l.month !== q.month) return false;
      if (q.scope && l.scope !== q.scope) return false;
      if (q.category && l.category !== q.category) return false;
      return true;
    });
    const transferredContributions = this.groupTransferLeaves(tmatches);

    return {
      caliber: {
        cutId: bundle.caliber.cutId,
        cutAsOf: bundle.asOf,
        factorVersionId: bundle.caliber.factorVersionId,
        factorVersion: bundle.factorVersion,
        gwpSetId: bundle.caliber.gwpSetId,
        gwpSetCode: bundle.gwpSetCode
      },
      contributions,
      transferredContributions
    };
  }

  /** Collapse 3 gas leaves per edge into one contribution. */
  private groupTransferLeaves(leaves: TransferLeaf[]): TransferContribution[] {
    const byEdge = new Map<string, TransferLeaf[]>();
    for (const l of leaves) {
      const key = `${l.month}|${l.edge.recordNo}`;
      const arr = byEdge.get(key) ?? [];
      arr.push(l);
      byEdge.set(key, arr);
    }
    const out: TransferContribution[] = [];
    for (const [, arr] of [...byEdge.entries()].sort()) {
      const first = arr[0];
      out.push({
        month: first.month,
        receiverSite: first.siteCode,
        usePoint: first.edge.toUsePoint,
        edgeRecordNo: first.edge.recordNo,
        carrier: first.edge.carrier,
        fromFacility: first.edge.fromFacility,
        perGas: GASES.map((gas) => {
          const leaf = arr.find((x) => x.gas === gas)!;
          return {
            gas,
            gasTonnes: leaf.gasTonnes,
            origins: leaf.origins.map((o) => ({
              recordNo: o.recordNo,
              facility: o.facility,
              factorId: o.factorId,
              share: o.share,
              gasTonnes: o.gasTonnes
            }))
          };
        })
      });
    }
    return out;
  }

  /**
   * Trace one receiver-side transfer scope-2 number back to its originating
   * fuel/purchase records. Each hop carries its exact allocation proportion;
   * rings are handled by walking one simple path (deterministic BFS) while the
   * share reported is the exact rational from the solved linear system, so a
   * ring never expands infinitely and nothing is approximated.
   */
  async traceTransfer(input: {
    cutId: number;
    factorVersionId: number;
    gwpSetId: number;
    month: string;
    receiverSite: string;
    edgeRecordNo: string;
    gas: Gas;
  }): Promise<TransferTraceResult> {
    const bundle = await this.accounting.loadBundle(this.db, {
      cutId: input.cutId,
      factorVersionId: input.factorVersionId,
      gwpSetId: input.gwpSetId
    });
    const allocation = bundle.allocations.find((a) => a.month === input.month);
    const leaf = bundle.transferLeaves.find(
      (l) =>
        l.month === input.month &&
        l.siteCode === input.receiverSite &&
        l.edge.recordNo === input.edgeRecordNo &&
        l.gas === input.gas
    );
    if (!leaf) {
      throw Object.assign(new Error('transfer leaf not found for the given caliber/month/edge'), {
        name: 'NotFoundError'
      });
    }

    const origins = leaf.origins;
    // Coefficient of the edge being traced (p_fc × q/Q_fc).
    const targetAllocated = allocation!.edges.find(
      (e) => e.edge.recordNo === input.edgeRecordNo
    )!;
    const targetCoefficient = targetAllocated.edge.coefficient;
    const targetEdge: TransferEdge = {
      recordNo: leaf.edge.recordNo,
      facility: leaf.edge.fromFacility,
      carrier: leaf.edge.carrier,
      quantity: leaf.edge.quantity,
      toSite: leaf.edge.toSite,
      toUsePoint: leaf.edge.toUsePoint,
      toFacility: leaf.edge.toFacility
    };
    const paths = origins
      .slice()
      .sort((a, b) =>
        a.recordNo.localeCompare(b.recordNo) || a.facility.localeCompare(b.facility)
      )
      .map((o) => {
        const { hops, pathShare } = this.simplePath(
          allocation!,
          targetEdge,
          targetCoefficient,
          leaf.edge.fromFacility,
          o.facility
        );
        return {
          originRecordNo: o.recordNo,
          originFacility: o.facility,
          factorId: o.factorId,
          exactShare: o.share,
          pathShare,
          circulationFactor: o.share.div(pathShare),
          hops
        };
      });

    return {
      month: input.month,
      receiverSite: input.receiverSite,
      usePoint: leaf.edge.toUsePoint,
      edgeRecordNo: input.edgeRecordNo,
      gas: input.gas,
      gasTonnes: leaf.gasTonnes,
      paths
    };
  }

  /**
   * Deterministic shortest simple facility path origin -> sender, followed by
   * the traced edge. Every hop carries its exact allocation coefficient
   * (p_fc × q/Q_fc); the product of hop coefficients is the simple-path
   * share. With a ring, exactShare / pathShare is the recirculation factor,
   * so walks stay finite while the number stays exact.
   */
  private simplePath(
    allocation: AllocationResult,
    targetEdge: TransferEdge,
    targetCoefficient: Fraction,
    sender: string,
    origin: string
  ): { hops: TraceHop[]; pathShare: Fraction } {
    let innerEdges: TransferEdge[] = [];
    if (sender !== origin) {
      // Reverse BFS over facility nodes along internal edges, recording the
      // predecessor edge on first discovery so the found route is a simple
      // path with no duplicate-found ambiguity.
      const preds = new Map<string, Array<{ from: string; edge: TransferEdge }>>();
      for (const e of allocation.internalEdges) {
        const arr = preds.get(e.toFacility!) ?? [];
        arr.push({ from: e.facility, edge: e });
        preds.set(e.toFacility!, arr);
      }
      const prev = new Map<string, { from: string; edge: TransferEdge }>();
      const visited = new Set<string>([sender]);
      const queue: string[] = [sender];
      while (queue.length) {
        const cur = queue.shift()!;
        const options = (preds.get(cur) ?? [])
          .slice()
          .sort((a, b) =>
            a.edge.recordNo.localeCompare(b.edge.recordNo) || a.from.localeCompare(b.from)
          );
        for (const { from, edge } of options) {
          if (visited.has(from)) continue;
          visited.add(from);
          prev.set(from, { from: cur, edge });
          queue.push(from);
        }
      }
      if (visited.has(origin)) {
        // Walk origin -> sender via predecessor pointers.
        const seq: TransferEdge[] = [];
        let node = origin;
        while (node !== sender) {
          const step = prev.get(node)!;
          seq.push(step.edge);
          node = step.from;
        }
        innerEdges = seq;
      }
    }

    const coeffOf = (e: TransferEdge): Fraction =>
      allocation.edges.find((x) => x.edge.recordNo === e.recordNo)!.edge.coefficient;
    const toHop = (e: TransferEdge): TraceHop => ({
      fromFacility: e.facility,
      toSite: e.toSite,
      toUsePoint: e.toUsePoint,
      toFacility: e.toFacility,
      edgeRecordNo: e.recordNo,
      carrier: e.carrier,
      productShare: coeffOf(e)
    });

    const hops = [...innerEdges.map(toHop), { ...toHop(targetEdge), productShare: targetCoefficient }];
    let pathShare = Fraction.ONE;
    for (const h of innerEdges) pathShare = pathShare.mul(coeffOf(h));
    pathShare = pathShare.mul(targetCoefficient);
    return { hops, pathShare };
  }

  /**
   * Reverse impact: which already-closed snapshots would change if
   * `recordNo` were corrected (recomputed against the *latest* cut, the
   * snapshot rows themselves stay frozen — this is a read-only impact query).
   * Sites affected only through the transfer chain are listed separately.
   */
  async snapshotImpactOfRecord(recordNo: string): Promise<SnapshotImpact[]> {
    return this.impactImpl(recordNo);
  }

  private async impactImpl(recordNo: string): Promise<SnapshotImpact[]> {
    const closes = await this.db.query<{
      id: number;
      month: Date;
      is_company_wide: boolean;
      site_code: string | null;
      cut_id: number;
      factor_version_id: number;
      gwp_set_id: number;
    }>(
      `SELECT id, month, is_company_wide, site_code, cut_id, factor_version_id, gwp_set_id
       FROM close_periods WHERE status = 'closed' ORDER BY id`
    );

    const latestCut = await this.db.query<{ id: number }>(
      `SELECT id FROM activity_cuts ORDER BY as_of DESC LIMIT 1`
    );
    const latestCutId = latestCut.rows[0]?.id;

    const out: SnapshotImpact[] = [];
    for (const c of closes.rows) {
      const month = c.month.toISOString().slice(0, 7);
      const stored = await this.db.query<{
        site_code: string;
        source_code: string;
        scope: number;
        category: string;
        gas: string;
        value_num: string;
        value_den: string;
      }>(
        `SELECT site_code, source_code, month, scope, category, gas, value_num, value_den
         FROM snapshot_rows WHERE close_id = $1`,
        [c.id]
      );
      let recomputed;
      try {
        // Recompute against the close's own factor/GWP but the LATEST cut.
        const cutId = latestCutId ?? c.cut_id;
        const bundle = await this.accounting.loadBundle(this.db, {
          cutId,
          factorVersionId: c.factor_version_id,
          gwpSetId: c.gwp_set_id
        });
        recomputed = bundle;
      } catch (e) {
        out.push({
          closeId: c.id,
          month,
          isCompanyWide: c.is_company_wide,
          siteCode: c.site_code,
          affected: false,
          channels: [],
          indirectlyAffectedSites: [],
          changedRows: [],
          error: (e as Error).message
        });
        continue;
      }

      // index live rows in the snapshot month
      const liveIndex = new Map<string, { num: bigint; den: bigint }>();
      for (const l of recomputed.leaves) {
        if (l.month !== month) continue;
        if (l.kind === 'transfer') {
          liveIndex.set(
            JSON.stringify([l.siteCode, l.sourceCode, l.scope, 'TRANSFER', l.gas]),
            { num: l.gasTonnes.num, den: l.gasTonnes.den }
          );
        } else {
          for (const gas of GASES) {
            liveIndex.set(
              JSON.stringify([l.siteCode, l.sourceCode, l.scope, 'DIRECT', gas]),
              { num: l.byGas[gas].gasTonnes.num, den: l.byGas[gas].gasTonnes.den }
            );
          }
        }
      }

      const changedRows: SnapshotImpact['changedRows'] = [];
      for (const r of stored.rows) {
        const key = JSON.stringify([r.site_code, r.source_code, r.scope, r.category, r.gas]);
        const live = liveIndex.get(key);
        const storedF = Fraction.of(BigInt(r.value_num), BigInt(r.value_den));
        const liveF = live ? Fraction.of(live.num, live.den) : Fraction.ZERO;
        if (storedF.compare(liveF) !== 0) {
          changedRows.push({
            siteCode: r.site_code,
            sourceCode: r.source_code,
            scope: r.scope,
            category: r.category as 'DIRECT' | 'TRANSFER',
            gas: r.gas,
            stored: storedF,
            recomputed: liveF,
            delta: liveF.sub(storedF)
          });
        }
      }
      // rows present live but not stored would also matter; detect them.
      for (const [key, v] of liveIndex) {
        const [siteCode, sourceCode, scope, category, gas] = JSON.parse(key) as [string, string, number, string, string];
        const exists = stored.rows.some(
          (r) =>
            r.site_code === siteCode &&
            r.source_code === sourceCode &&
            r.scope === scope &&
            r.category === category &&
            r.gas === gas
        );
        if (!exists) {
          const liveF = Fraction.of(v.num, v.den);
          if (liveF.sign() !== 0) {
            changedRows.push({
              siteCode,
              sourceCode,
              scope,
              category: category as 'DIRECT' | 'TRANSFER',
              gas,
              stored: Fraction.ZERO,
              recomputed: liveF,
              delta: liveF
            });
          }
        }
      }

      // Was this record involved at all in the *latest* month network?
      const involved = this.recordInvolvement(recomputed, month, recordNo);
      const channels: Array<'DIRECT' | 'TRANSFER'> = [];
      if (changedRows.some((r) => r.category === 'DIRECT')) channels.push('DIRECT');
      if (changedRows.some((r) => r.category === 'TRANSFER')) channels.push('TRANSFER');

      const originSite = recomputed.records.find((r) => r.recordNo === recordNo)?.siteCode ?? null;
      const indirectSites = [...new Set(
        changedRows
          .filter((r) => r.category === 'TRANSFER' && r.siteCode !== originSite)
          .map((r) => r.siteCode)
      )].sort();

      out.push({
        closeId: c.id,
        month,
        isCompanyWide: c.is_company_wide,
        siteCode: c.site_code,
        affected: changedRows.length > 0 && (involved.direct || involved.viaTransfer),
        channels: involved.direct || involved.viaTransfer ? channels : [],
        indirectlyAffectedSites: (involved.direct || involved.viaTransfer) && involved.viaTransfer ? indirectSites : [],
        changedRows: changedRows
      });
    }
    return out;
  }

  private recordInvolvement(
    bundle: CaliberBundle,
    month: string,
    recordNo: string
  ): { direct: boolean; viaTransfer: boolean } {
    const direct = bundle.directLeaves.some((l) => l.month === month && l.recordNo === recordNo);
    const viaTransfer = bundle.transferLeaves.some(
      (l) => l.month === month && l.origins.some((o) => o.recordNo === recordNo)
    );
    return { direct, viaTransfer };
  }
}

@Module({
  imports: [DbModule, AccountingModule],
  providers: [LineageService],
  exports: [LineageService]
})
export class LineageModule {}
