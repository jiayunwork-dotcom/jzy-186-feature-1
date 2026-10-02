import { Injectable, Module } from '@nestjs/common';
import { DbModule, type Queryer } from '../database/database.module';
import { Fraction } from '../common/fraction';
import { FieldError, ValidationException } from '../common/errors';
import { dimensionOf, isKnownUnit } from '../units/units.service';
import type { Carrier } from '../factor-library/factor-library.service';
import { MasterDataModule, MasterDataService } from '../master-data/master-data.service';

/**
 * Monthly energy production outputs and internal transfers.
 *
 * These two record families obey the exact same data-integrity rules as
 * activity records (`activity-data.service.ts`):
 *  - unique record_no, original rows never deleted;
 *  - corrections are new rows with supersedes_record_no, one correction per
 *    record (partial unique index is the concurrency guard);
 *  - duplicate submission with the identical payload is idempotent and never
 *    double-counted; a conflicting same-number payload is rejected;
 *  - a cut only sees rows with created_at <= as_of whose correction chain
 *    has no successor visible by the cut.
 */

export interface EnergyOutputInput {
  recordNo: string;
  siteCode: string;
  facilityCode: string;
  month: string; // YYYY-MM
  carrier: Carrier;
  quantity: number | string;
  /** energy unit convertible to GJ (GJ, MWh, kWh, MJ) */
  unit: string;
  supersedesRecordNo?: string;
}

export interface EnergyTransferInput {
  recordNo: string;
  fromSiteCode: string;
  fromFacilityCode: string;
  toSiteCode: string;
  toPointCode: string;
  month: string; // YYYY-MM
  carrier: Carrier;
  quantity: number | string;
  unit: string;
  supersedesRecordNo?: string;
}

export interface EnergyRecordResultItem {
  recordNo: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  errors?: FieldError[];
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const CARRIERS: Carrier[] = ['STEAM', 'HOT_WATER', 'ELECTRICITY'];

interface OutputRow {
  record_no: string;
  site_code: string;
  facility_code: string;
  month: Date;
  carrier: Carrier;
  quantity_num: string;
  quantity_den: string;
  unit: string;
  is_correction: boolean;
  supersedes_record_no: string | null;
  created_at: Date;
}

interface TransferRow {
  record_no: string;
  from_site_code: string;
  from_facility_code: string;
  to_site_code: string;
  to_point_code: string;
  month: Date;
  carrier: Carrier;
  quantity_num: string;
  quantity_den: string;
  unit: string;
  is_correction: boolean;
  supersedes_record_no: string;
  created_at: Date;
}

export interface EffectiveOutput {
  recordNo: string;
  siteCode: string;
  facilityCode: string;
  month: string;
  carrier: Carrier;
  quantityGj: Fraction;
  unit: string;
  createdAt: Date;
}

export interface EffectiveTransfer {
  recordNo: string;
  fromSiteCode: string;
  fromFacilityCode: string;
  toSiteCode: string;
  toPointCode: string;
  month: string;
  carrier: Carrier;
  quantityGj: Fraction;
  unit: string;
  createdAt: Date;
}

function monthToString(d: Date): string {
  return d.toISOString().slice(0, 7);
}

const ENERGY_BASE_GJ: Record<string, Fraction> = {
  GJ: Fraction.ONE,
  MJ: Fraction.from(1).div(Fraction.from(1000)),
  kWh: Fraction.from(3.6).div(Fraction.from(1000)),
  MWh: Fraction.from(3.6)
};

/** Convert an exact quantity to GJ; throws UnitError-shaped Error otherwise. */
export function toGigajoules(quantity: Fraction, unit: string): Fraction {
  const mul = ENERGY_BASE_GJ[unit];
  if (mul) return quantity.mul(mul);
  if (isKnownUnit(unit)) {
    const e = new Error(`unit ${unit} is not an energy unit; outputs/transfers must be convertible to GJ`);
    e.name = 'UnitError';
    throw e;
  }
  const e = new Error(`unknown unit: ${unit}`);
  e.name = 'UnitError';
  throw e;
}

function isEnergyUnit(unit: string): boolean {
  if (unit in ENERGY_BASE_GJ) return true;
  try {
    return isKnownUnit(unit) && dimensionOf(unit) === 'energy';
  } catch {
    return false;
  }
}

@Injectable()
export class EnergyRecordsService {
  constructor(private readonly master: MasterDataService) {}

