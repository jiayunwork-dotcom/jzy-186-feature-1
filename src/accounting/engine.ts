import { Fraction } from '../common/fraction';
import { convert, type FuelProps } from '../units/units.service';
import type { Gas } from '../factor-library/factor-library.service';
import type { FactorRow } from '../factor-library/factor-library.service';
import type { ActivityRecord } from '../activity-data/activity-data.service';
import { NotFoundError } from '../common/errors';

/**
 * A "口径" (caliber) is the triple that fully determines every number:
 *  - activity data cut (as_of timestamp)
 *  - factor library version
 *  - GWP set
 * Internally versions are resolved to numeric ids before calculation.
 */
export interface Caliber {
  cutId: number;
  factorVersionId: number;
  gwpSetId: number;
}

export interface LeafLineItem {
  siteCode: string;
  sourceCode: string;
  month: string; // YYYY-MM
  scope: 1 | 2;
  recordNo: string;
  factorId: number;
  gas: Gas;
  /** activity quantity expressed in the factor's activity unit */
  activityQty: Fraction;
  /** tonnes of this gas emitted by this record */
  gasTonnes: Fraction;
  /** tonnes CO2e contributed by this record/gas (gasTonnes * GWP) */
  co2eTonnes: Fraction;
}

/** Per record, one item per gas. The three gases always travel together. */
export interface RecordLeaf {
  kind: 'direct';
  category: 'DIRECT';
  siteCode: string;
  sourceCode: string;
  month: string;
  scope: 1 | 2;
  recordNo: string;
  fuelKey: string;
  unit: string;
  quantity: Fraction;
  /**
   * Facility this record is an input of (null = terminal direct record, the
   * pre-transfer behaviour). Facility-bound records are NOT direct leaves:
   * their emissions travel through the transfer allocation.
   */
  facilityCode: string | null;
  byGas: Record<
    Gas,
    {
      factorId: number;
      factor: FactorRow;
      activityQty: Fraction;
      gasTonnes: Fraction;
      co2eTonnes: Fraction;
    }
  >;
}

/**
 * Scope-2 leaf produced by the internal-transfer allocation: energy arriving
 * at a site via an internal transfer, expressed per gas with its exact origin
 * decomposition. `sourceCode` names the receiving use point (TRANSFER:<point>)
 * so it can never collide with a purchased-energy source; `category`
 * separates it from ordinary (external) scope 2 in every roll-up.
 */
export interface TransferLeaf {
  kind: 'transfer';
  category: 'TRANSFER';
  siteCode: string;
  sourceCode: string;
  month: string;
  scope: 2;
  gas: Gas;
  gasTonnes: Fraction;
  co2eTonnes: Fraction;
  edge: {
    recordNo: string;
    fromFacility: string;
    toSite: string;
    toUsePoint: string;
    carrier: string;
    quantity: Fraction;
    /** receiver point feeds another facility (internal edge) or null = final use */
    toFacility: string | null;
    /** exact allocation coefficient p_fc × q/Q_fc on this edge */
    coefficient: Fraction;
  };
  origins: Array<{
    recordNo: string;
    facility: string;
    factorId: number;
    share: Fraction;
    gasTonnes: Fraction;
  }>;
}

export type AccountingLeaf = RecordLeaf | TransferLeaf;

/** Category of a scope-2 row; DIRECT is the pre-existing external energy. */
export type LeafCategory = 'DIRECT' | 'TRANSFER';

export function leafCategory(leaf: AccountingLeaf): LeafCategory {
  return leaf.kind === 'transfer' ? 'TRANSFER' : 'DIRECT';
}

export interface FactorIndex {
  rows: FactorRow[];
  props: Map<string, { density: Fraction | null; ncv: Fraction | null }>;
  gwp: Record<Gas, Fraction>;
}

