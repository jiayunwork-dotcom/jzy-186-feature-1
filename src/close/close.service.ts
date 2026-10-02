import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService } from '../database/database.module';
import { Fraction } from '../common/fraction';
import {
  AccountingModule,
  AccountingService,
  type CaliberBundle
} from '../accounting/accounting.service';
import { GwpModule, GwpService } from '../factor-library/gwp.service';
import { GASES, type Gas, type Carrier } from '../factor-library/factor-library.service';
import { flattenLeaves, type RecordLeaf } from '../accounting/engine';
import { facilityKey, traceTransfer } from '../transfer/network';
import {
  ConflictError,
  NotFoundError,
  ValidationException
} from '../common/errors';

export interface CloseMonthInput {
  month: string; // YYYY-MM
  factorVersionId: number;
  gwpSetId: number;
  /** Close a single site; omit for the company-wide disclosure close. */
  siteCode?: string;
  /**
   * Activity cut to lock. If omitted, the close captures its own cut at the
   * instant it starts (clock_timestamp inside the repeatable-read txn).
   */
  cutId?: number;
}

export interface SnapshotQuery {
  closeId: number;
  siteCode?: string;
  sourceCode?: string;
  scope?: 1 | 2;
}

@Injectable()
export class CloseService {
  constructor(
    private readonly db: DbService,
    private readonly accounting: AccountingService,
    private readonly gwp: GwpService
  ) {}

