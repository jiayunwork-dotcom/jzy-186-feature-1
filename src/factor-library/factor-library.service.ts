import { Injectable, Module } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbModule, DbService, type Queryer } from '../database/database.module';
import { Fraction } from '../common/fraction';
import { ConflictError, FieldError, NotFoundError, ValidationException } from '../common/errors';
import { factorNumeratorToTonnes, parseFactorUnit } from './factor-unit';

export type Gas = 'CO2' | 'CH4' | 'N2O';
export const GASES: Gas[] = ['CO2', 'CH4', 'N2O'];

/** Carriers of internally produced/transferred energy. */
export type Carrier = 'STEAM' | 'HOT_WATER' | 'ELECTRICITY';
export const CARRIERS: Carrier[] = ['STEAM', 'HOT_WATER', 'ELECTRICITY'];

export interface ReferenceEfficiencyInput {
  carrier: Carrier;
  /** Dimensionless reference efficiency eta, strictly positive. */
  eta: number | string;
}

export interface FuelPropertyInput {
  fuelKey: string;
  /** kg/m3 */
  density?: number | string;
  /** net calorific value, GJ/tonne */
  ncv?: number | string;
}

export interface FactorInput {
  fuelKey: string;
  gas: Gas;
  scope: 1 | 2;
  value: number | string;
  /** e.g. "kg/GJ" */
  unit: string;
  /** inclusive first applicable month, YYYY-MM */
  validFrom: string;
  /** inclusive last applicable month, YYYY-MM */
  validTo: string;
}

export interface PublishFactorVersionInput {
  version: string;
  fuels?: FuelPropertyInput[];
  factors: FactorInput[];
  /**
   * CHP allocation reference efficiencies published with this version.
   * Omitted carriers fall back to built-in defaults; because the defaults are
   * fixed constants, omitting them never changes an old caliber.
   */
  referenceEfficiencies?: ReferenceEfficiencyInput[];
  publishedBy?: string;
  note?: string;
}

export interface FuelProperty {
  fuelKey: string;
  density: Fraction | null;
  ncv: Fraction | null;
}

export interface FactorRow {
  id: number;
  fuelKey: string;
  gas: Gas;
  scope: 1 | 2;
  value: Fraction;
  /** tonnes of gas per activity unit (numerator mass normalized to tonnes) */
  tonnesPerActivityUnit: Fraction;
  activityUnit: string;
  factorUnit: string;
  validFrom: string;
  validTo: string;
}