/** Select the single applicable factor for (fuel, gas, scope, month). */
export function selectFactor(
  rows: FactorRow[],
  fuelKey: string,
  gas: Gas,
  scope: 1 | 2,
  month: string
): FactorRow {
  const matches = rows.filter(
    (f) => f.fuelKey === fuelKey && f.gas === gas && f.scope === scope && f.validFrom <= month && month <= f.validTo
  );
  if (matches.length === 0) {
    throw new NotFoundError(
      `no applicable ${gas} factor for ${fuelKey} scope ${scope} in month ${month}`
    );
  }
  // Publication rejects overlapping periods, so at most one row reaches here.
  return matches[0];
}

function fuelPropsFor(
  props: FactorIndex['props'],
  fuelKey: string
): FuelProps | undefined {
  const p = props.get(fuelKey);
  if (!p) return undefined;
  return { density: p.density ?? undefined, ncvMass: p.ncv ?? undefined };
}

/**
 * Evaluate one effective activity record under one factor index.
 * Pure function — no I/O, exact rationals throughout.
 */
export function evaluateRecord(record: ActivityRecord, idx: FactorIndex): RecordLeaf {
  const props = fuelPropsFor(idx.props, record.fuelKey);
  const byGas = {} as RecordLeaf['byGas'];
  for (const gas of ['CO2', 'CH4', 'N2O'] as Gas[]) {
    const factor = selectFactor(idx.rows, record.fuelKey, gas, record.scope, record.month);
    // Quantity in the factor's activity unit (exact; e.g. L -> GJ via NCV).
    const activityQty = convert(record.quantityFraction, record.unit, factor.activityUnit, props);
    const gasTonnes = activityQty.mul(factor.tonnesPerActivityUnit);
    const co2eTonnes = gasTonnes.mul(idx.gwp[gas]);
    byGas[gas] = { factorId: factor.id, factor, activityQty, gasTonnes, co2eTonnes };
  }
  return {
    kind: 'direct',
    category: 'DIRECT',
    siteCode: record.siteCode,
    sourceCode: record.sourceCode,
    month: record.month,
    scope: record.scope,
    recordNo: record.recordNo,
    fuelKey: record.fuelKey,
    unit: record.unit,
    quantity: record.quantityFraction,
    facilityCode: record.facilityCode ?? null,
    byGas
  };
}

export function evaluateAll(records: ActivityRecord[], idx: FactorIndex): RecordLeaf[] {
  // Sorted by record number: summation order is then fixed and deterministic.
  return records
    .map((r) => evaluateRecord(r, idx))
    .sort((a, b) => (a.recordNo < b.recordNo ? -1 : a.recordNo > b.recordNo ? 1 : 0));
}