  /**
   * Monthly close — the explicit disclosure operation.
   *
   * Isolation guarantees ("关账进行中若有人发布了新因子版本或提交了更正，
   * 关账结果只认它开始那一刻的数据"):
   *  1. The transaction runs on a REPEATABLE READ snapshot taken at its first
   *     read, so master data / factor rows it reads are frozen.
   *  2. The three caliber references are *immutable objects*: a factor
   *     version id always points at the same rows and the activity cut is a
   *     fixed timestamp. A concurrent publish creates a *new* version id and
   *     cannot alter the one the close holds; a correction committed after
   *     the cut timestamp is excluded by the effective-record query.
   *  3. A per-grain advisory lock makes concurrent closes of the same month
   *     deterministic: the second sees the first's committed row and fails
   *     with ALREADY_CLOSED.
   */
  async closeMonth(input: CloseMonthInput): Promise<{ closeId: number; cutId: number }> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) {
      throw new ValidationException([
        { field: 'month', code: 'BAD_MONTH', message: 'month must be YYYY-MM' }
      ]);
    }
    const monthDate = new Date(`${input.month}-01T00:00:00Z`);
    const isCompanyWide = !input.siteCode;

    return this.db.withSnapshotTransaction(async (client) => {
      // Grain lock key: company-wide closes share one key per month,
      // site closes a separate namespaced key.
      const lockKey = isCompanyWide
        ? hashLockKey(`close:company:${input.month}`)
        : hashLockKey(`close:site:${input.siteCode}:${input.month}`);
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      const dup = await client.query<{ id: number }>(
        `SELECT id FROM close_periods
         WHERE month = $1 AND is_company_wide = $2
           AND site_code IS NOT DISTINCT FROM $3 AND status = 'closed'`,
        [monthDate, isCompanyWide, input.siteCode ?? null]
      );
      if (dup.rows[0]) {
        throw new ConflictError('month', `${input.month} is already closed (close id ${dup.rows[0].id})`);
      }

      // Resolve / create the cut inside the transaction snapshot. The cut
      // timestamp is transaction_timestamp(): it equals the instant of the
      // first statement in this repeatable-read transaction, so (a) the
      // effective-record SQL cannot see rows committed afterwards, and (b) a
      // future on-demand recomputation against this very cut id applies the
      // same created_at <= as_of bound and reaches the same set. Using
      // clock_timestamp() here would let a correction committed mid-close be
      // snapshot-invisible now but visible in a later recomputation.
      let cutId = input.cutId;
      if (!cutId) {
        const r = await client.query<{ id: number }>(
          `INSERT INTO activity_cuts(label, as_of)
           VALUES ($1, now()) RETURNING id, as_of`,
          [`close ${input.month}${input.siteCode ? ` ${input.siteCode}` : ''}`]
        );
        cutId = r.rows[0].id;
      }

      // Validate the other caliber objects under the same snapshot.
      const fv = await client.query<{ id: number }>('SELECT id FROM factor_versions WHERE id = $1', [
        input.factorVersionId
      ]);
      if (!fv.rows[0]) throw new NotFoundError(`factor version ${input.factorVersionId} not found`);
      const gwpId = await this.gwp.resolveSetId(client, input.gwpSetId);

      const cp = await client.query<{ id: number }>(
        `INSERT INTO close_periods(month, is_company_wide, site_code, cut_id,
                                   factor_version_id, gwp_set_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'running') RETURNING id`,
        [monthDate, isCompanyWide, input.siteCode ?? null, cutId, input.factorVersionId, gwpId]
      );
      const closeId = cp.rows[0].id;

      // Compute the disclosure numbers from the immutable caliber. The month
      // (and optional site) filter defines the snapshot grain.
      const bundle = await this.accounting.loadBundle(client, {
        cutId,
        factorVersionId: input.factorVersionId,
        gwpSetId: gwpId
      });
      const leaves = bundle.leaves.filter(
        (l) => l.month === input.month && (!input.siteCode || l.siteCode === input.siteCode)
      );

      // 1) aggregate rows: one row per (site, source, month, scope,
      //    category, gas) plus CO2E. ACTIVITY and TRANSFER scope-2 rows are
      //    stored separately so received internal energy is never confused
      //    with purchased-energy scope 2.
      type AggKey = string;
      const agg = new Map<
        AggKey,
        {
          siteCode: string;
          sourceCode: string;
          scope: 1 | 2;
          category: 'ACTIVITY' | 'TRANSFER';
          values: { CO2: Fraction; CH4: Fraction; N2O: Fraction; CO2E: Fraction };
        }
      >();
      for (const leaf of leaves) {
        const key = JSON.stringify([leaf.siteCode, leaf.sourceCode, leaf.scope, leaf.category]);
        let row = agg.get(key);
        if (!row) {
          row = {
            siteCode: leaf.siteCode,
            sourceCode: leaf.sourceCode,
            scope: leaf.scope,
            category: leaf.category,
            values: { CO2: Fraction.ZERO, CH4: Fraction.ZERO, N2O: Fraction.ZERO, CO2E: Fraction.ZERO }
          };
          agg.set(key, row);
        }
        for (const gas of GASES) {
          row.values[gas] = row.values[gas].add(leaf.byGas[gas].gasTonnes);
          row.values.CO2E = row.values.CO2E.add(leaf.byGas[gas].co2eTonnes);
        }
      }
      for (const row of [...agg.values()].sort((a, b) =>
        `${a.siteCode}|${a.sourceCode}|${a.scope}|${a.category}`.localeCompare(
          `${b.siteCode}|${b.sourceCode}|${b.scope}|${b.category}`
        )
      )) {
        for (const gas of ['CO2', 'CH4', 'N2O', 'CO2E'] as const) {
          const v = row.values[gas];
          await client.query(
            `INSERT INTO snapshot_rows
               (close_id, site_code, source_code, month, scope, gas, category,
                value_num, value_den)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [closeId, row.siteCode, row.sourceCode, monthDate, row.scope, gas, row.category, v.num, v.den]
          );
        }
      }

      // 2) lineage: one row per (record, gas) with the exact factor and the
      //    quantity expressed in the factor unit (ACTIVITY leaves).
      const flat = flattenLeaves(leaves).filter((l) => l.category === 'ACTIVITY');
      for (const item of flat) {
        await client.query(
          `INSERT INTO snapshot_lineage
             (close_id, site_code, source_code, month, scope, gas, record_no,
              factor_id, activity_qty_num, activity_qty_den,
              gas_mass_num, gas_mass_den, category)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ACTIVITY')`,
          [
            closeId,
            item.siteCode,
            item.sourceCode,
            monthDate,
            item.scope,
            item.gas,
            item.recordNo,
            item.factorId,
            item.activityQty.num,
            item.activityQty.den,
            item.gasTonnes.num,
            item.gasTonnes.den
          ]
        );
      }

      // 3) transfer lineage: one row per final-use transfer leaf per gas and
      //    per upstream primary record, with the exact closed-form allocation
      //    share (ring effects folded into one coefficient, so lineage never
      //    expands infinitely). Each row carries the carrier and the full
      //    allocation path producer -> ... -> this transfer.
      const transferRows = leaves.filter((l) => l.category === 'TRANSFER');
      for (const leaf of transferRows) {
        const traces = buildTransferLineage(bundle, leaf);
        for (const tr of traces) {
          for (const gas of GASES) {
            await client.query(
              `INSERT INTO snapshot_lineage
                 (close_id, site_code, source_code, month, scope, gas, record_no,
                  factor_id, activity_qty_num, activity_qty_den,
                  gas_mass_num, gas_mass_den, category, carrier,
                  upstream_record_no, allocation_path)
               VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,'TRANSFER',$12,$13,$14)`,
              [
                closeId,
                leaf.siteCode,
                leaf.sourceCode,
                monthDate,
                leaf.scope,
                gas,
                leaf.recordNo,
                tr.gasMass[gas].num,
                tr.gasMass[gas].den,
                tr.gasMass[gas].num,
                tr.gasMass[gas].den,
                tr.carrier,
                tr.upstreamRecordNo,
                JSON.stringify(tr.path)
              ]
            );
          }
        }
      }

      await client.query(
        `UPDATE close_periods SET status = 'closed', closed_at = now() WHERE id = $1`,
        [closeId]
      );
      return { closeId, cutId };
    });
  }

  async getClose(closeId: number) {
    const res = await this.db.query(
      `SELECT cp.id, cp.month, cp.is_company_wide, cp.site_code, cp.status,
              cp.cut_id, cp.factor_version_id, cp.gwp_set_id,
              cp.started_at, cp.closed_at,
              fv.version AS factor_version, gs.code AS gwp_set, ac.as_of AS cut_as_of
       FROM close_periods cp
       JOIN factor_versions fv ON fv.id = cp.factor_version_id
       JOIN gwp_sets gs ON gs.id = cp.gwp_set_id
       JOIN activity_cuts ac ON ac.id = cp.cut_id
       WHERE cp.id = $1`,
      [closeId]
    );
    if (!res.rows[0]) throw new NotFoundError(`close ${closeId} not found`);
    return res.rows[0];
  }

  /** Materialized snapshot rows (never recomputed; this is disclosure data). */
  async querySnapshot(query: SnapshotQuery & { category?: 'ACTIVITY' | 'TRANSFER' }) {
    const res = await this.db.query(
      `SELECT site_code, source_code, month, scope, gas, category, value_num, value_den
       FROM snapshot_rows
       WHERE close_id = $1
         AND ($2::text IS NULL OR site_code = $2)
         AND ($3::text IS NULL OR source_code = $3)
         AND ($4::smallint IS NULL OR scope = $4)
         AND ($5::text IS NULL OR category = $5)
       ORDER BY site_code, source_code, month, scope, category, gas`,
      [
        query.closeId,
        query.siteCode ?? null,
        query.sourceCode ?? null,
        query.scope ?? null,
        query.category ?? null
      ]
    );
    return res.rows.map((r) => ({
      siteCode: r.site_code,
      sourceCode: r.source_code,
      month: (r.month as Date).toISOString().slice(0, 7),
      scope: r.scope,
      gas: r.gas,
      category: r.category as 'ACTIVITY' | 'TRANSFER',
      value: Fraction.of(BigInt(r.value_num), BigInt(r.value_den))
    }));
  }

  /** Lineage rows stored for a snapshot. */
  async querySnapshotLineage(query: SnapshotQuery & { category?: 'ACTIVITY' | 'TRANSFER' }) {
    const res = await this.db.query(
      `SELECT site_code, source_code, month, scope, gas, category, carrier,
              record_no, upstream_record_no, allocation_path, factor_id,
              activity_qty_num, activity_qty_den, gas_mass_num, gas_mass_den
       FROM snapshot_lineage
       WHERE close_id = $1
         AND ($2::text IS NULL OR site_code = $2)
         AND ($3::text IS NULL OR source_code = $3)
         AND ($4::smallint IS NULL OR scope = $4)
         AND ($5::text IS NULL OR category = $5)
       ORDER BY site_code, source_code, category, record_no, upstream_record_no, gas`,
      [
        query.closeId,
        query.siteCode ?? null,
        query.sourceCode ?? null,
        query.scope ?? null,
        query.category ?? null
      ]
    );
    return res.rows.map((r) => ({
      siteCode: r.site_code,
      sourceCode: r.source_code,
      month: (r.month as Date).toISOString().slice(0, 7),
      scope: r.scope,
      gas: r.gas as Gas,
      category: r.category as 'ACTIVITY' | 'TRANSFER',
      carrier: r.carrier as Carrier | null,
      recordNo: r.record_no,
      upstreamRecordNo: r.upstream_record_no as string | null,
      allocationPath: r.allocation_path as
        | Array<{
            transferRecordNo: string;
            fromFacility: string;
            toFacilityOrPoint: string;
            shareNum: string;
            shareDen: string;
            producerFacility: string;
            coefficientNum: string;
            coefficientDen: string;
          }>
        | null,
      factorId: r.factor_id as number | null,
      activityQty: Fraction.of(BigInt(r.activity_qty_num), BigInt(r.activity_qty_den)),
      gasTonnes: Fraction.of(BigInt(r.gas_mass_num), BigInt(r.gas_mass_den))
    }));
  }
}