  // --------------------------------------------------------------------------
  // Outputs
  // --------------------------------------------------------------------------

  async importOutputs(
    client: Queryer,
    records: EnergyOutputInput[]
  ): Promise<EnergyRecordResultItem[]> {
    if (!Array.isArray(records)) {
      throw new ValidationException([{ field: 'outputs', code: 'MISSING_FIELD', message: 'outputs array required' }]);
    }
    const results: EnergyRecordResultItem[] = [];
    const firstIndex = new Map<string, number>();
    const batchDuplicate = new Set<number>();
    records.forEach((r, i) => {
      if (firstIndex.has(r.recordNo)) batchDuplicate.add(i);
      else firstIndex.set(r.recordNo, i);
    });

    const nos = records.map((r) => r.recordNo).filter(Boolean);
    const existing = new Map<string, OutputRow>();
    if (nos.length) {
      const res = await client.query<OutputRow>(
        `SELECT record_no, site_code, facility_code, month, carrier,
                quantity_num, quantity_den, unit, is_correction,
                supersedes_record_no, created_at
         FROM energy_outputs WHERE record_no = ANY($1)`,
        [nos]
      );
      for (const row of res.rows) existing.set(row.record_no, row);
    }
    const targetNos = records.map((r) => r.supersedesRecordNo).filter((x): x is string => !!x);
    const targetExists = new Set<string>();
    const alreadyCorrected = new Set<string>();
    if (targetNos.length) {
      const t = await client.query<{ record_no: string }>(
        'SELECT record_no FROM energy_outputs WHERE record_no = ANY($1)',
        [targetNos]
      );
      t.rows.forEach((r) => targetExists.add(r.record_no));
      const u = await client.query<{ supersedes_record_no: string }>(
        `SELECT supersedes_record_no FROM energy_outputs
         WHERE supersedes_record_no = ANY($1)`,
        [targetNos]
      );
      u.rows.forEach((r) => alreadyCorrected.add(r.supersedes_record_no));
    }
    const claimedInBatch = new Set<string>();

    const accepted: EnergyOutputInput[] = [];

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const p = `outputs[${i}]`;
      if (batchDuplicate.has(i)) {
        results[i] = {
          recordNo: rec.recordNo,
          status: 'duplicate',
          errors: [{ field: `${p}.recordNo`, code: 'DUPLICATE_KEY', message: `recordNo ${rec.recordNo} already appeared earlier in this batch`, recordId: rec.recordNo }]
        };
        continue;
      }
      const prior = existing.get(rec.recordNo);
      if (prior) {
        const same =
          prior.site_code === rec.siteCode &&
          prior.facility_code === rec.facilityCode &&
          prior.carrier === rec.carrier &&
          prior.unit === rec.unit &&
          monthToString(prior.month) === rec.month &&
          prior.supersedes_record_no === (rec.supersedesRecordNo ?? null) &&
          Fraction.of(BigInt(prior.quantity_num), BigInt(prior.quantity_den)).compare(
            Fraction.from(rec.quantity)
          ) === 0;
        results[i] = same
          ? { recordNo: rec.recordNo, status: 'duplicate' }
          : { recordNo: rec.recordNo, status: 'rejected',
              errors: [{ field: `${p}.recordNo`, code: 'DUPLICATE_KEY', message: `recordNo ${rec.recordNo} already exists with different content`, recordId: rec.recordNo }] };
        continue;
      }

      const errors = await this.validateOutput(client, rec, p, {
        exists: rec.supersedesRecordNo ? targetExists.has(rec.supersedesRecordNo) : false,
        free: rec.supersedesRecordNo
          ? targetExists.has(rec.supersedesRecordNo) &&
            !alreadyCorrected.has(rec.supersedesRecordNo) &&
            !claimedInBatch.has(rec.supersedesRecordNo)
          : true
      });
      if (errors.length) {
        results[i] = { recordNo: rec.recordNo, status: 'rejected', errors };
        continue;
      }
      if (rec.supersedesRecordNo) claimedInBatch.add(rec.supersedesRecordNo);
      accepted.push(rec);
      results[i] = { recordNo: rec.recordNo, status: 'accepted' };
    }