export interface FactorVersion {
  id: number;
  version: string;
  publishedAt: Date;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Built-in reference allocation efficiencies (see transfer/network.ts and
 * README §2.7 for the allocation method):
 *  - electricity: 0.45  (typical benchmark reference efficiency for power
 *    generation, in line with EU ETS CHP harmonized reference values)
 *  - steam / hot water: 0.90 (heat-only benchmark reference efficiency)
 * They are overridable per factor version; being fixed constants they never
 * perturb old calibers.
 */
export const DEFAULT_REFERENCE_EFFICIENCIES: Record<Carrier, Fraction> = {
  STEAM: Fraction.from('0.9'),
  HOT_WATER: Fraction.from('0.9'),
  ELECTRICITY: Fraction.from('0.45')
};

export function monthToDate(month: string): Date {
  if (!MONTH_RE.test(month)) {
    throw new ValidationException([
      { field: 'month', code: 'BAD_MONTH', message: `expected YYYY-MM, got "${month}"` }
    ]);
  }
  return new Date(`${month}-01T00:00:00Z`);
}

function monthFromDate(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function validateFactorInput(input: PublishFactorVersionInput): FieldError[] {
  const errors: FieldError[] = [];
  const seen = new Set<string>();

  (input.fuels ?? []).forEach((f, i) => {
    if (!f.fuelKey) {
      errors.push({ field: `fuels[${i}].fuelKey`, code: 'MISSING_FIELD', message: 'fuelKey required' });
    }
    for (const [field, value] of [['density', f.density], ['ncv', f.ncv]] as const) {
      if (value === undefined || value === null) continue;
      try {
        const frac = Fraction.from(value);
        if (frac.sign() < 0) {
          errors.push({
            field: `fuels[${i}].${field}`,
            code: 'NEGATIVE_OR_NON_FINITE',
            message: 'must be non-negative'
          });
        }
      } catch {
        errors.push({
          field: `fuels[${i}].${field}`,
          code: 'INVALID_VALUE',
          message: `not a finite decimal: ${String(value)}`
        });
      }
    }
  });

  input.factors.forEach((f, i) => {
    const prefix = `factors[${i}]`;
    if (!GASES.includes(f.gas)) {
      errors.push({ field: `${prefix}.gas`, code: 'INVALID_VALUE', message: `gas must be one of ${GASES.join('/')}` });
    }
    if (f.scope !== 1 && f.scope !== 2) {
      errors.push({ field: `${prefix}.scope`, code: 'INVALID_VALUE', message: 'scope must be 1 or 2' });
    }
    try {
      const frac = Fraction.from(f.value);
      if (frac.sign() < 0) {
        errors.push({ field: `${prefix}.value`, code: 'NEGATIVE_OR_NON_FINITE', message: 'factor must be non-negative' });
      }
    } catch {
      errors.push({
        field: `${prefix}.value`,
        code: 'NEGATIVE_OR_NON_FINITE',
        message: `not a finite non-negative decimal: ${String(f.value)}`
      });
    }
    try {
      parseFactorUnit(f.unit);
    } catch (e) {
      errors.push({ field: `${prefix}.unit`, code: 'UNKNOWN_UNIT', message: (e as Error).message });
    }
    if (!MONTH_RE.test(f.validFrom)) {
      errors.push({ field: `${prefix}.validFrom`, code: 'BAD_MONTH', message: 'expected YYYY-MM' });
    }
    if (!MONTH_RE.test(f.validTo)) {
      errors.push({ field: `${prefix}.validTo`, code: 'BAD_MONTH', message: 'expected YYYY-MM' });
    }
    if (MONTH_RE.test(f.validFrom) && MONTH_RE.test(f.validTo) && f.validFrom > f.validTo) {
      errors.push({
        field: `${prefix}.validFrom`,
        code: 'INVALID_VALUE',
        message: `validFrom ${f.validFrom} is after validTo ${f.validTo}`
      });
    }
    const key = `${f.fuelKey}|${f.gas}|${f.scope}|${f.validFrom}`;
    if (seen.has(key)) {
      errors.push({ field: `${prefix}`, code: 'DUPLICATE_KEY', message: `duplicate factor entry ${key}` });
    }
    seen.add(key);
  });

  // Overlap pre-check inside this publish payload (the GiST exclusion
  // constraint is the authoritative check against already-published rows).
  const groups = new Map<string, FactorInput[]>();
  for (const f of input.factors) {
    const key = `${f.fuelKey}|${f.gas}|${f.scope}`;
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  }
  for (const [key, arr] of groups) {
    const sorted = [...arr].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].validFrom <= sorted[i - 1].validTo) {
        errors.push({
          field: 'factors',
          code: 'FACTOR_PERIOD_OVERLAP',
          message: `overlapping applicability periods for ${key}: ${sorted[i - 1].validFrom}..${sorted[i - 1].validTo} and ${sorted[i].validFrom}..${sorted[i].validTo}`
        });
      }
    }
  }

  // CHP reference efficiencies: must be finite, strictly positive decimals.
  const seenEta = new Set<Carrier>();
  (input.referenceEfficiencies ?? []).forEach((e, i) => {
    const prefix = `referenceEfficiencies[${i}]`;
    if (!CARRIERS.includes(e.carrier)) {
      errors.push({ field: `${prefix}.carrier`, code: 'INVALID_VALUE', message: `carrier must be one of ${CARRIERS.join('/')}` });
      return;
    }
    if (seenEta.has(e.carrier)) {
      errors.push({ field: `${prefix}.carrier`, code: 'DUPLICATE_KEY', message: `duplicate reference efficiency for ${e.carrier}` });
    }
    seenEta.add(e.carrier);
    try {
      const frac = Fraction.from(e.eta);
      if (frac.sign() <= 0) {
        errors.push({ field: `${prefix}.eta`, code: 'INVALID_VALUE', message: 'reference efficiency must be strictly positive' });
      }
    } catch {
      errors.push({ field: `${prefix}.eta`, code: 'INVALID_VALUE', message: `not a finite positive decimal: ${String(e.eta)}` });
    }
  });
  return errors;
}