/**
 * Decompose a final-use TRANSFER leaf's gas masses into one contribution per
 * upstream primary activity record. The closed-form coefficient
 * C[sender][producer]·share gives the fraction of each producer facility's
 * pool carried by the hop; within a producer facility, each primary record
 * contributes that fraction of its evaluated gas mass. The three gas masses
 * stay separate (no GWP here); the path records the producing hop with its
 * exact end-to-end fraction, so stored lineage answers "where did this tonne
 * come from" exactly and terminates on rings (cycles are in the coefficient).
 */
interface TransferLineageTrace {
  carrier: Carrier;
  upstreamRecordNo: string;
  producerFacility: string;
  fraction: Fraction;
  gasMass: Record<Gas, Fraction>;
  path: Array<{
    transferRecordNo: string;
    fromFacility: string;
    toFacilityOrPoint: string;
    /** this hop's share of its sender's allocation pool */
    shareNum: string;
    shareDen: string;
    /**
     * Producer facility this row traces to, and the closed-form network
     * coefficient C[sender][producer]: the exact fraction of the producer's
     * primary input present in the sender's pool with every ring traversal
     * already folded in. The effective end-to-end fraction is
     * hopShare × coefficient; stored explicitly so the lineage row is exact
     * and self-explanatory for multi-hop chains and rings.
     */
    producerFacility: string;
    coefficientNum: string;
    coefficientDen: string;
  }>;
}