    for (const rec of accepted) {
      const qty = Fraction.from(rec.quantity);
      await client.query(
        `INSERT INTO energy_outputs
           (record_no, site_code, facility_code, month, carrier,
            quantity_num, quantity_den, unit, is_correction, supersedes_record_no)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          rec.recordNo, rec.siteCode, rec.facilityCode, monthDate(rec.month), rec.carrier,
          qty.num, qty.den, rec.unit,
          rec.supersedesRecordNo ? true : false, rec.supersedesRecordNo ?? null
        ]
      );
    }
    return results;
  }

  private async validateOutput(
    client: Queryer,
    rec: EnergyOutputInput,
    p: string,
    correction: { exists: boolean; free: boolean }
  ): Promise<FieldError[]> {
    const errors: FieldError[] = [];
    if (!rec.recordNo) errors.push({ field: `${p}.recordNo`, code: 'MISSING_FIELD', message: 'recordNo required' });
    if (!MONTH_RE.test(rec.month ?? '')) errors.push({ field: `${p}.month`, code: 'BAD_MONTH', message: 'month must be YYYY-MM' });
    if (!CARRIERS.includes(rec.carrier)) errors.push({ field: `${p}.carrier`, code: 'INVALID_VALUE', message: `carrier must be one of ${CARRIERS.join('/')}` });
    let q: Fraction | null = null;
    try {
      q = Fraction.from(rec.quantity);
      if (q.sign() < 0) errors.push({ field: `${p}.quantity`, code: 'NEGATIVE_OR_NON_FINITE', message: 'quantity must not be negative' });
    } catch {
      errors.push({ field: `${p}.quantity`, code: 'NEGATIVE_OR_NON_FINITE', message: `quantity is not a finite number: ${String(rec.quantity)}` });
    }
    if (!rec.unit) errors.push({ field: `${p}.unit`, code: 'MISSING_FIELD', message: 'unit required' });
    else if (!isEnergyUnit(rec.unit)) {
      errors.push({ field: `${p}.unit`, code: 'ENERGY_UNIT_NOT_CONVERTIBLE', message: `unit ${rec.unit} is not an energy unit convertible to GJ` });
    } else if (q) {
      try {
        toGigajoules(q, rec.unit);
      } catch (e) {
        errors.push({ field: `${p}.unit`, code: 'ENERGY_UNIT_NOT_CONVERTIBLE', message: (e as Error).message });
      }
    }
    if (!rec.siteCode) errors.push({ field: `${p}.siteCode`, code: 'MISSING_FIELD', message: 'siteCode required' });
    if (!rec.facilityCode) errors.push({ field: `${p}.facilityCode`, code: 'MISSING_FIELD', message: 'facilityCode required' });
    if (rec.siteCode && rec.facilityCode) {
      const f = await this.master.getFacilityOn(client, rec.siteCode, rec.facilityCode);
      if (!f) errors.push({ field: `${p}.facilityCode`, code: 'NOT_FOUND', message: `facility ${rec.siteCode}/${rec.facilityCode} is not registered` });
    }
    if (rec.supersedesRecordNo) {
      if (!correction.exists) errors.push({ field: `${p}.supersedesRecordNo`, code: 'CORRECTION_TARGET_MISSING', message: `correction target does not exist: ${rec.supersedesRecordNo}` });
      else if (!correction.free) errors.push({ field: `${p}.supersedesRecordNo`, code: 'CORRECTION_TARGET_ALREADY_CORRECTED', message: `output ${rec.supersedesRecordNo} has already been corrected` });
    }
    return errors;
  }

  async getEffectiveOutputs(client: Queryer, asOf: Date): Promise<EffectiveOutput[]> {
    const res = await client.query<OutputRow>(
      `SELECT r.record_no, r.site_code, r.facility_code, r.month, r.carrier,
              r.quantity_num, r.quantity_den, r.unit, r.is_correction,
              r.supersedes_record_no, r.created_at
       FROM energy_outputs r
       WHERE r.created_at <= $1
         AND NOT EXISTS (
             SELECT 1 FROM energy_outputs s
             WHERE s.supersedes_record_no = r.record_no AND s.created_at <= $1
         )
       ORDER BY r.record_no`,
      [asOf]
    );
    return res.rows.map((r) => {
      const q = Fraction.of(BigInt(r.quantity_num), BigInt(r.quantity_den));
      return {
        recordNo: r.record_no,
        siteCode: r.site_code,
        facilityCode: r.facility_code,
        month: monthToString(r.month),
        carrier: r.carrier,
        quantityGj: toGigajoules(q, r.unit),
        unit: r.unit,
        createdAt: r.created_at
      };
    });
  }

  // --------------------------------------------------------------------------
  // Transfers
  // --------------------------------------------------------------------------

  async importTransfers(
    client: Queryer,
    records: EnergyTransferInput[]
  ): Promise<EnergyRecordResultItem[]> {
    if (!Array.isArray(records)) {
      throw new ValidationException([{ field: 'transfers', code: 'MISSING_FIELD', message: 'transfers array required' }]);
    }
    const results: EnergyRecordResultItem[] = [];
    const firstIndex = new Map<string, number>();
    const batchDuplicate = new Set<number>();
    records.forEach((r, i) => {
      if (firstIndex.has(r.recordNo)) batchDuplicate.add(i);
      else firstIndex.set(r.recordNo, i);
    });

    const nos = records.map((r) => r.recordNo).filter(Boolean);
    const existing = new Map<string, TransferRow>();
    if (nos.length) {
      const res = await client.query<TransferRow>(
        `SELECT record_no, from_site_code, from_facility_code, to_site_code,
                to_point_code, month, carrier, quantity_num, quantity_den,
                unit, is_correction, supersedes_record_no, created_at
         FROM energy_transfers WHERE record_no = ANY($1)`,
        [nos]
      );
      for (const row of res.rows) existing.set(row.record_no, row);
    }
    const targetNos = records.map((r) => r.supersedesRecordNo).filter((x): x is string => !!x);
    const targetExists = new Set<string>();
    const alreadyCorrected = new Set<string>();
    if (targetNos.length) {
      const t = await client.query<{ record_no: string }>(
        'SELECT record_no FROM energy_transfers WHERE record_no = ANY($1)',
        [targetNos]
      );
      t.rows.forEach((r) => targetExists.add(r.record_no));
      const u = await client.query<{ supersedes_record_no: string }>(
        `SELECT supersedes_record_no FROM energy_transfers
         WHERE supersedes_record_no = ANY($1)`,
        [targetNos]
      );
      u.rows.forEach((r) => alreadyCorrected.add(r.supersedes_record_no));
    }
    const claimedInBatch = new Set<string>();
    const accepted: Array<{ rec: EnergyTransferInput }> = [];

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const p = `transfers[${i}]`;
      if (batchDuplicate.has(i)) {
        results[i] = {
          recordNo: rec.recordNo,
          status: 'duplicate',
          errors: [{ field: `${p}.recordNo`, code: 'DUPLICATE_KEY', message: `recordNo ${rec.recordNo} already appeared earlier in this batch`, recordId: rec.recordNo }]
        };
        continue;
      }
      const prior = existing.get(rec.recordNo);
      if (prior) {
        const same =
          prior.from_site_code === rec.fromSiteCode &&
          prior.from_facility_code === rec.fromFacilityCode &&
          prior.to_site_code === rec.toSiteCode &&
          prior.to_point_code === rec.toPointCode &&
          prior.carrier === rec.carrier &&
          prior.unit === rec.unit &&
          monthToString(prior.month) === rec.month &&
          prior.supersedes_record_no === (rec.supersedesRecordNo ?? null) &&
          Fraction.of(BigInt(prior.quantity_num), BigInt(prior.quantity_den)).compare(
            Fraction.from(rec.quantity)
          ) === 0;
        results[i] = same
          ? { recordNo: rec.recordNo, status: 'duplicate' }
          : { recordNo: rec.recordNo, status: 'rejected',
              errors: [{ field: `${p}.recordNo`, code: 'DUPLICATE_KEY', message: `recordNo ${rec.recordNo} already exists with different content`, recordId: rec.recordNo }] };
        continue;
      }

      const errors = await this.validateTransfer(client, rec, p, {
        exists: rec.supersedesRecordNo ? targetExists.has(rec.supersedesRecordNo) : false,
        free: rec.supersedesRecordNo
          ? targetExists.has(rec.supersedesRecordNo) &&
            !alreadyCorrected.has(rec.supersedesRecordNo) &&
            !claimedInBatch.has(rec.supersedesRecordNo)
          : true
      });
      if (errors.length) {
        results[i] = { recordNo: rec.recordNo, status: 'rejected', errors };
        continue;
      }
      if (rec.supersedesRecordNo) claimedInBatch.add(rec.supersedesRecordNo);
      accepted.push({ rec });
      results[i] = { recordNo: rec.recordNo, status: 'accepted' };
    }

    for (const { rec } of accepted) {
      const qty = Fraction.from(rec.quantity);
      await client.query(
        `INSERT INTO energy_transfers
           (record_no, from_site_code, from_facility_code, to_site_code,
            to_point_code, month, carrier, quantity_num, quantity_den, unit,
            is_correction, supersedes_record_no)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          rec.recordNo, rec.fromSiteCode, rec.fromFacilityCode, rec.toSiteCode,
          rec.toPointCode, monthDate(rec.month), rec.carrier,
          qty.num, qty.den, rec.unit,
          rec.supersedesRecordNo ? true : false, rec.supersedesRecordNo ?? null
        ]
      );
    }
    return results;
  }

  private async validateTransfer(
    client: Queryer,
    rec: EnergyTransferInput,
    p: string,
    correction: { exists: boolean; free: boolean }
  ): Promise<FieldError[]> {
    const errors: FieldError[] = [];
    if (!rec.recordNo) errors.push({ field: `${p}.recordNo`, code: 'MISSING_FIELD', message: 'recordNo required' });
    if (!MONTH_RE.test(rec.month ?? '')) errors.push({ field: `${p}.month`, code: 'BAD_MONTH', message: 'month must be YYYY-MM' });
    if (!CARRIERS.includes(rec.carrier)) errors.push({ field: `${p}.carrier`, code: 'INVALID_VALUE', message: `carrier must be one of ${CARRIERS.join('/')}` });
    let q: Fraction | null = null;
    try {
      q = Fraction.from(rec.quantity);
      if (q.sign() < 0) errors.push({ field: `${p}.quantity`, code: 'NEGATIVE_OR_NON_FINITE', message: 'quantity must not be negative' });
    } catch {
      errors.push({ field: `${p}.quantity`, code: 'NEGATIVE_OR_NON_FINITE', message: `quantity is not a finite number: ${String(rec.quantity)}` });
    }
    if (!rec.unit) errors.push({ field: `${p}.unit`, code: 'MISSING_FIELD', message: 'unit required' });
    else if (!isEnergyUnit(rec.unit)) {
      errors.push({ field: `${p}.unit`, code: 'ENERGY_UNIT_NOT_CONVERTIBLE', message: `unit ${rec.unit} is not an energy unit convertible to GJ` });
    }
    if (!rec.fromSiteCode || !rec.fromFacilityCode) {
      errors.push({ field: `${p}.fromFacilityCode`, code: 'MISSING_FIELD', message: 'fromSiteCode/fromFacilityCode required' });
    } else {
      const f = await this.master.getFacilityOn(client, rec.fromSiteCode, rec.fromFacilityCode);
      if (!f) errors.push({ field: `${p}.fromFacilityCode`, code: 'NOT_FOUND', message: `source facility ${rec.fromSiteCode}/${rec.fromFacilityCode} is not registered` });
    }
    if (!rec.toSiteCode || !rec.toPointCode) {
      errors.push({ field: `${p}.toPointCode`, code: 'MISSING_FIELD', message: 'toSiteCode/toPointCode required' });
    } else {
      const point = await this.master.getDeliveryPointOn(client, rec.toSiteCode, rec.toPointCode);
      if (!point) errors.push({ field: `${p}.toPointCode`, code: 'TRANSFER_TARGET_NOT_FOUND', message: `delivery point ${rec.toSiteCode}/${rec.toPointCode} is not registered` });
    }
    if (
      rec.fromSiteCode && rec.fromFacilityCode && rec.toSiteCode && rec.toPointCode &&
      rec.fromSiteCode === rec.toSiteCode
    ) {
      const point = await this.master.getDeliveryPointOn(client, rec.toSiteCode, rec.toPointCode);
      if (point && point.facilityCode === rec.fromFacilityCode) {
        errors.push({ field: `${p}.toPointCode`, code: 'TRANSFER_TO_SELF', message: `a facility cannot transfer energy to itself (${rec.fromSiteCode}/${rec.fromFacilityCode})` });
      }
    }
    if (rec.supersedesRecordNo) {
      if (!correction.exists) errors.push({ field: `${p}.supersedesRecordNo`, code: 'CORRECTION_TARGET_MISSING', message: `correction target does not exist: ${rec.supersedesRecordNo}` });
      else if (!correction.free) errors.push({ field: `${p}.supersedesRecordNo`, code: 'CORRECTION_TARGET_ALREADY_CORRECTED', message: `transfer ${rec.supersedesRecordNo} has already been corrected` });
    }
    return errors;
  }

  async getEffectiveTransfers(client: Queryer, asOf: Date): Promise<EffectiveTransfer[]> {
    const res = await client.query<TransferRow>(
      `SELECT r.record_no, r.from_site_code, r.from_facility_code,
              r.to_site_code, r.to_point_code, r.month, r.carrier,
              r.quantity_num, r.quantity_den, r.unit, r.is_correction,
              r.supersedes_record_no, r.created_at
       FROM energy_transfers r
       WHERE r.created_at <= $1
         AND NOT EXISTS (
             SELECT 1 FROM energy_transfers s
             WHERE s.supersedes_record_no = r.record_no AND s.created_at <= $1
         )
       ORDER BY r.record_no`,
      [asOf]
    );
    return res.rows.map((r) => {
      const q = Fraction.of(BigInt(r.quantity_num), BigInt(r.quantity_den));
      return {
        recordNo: r.record_no,
        fromSiteCode: r.from_site_code,
        fromFacilityCode: r.from_facility_code,
        toSiteCode: r.to_site_code,
        toPointCode: r.to_point_code,
        month: monthToString(r.month),
        carrier: r.carrier,
        quantityGj: toGigajoules(q, r.unit),
        unit: r.unit,
        createdAt: r.created_at
      };
    });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function monthDate(month: string): Date {
  return new Date(`${month}-01T00:00:00Z`);
}

@Module({
  imports: [DbModule, MasterDataModule],
  providers: [EnergyRecordsService],
  exports: [EnergyRecordsService]
})
export class EnergyRecordsModule {}