export function flattenLeaves(leaves: RecordLeaf[]): LeafLineItem[] {
  const out: LeafLineItem[] = [];
  for (const leaf of leaves) {
    for (const gas of ['CO2', 'CH4', 'N2O'] as Gas[]) {
      const g = leaf.byGas[gas];
      out.push({
        siteCode: leaf.siteCode,
        sourceCode: leaf.sourceCode,
        month: leaf.month,
        scope: leaf.scope,
        recordNo: leaf.recordNo,
        factorId: g.factorId,
        gas,
        activityQty: g.activityQty,
        gasTonnes: g.gasTonnes,
        co2eTonnes: g.co2eTonnes
      });
    }
  }
  out.sort((a, b) => {
    const ka = `${a.siteCode}|${a.sourceCode}|${a.month}|${a.scope}|${a.recordNo}|${a.gas}`;
    const kb = `${b.siteCode}|${b.sourceCode}|${b.month}|${b.scope}|${b.recordNo}|${b.gas}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export type DimensionKey = 'site' | 'source' | 'month';

export interface GasTotals {
  CO2: Fraction;
  CH4: Fraction;
  N2O: Fraction;
  CO2E: Fraction;
}

export interface AggregateRow {
  siteCode: string | null;
  sourceCode: string | null;
  month: string | null;
  scope: 1 | 2;
  /** DIRECT = ordinary activity record; TRANSFER = internal energy received. */
  category: LeafCategory;
  totals: GasTotals;
}

export interface AggregateQuery {
  /** Dimensions to break totals down by. [] => a single grand-total row. */
  groupBy?: DimensionKey[];
  /** Filters (null/undefined = no filter on that dimension). */
  siteCode?: string | null;
  sourceCode?: string | null;
  month?: string | null;
  scope?: 1 | 2 | null;
  /** Restrict to direct external energy vs internal transfers. */
  category?: LeafCategory | null;
}

function zeroTotals(): GasTotals {
  return { CO2: Fraction.ZERO, CH4: Fraction.ZERO, N2O: Fraction.ZERO, CO2E: Fraction.ZERO };
}

function rowMatches(leaf: AccountingLeaf, query: AggregateQuery): boolean {
  if (query.siteCode && leaf.siteCode !== query.siteCode) return false;
  if (query.sourceCode && leaf.sourceCode !== query.sourceCode) return false;
  if (query.month && leaf.month !== query.month) return false;
  if (query.scope && leaf.scope !== query.scope) return false;
  if (query.category && leafCategory(leaf) !== query.category) return false;
  return true;
}

/** Per-gas contributions of one leaf to an accumulator. */
function addLeafToTotals(t: GasTotals, leaf: AccountingLeaf): void {
  if (leaf.kind === 'transfer') {
    t[leaf.gas] = t[leaf.gas].add(leaf.gasTonnes);
    t.CO2E = t.CO2E.add(leaf.co2eTonnes);
    return;
  }
  for (const gas of ['CO2', 'CH4', 'N2O'] as Gas[]) {
    t[gas] = t[gas].add(leaf.byGas[gas].gasTonnes);
    t.CO2E = t.CO2E.add(leaf.byGas[gas].co2eTonnes);
  }
}

/**
 * Aggregate evaluated leaves.
 *
 * `groupBy` names the breakdown dimensions; scope and category are always
 * breakdown columns (scope 1/2 and DIRECT/TRANSFER must never be silently
 * merged). Rows are returned sorted by every dimension and each gas is
 * accumulated in fixed record-no order, so repeated runs yield bit-identical
 * rationals. With zero transfer data every leaf is DIRECT and the rows are
 * exactly the pre-transfer ones.
 */
export function aggregate(leaves: AccountingLeaf[], query: AggregateQuery = {}): AggregateRow[] {
  const groupBy = new Set<DimensionKey>(query.groupBy ?? ['site', 'source', 'month']);
  interface Group {
    siteCode: string | null;
    sourceCode: string | null;
    month: string | null;
    scope: 1 | 2;
    category: LeafCategory;
    totals: GasTotals;
  }
  const groups = new Map<string, Group>();

  for (const leaf of leaves) {
    if (!rowMatches(leaf, query)) continue;
    const siteCode = groupBy.has('site') ? leaf.siteCode : null;
    const sourceCode = groupBy.has('source') ? leaf.sourceCode : null;
    const month = groupBy.has('month') ? leaf.month : null;
    const category = leafCategory(leaf);
    const key = JSON.stringify([siteCode, sourceCode, month, leaf.scope, category]);
    let g = groups.get(key);
    if (!g) {
      g = { siteCode, sourceCode, month, scope: leaf.scope, category, totals: zeroTotals() };
      groups.set(key, g);
    }
    addLeafToTotals(g.totals, leaf);
  }

  return [...groups.values()].sort((a, b) => {
    return (
      (a.siteCode ?? '').localeCompare(b.siteCode ?? '') ||
      (a.sourceCode ?? '').localeCompare(b.sourceCode ?? '') ||
      (a.month ?? '').localeCompare(b.month ?? '') ||
      a.scope - b.scope ||
      a.category.localeCompare(b.category)
    );
  });
}

/** Total over a filter (the grand-total cell used by restatement checks). */
export function grandTotal(leaves: AccountingLeaf[], query: AggregateQuery = {}): GasTotals {
  const t = zeroTotals();
  for (const leaf of leaves) {
    if (!rowMatches(leaf, query)) continue;
    addLeafToTotals(t, leaf);
  }
  return t;
}