function buildTransferLineage(bundle: CaliberBundle, leaf: RecordLeaf): TransferLineageTrace[] {
  const solution = bundle.transferLayer.solutions.get(leaf.month);
  if (!solution || !leaf.transfer) return [];
  const traced = traceTransfer(solution, leaf.recordNo);
  if (!traced) return [];

  const primaryByFacility = bundle.transferLayer.primaryLeavesByFacility.get(leaf.month);
  const carrier = leaf.transfer.carrier;
  const out: TransferLineageTrace[] = [];
  for (const [producerKey, coeff] of [...traced.producerCoefficients.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const recs = primaryByFacility?.get(producerKey) ?? [];
    for (const rec of [...recs].sort((a, b) => a.recordNo.localeCompare(b.recordNo))) {
      const fraction = traced.hop.share.mul(coeff);
      out.push({
        carrier,
        upstreamRecordNo: rec.recordNo,
        producerFacility: producerKey,
        fraction,
        gasMass: {
          CO2: fraction.mul(rec.byGas.CO2.gasTonnes),
          CH4: fraction.mul(rec.byGas.CH4.gasTonnes),
          N2O: fraction.mul(rec.byGas.N2O.gasTonnes)
        },
        path: [
          {
            transferRecordNo: leaf.recordNo,
            fromFacility: facilityKey(traced.hop.fromSiteCode, traced.hop.fromFacilityCode),
            toFacilityOrPoint: `${traced.hop.toSiteCode}/${traced.hop.toPointCode}`,
            shareNum: traced.hop.share.num.toString(),
            shareDen: traced.hop.share.den.toString(),
            producerFacility: producerKey,
            coefficientNum: coeff.num.toString(),
            coefficientDen: coeff.den.toString()
          }
        ]
      });
    }
  }
  return out;
}

/** Stable 64-bit hash for advisory-lock keys (xxhash-style FNV-1a 64). */
function hashLockKey(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  // pg_advisory_xact_lock takes signed bigint; map to signed range.
  if (h > 0x7fffffffffffffffn) h -= 0x10000000000000000n;
  return h;
}

@Module({
  imports: [DbModule, AccountingModule, GwpModule],
  providers: [CloseService],
  exports: [CloseService]
})
export class CloseModule {}