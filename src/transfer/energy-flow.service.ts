import { Injectable, Module } from '@nestjs/common';
import { DbModule, DbService, type Queryer } from '../database/database.module';
import { Fraction } from '../common/fraction';
import { ConflictError, FieldError, ValidationException } from '../common/errors';
import { isKnownUnit, dimensionOf } from '../units/units.service';
import { EnergyMasterModule, EnergyMasterService } from '../master-data/energy-master.service';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function monthToDate(month: string): Date {
  return new Date(`${month}-01T00:00:00Z`);
}

function monthFromDate(d: Date): string {
  return d.toISOString().slice(0, 7);
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface EnergyOutputInput {
  recordNo: string;
  facilityCode: string;
  /** YYYY-MM */
  month: string;
  /** steam / electricity / hot_water / ... */
  carrier: string;
  quantity: number | string;
  /** energy unit; must convert exactly to GJ (energy dimension only) */
  unit: string;
  supersedesRecordNo?: string;
}

export interface EnergyOutput {
  recordNo: string;
  facilityCode: string;
  month: string;
  carrier: string;
  quantityFraction: Fraction;
  unit: string;
  isCorrection: boolean;
  supersedesRecordNo: string | null;
  createdAt: Date;
}

interface StoredOutput {
  record_no: string;
  facility_code: string;
  month: Date;
  carrier: string;
  quantity_num: string;
  quantity_den: string;
  unit: string;
  is_correction: boolean;
  supersedes_record_no: string | null;
  created_at: Date;
}

function hydrateOutput(r: StoredOutput): EnergyOutput {
  return {
    recordNo: r.record_no,
    facilityCode: r.facility_code,
    month: monthFromDate(r.month),
    carrier: r.carrier,
    quantityFraction: Fraction.of(BigInt(r.quantity_num), BigInt(r.quantity_den)),
    unit: r.unit,
    isCorrection: r.is_correction,
    supersedesRecordNo: r.supersedes_record_no,
    createdAt: r.created_at
  };
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export interface EnergyTransferInput {
  recordNo: string;
  facilityCode: string;
  month: string;
  carrier: string;
  quantity: number | string;
  unit: string;
  toSiteCode: string;
  toUsePointCode: string;
  supersedesRecordNo?: string;
}

export interface EnergyTransfer {
  recordNo: string;
  facilityCode: string;
  month: string;
  carrier: string;
  quantityFraction: Fraction;
  unit: string;
  toSiteCode: string;
  toUsePointCode: string;
  isCorrection: boolean;
  supersedesRecordNo: string | null;
  createdAt: Date;
}

interface StoredTransfer {
  record_no: string;
  facility_code: string;
  month: Date;
  carrier: string;
  quantity_num: string;
  quantity_den: string;
  unit: string;
  to_site_code: string;
  to_use_point_code: string;
  is_correction: boolean;
  supersedes_record_no: string | null;
  created_at: Date;
}

function hydrateTransfer(r: StoredTransfer): EnergyTransfer {
  return {
    recordNo: r.record_no,
    facilityCode: r.facility_code,
    month: monthFromDate(r.month),
    carrier: r.carrier,
    quantityFraction: Fraction.of(BigInt(r.quantity_num), BigInt(r.quantity_den)),
    unit: r.unit,
    toSiteCode: r.to_site_code,
    toUsePointCode: r.to_use_point_code,
    isCorrection: r.is_correction,
    supersedesRecordNo: r.supersedes_record_no,
    createdAt: r.created_at
  };
}

export interface ImportResultItem {
  recordNo: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  errors?: FieldError[];
}

type Kind = 'output' | 'transfer';

interface BaseRow {
  recordNo: string;
  month: string;
  carrier: string;
  facilityCode: string;
  qty: Fraction;
  unit: string;
  supersedesRecordNo?: string;
}

/**
 * Registration service for energy outputs and internal transfers.
 *
 * The discipline is deliberately the same as activity_records:
 *  - unique record_no; identical re-submission is a harmless duplicate,
 *    different content under the same no is rejected;
 *  - corrections are new records with supersedes_record_no; one target can be
 *    corrected at most once (partial unique index is the concurrency guard);
 *  - visibility at a cut is purely created_at-driven via getEffective*, so a
 *    close cut sees exactly the outputs/transfers committed up to it.
 */
@Injectable()
export class EnergyFlowService {
  constructor(
    private readonly db: DbService,
    private readonly master: EnergyMasterService
  ) {}

  // -------------------------------------------------------------------------
  // Bulk import (shared machinery for both tables)
  // -------------------------------------------------------------------------

  async bulkImportOutputs(records: EnergyOutputInput[]): Promise<ImportResultItem[]> {
    return this.bulkImport('output', records);
  }

  async bulkImportTransfers(records: EnergyTransferInput[]): Promise<ImportResultItem[]> {
    return this.bulkImport('transfer', records);
  }

  async correctOutput(input: EnergyOutputInput) {
    const r = await this.bulkImportOutputs([input]);
    return this.mapCorrectionResult(input.recordNo, r[0]);
  }

  async correctTransfer(input: EnergyTransferInput) {
    const r = await this.bulkImportTransfers([input]);
    return this.mapCorrectionResult(input.recordNo, r[0]);
  }

  private mapCorrectionResult(recordNo: string, item: ImportResultItem) {
    if (item.status === 'rejected') {
      const conflict = item.errors?.find((e) => e.code === 'CORRECTION_TARGET_ALREADY_CORRECTED');
      if (conflict) throw new ConflictError('supersedesRecordNo', conflict.message, recordNo);
      throw new ValidationException(item.errors ?? []);
    }
    return { status: item.status, recordNo: item.recordNo };
  }

  private async bulkImport(kind: Kind, inputs: EnergyTransferInput[] | EnergyOutputInput[]) {
    if (!Array.isArray(inputs)) {
      throw new ValidationException([
        { field: 'records', code: 'MISSING_FIELD', message: 'records array required' }
      ]);
    }
    const results: ImportResultItem[] = new Array(inputs.length);

    // Deterministic in-batch de-duplication, first occurrence wins.
    const firstIndex = new Map<string, number>();
    const batchDuplicate = new Set<number>();
    inputs.forEach((r, i) => {
      if (!r.recordNo) return;
      if (firstIndex.has(r.recordNo)) batchDuplicate.add(i);
      else firstIndex.set(r.recordNo, i);
    });

    await this.db.withTransaction(async (client) => {
      const table = kind === 'output' ? 'energy_outputs' : 'energy_transfers';
      const nos = inputs.map((r) => r.recordNo).filter(Boolean);
      const existing = new Map<string, StoredOutput & StoredTransfer>();
      if (nos.length) {
        const cols =
          kind === 'output'
            ? `record_no, facility_code, month, carrier, quantity_num, quantity_den, unit,
                is_correction, supersedes_record_no, created_at`
            : `record_no, facility_code, month, carrier, quantity_num, quantity_den, unit,
                to_site_code, to_use_point_code, is_correction, supersedes_record_no, created_at`;
        const res = await client.query<StoredOutput & StoredTransfer>(
          `SELECT ${cols} FROM ${table} WHERE record_no = ANY($1)`,
          [nos]
        );
        for (const row of res.rows) existing.set(row.record_no, row);
      }

      const targets = inputs.map((r) => r.supersedesRecordNo).filter((x): x is string => !!x);
      const targetRows = targets.length
        ? await client.query<{ record_no: string }>(
            `SELECT record_no FROM ${table} WHERE record_no = ANY($1)`,
            [targets]
          )
        : null;
      const targetExists = new Set((targetRows?.rows ?? []).map((r) => r.record_no));
      const usedRows = targets.length
        ? await client.query<{ supersedes_record_no: string }>(
            `SELECT supersedes_record_no FROM ${table}
             WHERE supersedes_record_no = ANY($1)`,
            [targets]
          )
        : null;
      const alreadyCorrected = new Set((usedRows?.rows ?? []).map((r) => r.supersedes_record_no));
      const claimedInBatch = new Set<string>();
      // Committed heads this batch supersedes (drives the balance rebuild).
      const supersededInBatch = new Set<string>();

      // Per-record row validation; post-batch balance is enforced afterwards.
      const accepted: Array<{ idx: number; row: BaseRow }> = [];
      for (let i = 0; i < inputs.length; i++) {
        const rec = inputs[i] as EnergyTransferInput;

        if (batchDuplicate.has(i)) {
          results[i] = {
            recordNo: rec.recordNo,
            status: 'duplicate',
            errors: [
              {
                field: `records[${i}].recordNo`,
                code: 'DUPLICATE_KEY',
                message: `recordNo ${rec.recordNo} already appeared earlier in this batch; ignored`,
                recordId: rec.recordNo
              }
            ]
          };
          continue;
        }

        const prior = existing.get(rec.recordNo);
        if (prior) {
          const same = this.isSameRecord(kind, prior, rec);
          results[i] = same
            ? { recordNo: rec.recordNo, status: 'duplicate' }
            : {
                recordNo: rec.recordNo,
                status: 'rejected',
                errors: [
                  {
                    field: `records[${i}].recordNo`,
                    code: 'DUPLICATE_KEY',
                    message: `recordNo ${rec.recordNo} already exists with different content`,
                    recordId: rec.recordNo
                  }
                ]
              };
          continue;
        }

        const errors = await this.validateRecord(kind, rec, i, client, {
          exists: rec.supersedesRecordNo ? targetExists.has(rec.supersedesRecordNo) : false,
          free:
            !!rec.supersedesRecordNo &&
            targetExists.has(rec.supersedesRecordNo) &&
            !alreadyCorrected.has(rec.supersedesRecordNo) &&
            !claimedInBatch.has(rec.supersedesRecordNo)
        });
        if (errors.length) {
          results[i] = { recordNo: rec.recordNo, status: 'rejected', errors };
          continue;
        }
        const qty = Fraction.from(rec.quantity);
        if (rec.supersedesRecordNo) {
          claimedInBatch.add(rec.supersedesRecordNo);
          supersededInBatch.add(rec.supersedesRecordNo);
        }
        accepted.push({
          idx: i,
          row: {
            recordNo: rec.recordNo,
            month: rec.month,
            carrier: rec.carrier,
            facilityCode: rec.facilityCode,
            qty,
            unit: rec.unit,
            supersedesRecordNo: rec.supersedesRecordNo
          }
        });
        results[i] = { recordNo: rec.recordNo, status: 'accepted' };
      }

      // Recompute the post-batch effective sums from scratch: start from
      // committed heads, drop rows this batch supersedes, add accepted rows.
      // The supersede targets are committed rows (a batch never inserts a
      // record and corrects it in the same call), so no in-batch head case
      // has to be modeled.
      if (accepted.length) {
        const postOutputs = new Map<string, Fraction>();
        const postTransfers = new Map<string, Fraction>();
        await this.loadEffectiveSums(client, 'output', postOutputs);
        await this.loadEffectiveSums(client, 'transfer', postTransfers);

        // Fetch attributes of the heads this batch supersedes (they are not
        // in `existing`, which only contains the batch's own record numbers).
        const supersedeAttrs = new Map<
          string,
          { facility: string; month: string; carrier: string; qty: Fraction }
        >();
        if (supersededInBatch.size) {
          const headRes = await client.query<StoredOutput & StoredTransfer>(
            `SELECT record_no, facility_code, month, carrier, quantity_num, quantity_den, unit
             FROM ${table} WHERE record_no = ANY($1)`,
            [[...supersededInBatch]]
          );
          for (const head of headRes.rows) {
            supersedeAttrs.set(head.record_no, {
              facility: head.facility_code,
              month: monthFromDate(head.month),
              carrier: head.carrier,
              qty: Fraction.of(BigInt(head.quantity_num), BigInt(head.quantity_den))
            });
          }
        }
        const removeFrom = (
          target: Map<string, Fraction>,
          attr: { facility: string; month: string; carrier: string; qty: Fraction }
        ) => {
          const key = `${attr.facility}|${attr.month}|${attr.carrier}`;
          target.set(key, (target.get(key) ?? Fraction.ZERO).sub(attr.qty));
        };
        for (const attr of supersedeAttrs.values()) {
          if (kind === 'output') removeFrom(postOutputs, attr);
          else removeFrom(postTransfers, attr);
        }
        for (const { row } of accepted) {
          const key = `${row.facilityCode}|${row.month}|${row.carrier}`;
          const target = kind === 'output' ? postOutputs : postTransfers;
          target.set(key, (target.get(key) ?? Fraction.ZERO).add(row.qty));
        }

        // Balance: transfers must never exceed production of the same
        // carrier/month, whichever side the batch touched. A transfer batch
        // with no production at all gets TRANSFER_WITHOUT_OUTPUT; an output
        // batch corrected below already-sent volumes gets
        // TRANSFER_EXCEEDS_OUTPUT — so an over-producing correction cannot be
        // silently accepted and later produce a wrong number.
        for (const { idx, row } of accepted) {
          const key = `${row.facilityCode}|${row.month}|${row.carrier}`;
          const produced = postOutputs.get(key);
          const sent = postTransfers.get(key) ?? Fraction.ZERO;
          if (sent.sign() === 0) continue;
          if (!produced || produced.sign() === 0) {
            results[idx] = {
              recordNo: row.recordNo,
              status: 'rejected',
              errors: [
                {
                  field: `records[${idx}].carrier`,
                  code: 'TRANSFER_WITHOUT_OUTPUT',
                  message: `facility ${row.facilityCode} has transfers of ${row.carrier} in ${row.month} but no effective output record`,
                  recordId: row.recordNo
                }
              ]
            };
          } else if (sent.compare(produced) > 0) {
            results[idx] = {
              recordNo: row.recordNo,
              status: 'rejected',
              errors: [
                {
                  field: `records[${idx}].quantity`,
                  code: 'TRANSFER_EXCEEDS_OUTPUT',
                  message: `transfers of ${row.carrier} by ${row.facilityCode} in ${row.month} total ${sent.toDecimalString(6)} GJ but output is ${produced.toDecimalString(6)} GJ`,
                  recordId: row.recordNo
                }
              ]
            };
          }
        }

        // Insert only records that survived both stages.
        for (const { idx, row } of accepted) {
          if (results[idx].status !== 'accepted') continue;
          if (kind === 'output') {
            await client.query(
              `INSERT INTO energy_outputs
                 (record_no, facility_code, month, carrier, quantity_num, quantity_den,
                  unit, is_correction, supersedes_record_no)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                row.recordNo,
                row.facilityCode,
                monthToDate(row.month),
                row.carrier,
                row.qty.num,
                row.qty.den,
                row.unit,
                !!row.supersedesRecordNo,
                row.supersedesRecordNo ?? null
              ]
            );
          } else {
            const rec = inputs[idx] as EnergyTransferInput;
            await client.query(
              `INSERT INTO energy_transfers
                 (record_no, facility_code, month, carrier, quantity_num, quantity_den,
                  unit, to_site_code, to_use_point_code, is_correction, supersedes_record_no)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              [
                row.recordNo,
                row.facilityCode,
                monthToDate(row.month),
                row.carrier,
                row.qty.num,
                row.qty.den,
                row.unit,
                rec.toSiteCode,
                rec.toUsePointCode,
                !!row.supersedesRecordNo,
                row.supersedesRecordNo ?? null
              ]
            );
          }
        }
      }
    });

    return results;
  }

  private isSameRecord(
    kind: Kind,
    prior: StoredOutput & StoredTransfer,
    rec: EnergyTransferInput
  ): boolean {
    const base =
      prior.facility_code === rec.facilityCode &&
      monthFromDate(prior.month) === rec.month &&
      prior.carrier === rec.carrier &&
      prior.unit === rec.unit &&
      prior.supersedes_record_no === (rec.supersedesRecordNo ?? null) &&
      Fraction.of(BigInt(prior.quantity_num), BigInt(prior.quantity_den)).compare(
        Fraction.from(rec.quantity)
      ) === 0;
    if (!base) return false;
    if (kind === 'transfer') {
      const t = rec as EnergyTransferInput;
      return prior.to_site_code === t.toSiteCode && prior.to_use_point_code === t.toUsePointCode;
    }
    return true;
  }

  private async validateRecord(
    kind: Kind,
    rec: EnergyTransferInput,
    index: number,
    client: Queryer,
    correction: { exists: boolean; free: boolean }
  ): Promise<FieldError[]> {
    const p = `records[${index}]`;
    const errors: FieldError[] = [];

    if (!rec.recordNo) errors.push({ field: `${p}.recordNo`, code: 'MISSING_FIELD', message: 'recordNo required' });
    if (!rec.facilityCode) errors.push({ field: `${p}.facilityCode`, code: 'MISSING_FIELD', message: 'facilityCode required' });
    if (!rec.carrier) errors.push({ field: `${p}.carrier`, code: 'MISSING_FIELD', message: 'carrier required' });

    if (rec.quantity === undefined || rec.quantity === null || (rec.quantity as unknown) === '') {
      errors.push({ field: `${p}.quantity`, code: 'MISSING_FIELD', message: 'quantity required' });
    } else {
      try {
        const q = Fraction.from(rec.quantity);
        if (q.sign() <= 0) {
          errors.push({ field: `${p}.quantity`, code: 'NEGATIVE_OR_NON_FINITE', message: 'quantity must be strictly positive' });
        }
      } catch {
        errors.push({ field: `${p}.quantity`, code: 'NEGATIVE_OR_NON_FINITE', message: `not a finite number: ${String(rec.quantity)}` });
      }
    }

    if (!rec.unit) {
      errors.push({ field: `${p}.unit`, code: 'MISSING_FIELD', message: 'unit required' });
    } else if (!isKnownUnit(rec.unit)) {
      errors.push({ field: `${p}.unit`, code: 'UNKNOWN_UNIT', message: `unknown unit: ${rec.unit}` });
    } else if (dimensionOf(rec.unit) !== 'energy') {
      errors.push({
        field: `${p}.unit`,
        code: 'UNIT_NOT_CONVERTIBLE',
        message: `energy ${kind} unit must be an energy unit convertible to GJ, got ${rec.unit}`
      });
    }

    if (!MONTH_RE.test(rec.month ?? '')) {
      errors.push({ field: `${p}.month`, code: 'BAD_MONTH', message: 'month must be YYYY-MM' });
    }

    if (rec.facilityCode) {
      const facility = await this.master.getFacilityOn(client, rec.facilityCode);
      if (!facility) {
        errors.push({ field: `${p}.facilityCode`, code: 'NOT_FOUND', message: `facility not registered: ${rec.facilityCode}` });
      }
    }

    if (rec.supersedesRecordNo !== undefined) {
      if (!correction.exists) {
        errors.push({
          field: `${p}.supersedesRecordNo`,
          code: 'CORRECTION_TARGET_MISSING',
          message: `correction target does not exist: ${rec.supersedesRecordNo}`
        });
      } else if (!correction.free) {
        errors.push({
          field: `${p}.supersedesRecordNo`,
          code: 'CORRECTION_TARGET_ALREADY_CORRECTED',
          message: `record ${rec.supersedesRecordNo} has already been corrected`
        });
      }
    }

    if (kind === 'transfer') {
      const t = rec as EnergyTransferInput;
      if (!t.toSiteCode || !t.toUsePointCode) {
        errors.push({ field: `${p}.toUsePointCode`, code: 'MISSING_FIELD', message: 'toSiteCode and toUsePointCode required' });
      } else {
        const point = await this.master.getUsePointOn(client, t.toSiteCode, t.toUsePointCode);
        if (!point) {
          errors.push({
            field: `${p}.toUsePointCode`,
            code: 'NOT_FOUND',
            message: `energy use point ${t.toSiteCode}/${t.toUsePointCode} is not registered`
          });
        } else if (point.facilityCode && point.facilityCode === rec.facilityCode) {
          // A delivery straight back into the sending facility is an
          // unresolvable one-node loop: refuse it explicitly.
          errors.push({
            field: `${p}.toUsePointCode`,
            code: 'TRANSFER_TO_SELF',
            message: `facility ${rec.facilityCode} cannot transfer energy to a use point that feeds itself`
          });
        }
      }
    }

    return errors;
  }

  /**
   * Effective (facility, month, carrier) sums visible *now*: the head of
   * every correction chain (a row with no successor). The batch balance
   * check then removes heads the batch supersedes and adds accepted rows.
   */
  private async loadEffectiveSums(
    client: Queryer,
    kind: Kind,
    target: Map<string, Fraction>
  ): Promise<void> {
    const table = kind === 'output' ? 'energy_outputs' : 'energy_transfers';
    const res = await client.query<{
      facility_code: string;
      month: Date;
      carrier: string;
      quantity_num: string;
      quantity_den: string;
    }>(
      `SELECT r.facility_code, r.month, r.carrier,
              r.quantity_num, r.quantity_den
       FROM ${table} r
       WHERE NOT EXISTS (
           SELECT 1 FROM ${table} s
           WHERE s.supersedes_record_no = r.record_no
       )`
    );
    for (const r of res.rows) {
      const key = `${r.facility_code}|${monthFromDate(r.month)}|${r.carrier}`;
      target.set(
        key,
        (target.get(key) ?? Fraction.ZERO).add(
          Fraction.of(BigInt(r.quantity_num), BigInt(r.quantity_den))
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // Cut-visible effective record sets (same semantics as activity records)
  // -------------------------------------------------------------------------

  async getEffectiveOutputs(client: Queryer, asOf: Date): Promise<EnergyOutput[]> {
    const res = await client.query<StoredOutput>(
      `SELECT record_no, facility_code, month, carrier, quantity_num, quantity_den,
              unit, is_correction, supersedes_record_no, created_at
       FROM energy_outputs r
       WHERE r.created_at <= $1
         AND NOT EXISTS (
             SELECT 1 FROM energy_outputs s
             WHERE s.supersedes_record_no = r.record_no AND s.created_at <= $1
         )
       ORDER BY r.record_no`,
      [asOf]
    );
    return res.rows.map(hydrateOutput);
  }

  async getEffectiveTransfers(client: Queryer, asOf: Date): Promise<EnergyTransfer[]> {
    const res = await client.query<StoredTransfer>(
      `SELECT record_no, facility_code, month, carrier, quantity_num, quantity_den,
              unit, to_site_code, to_use_point_code, is_correction,
              supersedes_record_no, created_at
       FROM energy_transfers r
       WHERE r.created_at <= $1
         AND NOT EXISTS (
             SELECT 1 FROM energy_transfers s
             WHERE s.supersedes_record_no = r.record_no AND s.created_at <= $1
         )
       ORDER BY r.record_no`,
      [asOf]
    );
    return res.rows.map(hydrateTransfer);
  }

  /** All use points (static master data; effective transfers resolve against it). */
  async getAllUsePoints(client: Queryer) {
    const res = await client.query<{
      site_code: string;
      code: string;
      name: string;
      facility_code: string | null;
    }>(
      'SELECT site_code, code, name, facility_code FROM energy_use_points ORDER BY site_code, code'
    );
    return res.rows.map((r) => ({
      siteCode: r.site_code,
      code: r.code,
      name: r.name,
      facilityCode: r.facility_code
    }));
  }

  async getAllFacilities(client: Queryer) {
    const res = await client.query<{ code: string; site_code: string; name: string }>(
      'SELECT code, site_code, name FROM facilities ORDER BY code'
    );
    return res.rows.map((r) => ({ code: r.code, siteCode: r.site_code, name: r.name }));
  }
}

@Module({
  imports: [DbModule, EnergyMasterModule],
  providers: [EnergyFlowService],
  exports: [EnergyFlowService]
})
export class EnergyFlowModule {}