@Injectable()
export class FactorLibraryService {
  constructor(private readonly db: DbService) {}

  async publishVersion(input: PublishFactorVersionInput): Promise<FactorVersion> {
    if (!input.version) {
      throw new ValidationException([
        { field: 'version', code: 'MISSING_FIELD', message: 'version required' }
      ]);
    }
    const errors = validateFactorInput(input);
    if (errors.length) throw new ValidationException(errors);

    return this.db.withTransaction(async (client) => {
      const existing = await client.query<{ id: number }>(
        'SELECT id FROM factor_versions WHERE version = $1',
        [input.version]
      );
      if (existing.rows[0]) {
        throw new ConflictError('version', `factor version already exists: ${input.version}`);
      }
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO factor_versions(version, published_by, note)
         VALUES ($1, $2, $3) RETURNING id`,
        [input.version, input.publishedBy ?? null, input.note ?? null]
      );
      const versionId = inserted.rows[0].id;

      for (const fuel of input.fuels ?? []) {
        const density = fuel.density === undefined ? null : Fraction.from(fuel.density);
        const ncv = fuel.ncv === undefined ? null : Fraction.from(fuel.ncv);
        await client.query(
          `INSERT INTO fuel_properties(factor_version_id, fuel_key,
             density_num, density_den, ncv_num, ncv_den)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            versionId,
            fuel.fuelKey,
            density?.num ?? null,
            density?.den ?? null,
            ncv?.num ?? null,
            ncv?.den ?? null
          ]
        );
      }

      for (const e of input.referenceEfficiencies ?? []) {
        const eta = Fraction.from(e.eta);
        await client.query(
          `INSERT INTO chp_reference_efficiencies(factor_version_id, carrier, eta_num, eta_den)
           VALUES ($1, $2, $3, $4)`,
          [versionId, e.carrier, eta.num, eta.den]
        );
      }

      for (const f of input.factors) {        const value = Fraction.from(f.value);
        // Store the declared unit verbatim; kg normalization is derived.
        await client.query(
          `INSERT INTO emission_factors
             (factor_version_id, fuel_key, gas, scope, value_num, value_den,
              factor_unit, valid_from, valid_to)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            versionId,
            f.fuelKey,
            f.gas,
            f.scope,
            value.num,
            value.den,
            f.unit,
            monthToDate(f.validFrom),
            monthToDate(f.validTo)
          ]
        ).catch((e: { code?: string; constraint?: string }) => {
          if (e.constraint === 'emission_factors_no_overlap' || e.code === '23P01') {
            throw new ValidationException([
              {
                field: 'factors',
                code: 'FACTOR_PERIOD_OVERLAP',
                message: `applicability period overlaps an existing period for ${f.fuelKey}/${f.gas}/scope${f.scope}`
              }
            ]);
          }
          throw e;
        });
      }

      return { id: versionId, version: input.version, publishedAt: new Date() };
    });
  }

  async getVersion(version: string | number): Promise<FactorVersion> {
    return this.getVersionOn(this.db, version);
  }

  async getVersionOn(client: Queryer, version: string | number): Promise<FactorVersion> {
    const res = await client.query<{ id: number; version: string; published_at: Date }>(
      typeof version === 'number'
        ? 'SELECT id, version, published_at FROM factor_versions WHERE id = $1'
        : 'SELECT id, version, published_at FROM factor_versions WHERE version = $1',
      [version]
    );
    const r = res.rows[0];
    if (!r) throw new NotFoundError(`factor version not found: ${version}`);
    return { id: r.id, version: r.version, publishedAt: r.published_at };
  }

  async listVersions(): Promise<FactorVersion[]> {
    const res = await this.db.query<{ id: number; version: string; published_at: Date }>(
      'SELECT id, version, published_at FROM factor_versions ORDER BY id'
    );
    return res.rows.map((r) => ({ id: r.id, version: r.version, publishedAt: r.published_at }));
  }

  async getFuelProperties(
    client: Queryer,
    versionId: number
  ): Promise<Map<string, FuelProperty>> {
    const res = await client.query<{
      fuel_key: string;
      density_num: string | null;
      density_den: string | null;
      ncv_num: string | null;
      ncv_den: string | null;
    }>(
      `SELECT fuel_key, density_num, density_den, ncv_num, ncv_den
       FROM fuel_properties WHERE factor_version_id = $1`,
      [versionId]
    );
    const map = new Map<string, FuelProperty>();
    for (const r of res.rows) {
      map.set(r.fuel_key, {
        fuelKey: r.fuel_key,
        density: r.density_num !== null ? Fraction.of(BigInt(r.density_num), BigInt(r.density_den!)) : null,
        ncv: r.ncv_num !== null ? Fraction.of(BigInt(r.ncv_num), BigInt(r.ncv_den!)) : null
      });
    }
    return map;
  }

  /**
   * Reference allocation efficiencies of a version, merged over the built-in
   * defaults. The defaults are fixed constants (documented in the README),
   * so every carrier always resolves to exactly one positive Fraction and an
   * older version that published nothing is perfectly reproducible.
   */
  async getReferenceEfficiencies(
    client: Queryer,
    versionId: number
  ): Promise<Record<Carrier, Fraction>> {
    const res = await client.query<{
      carrier: Carrier;
      eta_num: string;
      eta_den: string;
    }>(
      `SELECT carrier, eta_num, eta_den
       FROM chp_reference_efficiencies WHERE factor_version_id = $1`,
      [versionId]
    );
    const out: Record<Carrier, Fraction> = {
      STEAM: DEFAULT_REFERENCE_EFFICIENCIES.STEAM,
      HOT_WATER: DEFAULT_REFERENCE_EFFICIENCIES.HOT_WATER,
      ELECTRICITY: DEFAULT_REFERENCE_EFFICIENCIES.ELECTRICITY
    };
    for (const r of res.rows) {
      out[r.carrier] = Fraction.of(BigInt(r.eta_num), BigInt(r.eta_den));
    }
    return out;
  }

  async getFactors(
    client: Queryer,
    versionId: number
  ): Promise<FactorRow[]> {    const res = await client.query<{
      id: number;
      fuel_key: string;
      gas: Gas;
      scope: number;
      value_num: string;
      value_den: string;
      factor_unit: string;
      valid_from: Date;
      valid_to: Date;
    }>(
      `SELECT id, fuel_key, gas, scope, value_num, value_den, factor_unit,
              valid_from, valid_to
       FROM emission_factors WHERE factor_version_id = $1`,
      [versionId]
    );
    return res.rows.map((r) => {
      const parsed = parseFactorUnit(r.factor_unit);
      const value = Fraction.of(BigInt(r.value_num), BigInt(r.value_den));
      return {
        id: r.id,
        fuelKey: r.fuel_key,
        gas: r.gas,
        scope: r.scope as 1 | 2,
        value,
        tonnesPerActivityUnit: value.mul(factorNumeratorToTonnes(parsed.numerator)),
        activityUnit: parsed.denominator,
        factorUnit: r.factor_unit,
        validFrom: monthFromDate(r.valid_from),
        validTo: monthFromDate(r.valid_to)
      };
    });
  }
}

@Module({
  imports: [DbModule],
  providers: [FactorLibraryService],
  exports: [FactorLibraryService]
})
export class FactorLibraryModule {}
