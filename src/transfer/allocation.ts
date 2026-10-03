import { Fraction } from '../common/fraction';
import { GASES, type Gas } from '../factor-library/factor-library.service';
import { TransferNetworkError } from '../common/errors';

/**
 * Exact internal-transfer allocation (pure functions).
 *
 * Allocation rule (decided in README §9.2): *reference-efficiency allocation*
 * (GHG Protocol / ISO 14064-1 / IEA CHP method). A facility f producing
 * carriers c with energy Q_fc splits its responsibility between products with
 *
 *   w_fc = Q_fc / eta_c            (eta_c = carrier reference efficiency)
 *   p_fc = w_fc / sum_c' w_fc'
 *
 * - heat users carry the heat reference-efficiency share (eta_steam typically
 *   ~0.9), electricity users the (lower) power reference-efficiency share
 *   (eta_elec ~0.4): each product is charged as if it came from a stand-alone
 *   reference unit. This is the standard compromise between energy-content
 *   allocation (favours electricity, punishes heat) and exergy/work allocation
 *   (favours heat).
 * - eta_c is published *with the factor version* (carrier_efficiencies), so
 *   updating it is a factor change and lands in the factor component of a
 *   restatement; the denominator is never silently swapped at run time.
 *
 * Network rule (months are independent): every transfer edge f -> point
 * (possibly feeding another facility) carries the per-product fraction p_fc
 * of *all* responsibility currently embodied at f. With E_f the embodied
 * responsibility at f and D_f the emissions of f's own inputs:
 *
 *   E_f = D_f + sum_in e_in
 *   e_(f->g,c) = E_f * p_fc
 *
 * hence E = D + M E, i.e. (I - M) E = D with
 * M_fg = sum_c p_fc * in_fgc / Q_gc for facility-feeding edges. M is
 * non-negative with column sums <= 1; it is substochastic and (I-M) is
 * invertible exactly when every facility can reach a final-use sink.
 * Otherwise the culprits are named explicitly (TRANSFER_NETWORK_NO_FINAL_USE):
 * no infinite loop, no division by zero.
 *
 * Every quantity is a reduced Fraction; the linear system is solved by
 * Gauss-Jordan elimination with deterministic pivoting, so results are exact
 * rationals, bit-identical on repeated queries, and independent of summation
 * order.
 */

export type GasMass = Record<Gas, Fraction>;

export interface OutputQty {
  facility: string;
  carrier: string;
  /** energy in canonical unit GJ */
  quantity: Fraction;
  recordNo: string;
}

export interface TransferEdge {
  recordNo: string;
  facility: string;
  carrier: string;
  quantity: Fraction; // GJ
  toSite: string;
  toUsePoint: string;
  /** facility fed by the destination point, or null = final use at the site */
  toFacility: string | null;
}

export interface DirectEmission {
  recordNo: string;
  facility: string;
  siteCode: string;
  sourceCode: string;
  month: string;
  scope: 1 | 2;
  byGas: Record<Gas, { factorId: number; gasTonnes: Fraction }>;
}

export interface MonthNetworkInput {
  month: string;
  outputs: OutputQty[];
  transfers: TransferEdge[];
  /** emissions originating on facility-linked sources in this month */
  direct: DirectEmission[];
  carrierEta: Map<string, Fraction>;
}

export interface EdgeOrigin {
  recordNo: string;
  facility: string;
  factorId: number;
  /** exact fraction of the origin record's gas mass carried by the edge */
  share: Fraction;
  gasTonnes: Fraction;
}

/** One transfer edge with its per-gas allocated mass and origin breakdown. */
export interface AllocatedTransferEdge {
  month: string;
  scope: 2;
  /** receiver site where this scope-2 transferred energy is accounted */
  siteCode: string;
  usePoint: string;
  edge: {
    recordNo: string;
    fromFacility: string;
    toSite: string;
    toUsePoint: string;
    carrier: string;
    quantity: Fraction;
    /** destination feeds another facility (internal edge) or null = final use */
    toFacility: string | null;
    /** exact allocation coefficient of this edge: p_fc × q/Q_fc */
    coefficient: Fraction;
  };
  perGas: Record<Gas, { gasTonnes: Fraction; origins: EdgeOrigin[] }>;
}

export interface AllocationResult {
  month: string;
  facilities: string[];
  edges: AllocatedTransferEdge[];
  /** Responsibility embodied at each facility (E_f), per gas. */
  embodied: Map<string, GasMass>;
  /** Retained (producer-site self use) responsibility per facility/carrier. */
  retained: Map<string, Map<string, GasMass>>;
  /**
   * Received internal energy finally consumed *at* this facility (an
   * internal-edge endpoint that uses the energy in its own site rather than
   * re-shipping it). Keyed by receiver facility; conservation is
   * D_total = edges (to points) + retained production + retained inflows.
   */
  retainedInflows: Map<string, GasMass>;
  /** Exact inverse of (I - M): inverse[g][f] is g's embodied share of f's D. */
  inverse: Map<string, Map<string, Fraction>>;
  /** Product allocation proportions p_fc per (facility, carrier). */
  productShare: Map<string, Map<string, Fraction>>;
  internalEdges: TransferEdge[];
  sinkEdges: TransferEdge[];
  directByFacility: Map<string, DirectEmission[]>;
}

function zeroGas(): GasMass {
  return { CO2: Fraction.ZERO, CH4: Fraction.ZERO, N2O: Fraction.ZERO };
}

export function addGas(a: GasMass, b: GasMass): GasMass {
  return { CO2: a.CO2.add(b.CO2), CH4: a.CH4.add(b.CH4), N2O: a.N2O.add(b.N2O) };
}

export function mulGas(a: GasMass, k: Fraction): GasMass {
  return { CO2: a.CO2.mul(k), CH4: a.CH4.mul(k), N2O: a.N2O.mul(k) };
}

// ---------------------------------------------------------------------------
// Exact dense linear algebra (bigint rationals)
// ---------------------------------------------------------------------------

type Matrix = Fraction[][];

function identityMatrix(n: number): Matrix {
  const m: Matrix = [];
  for (let i = 0; i < n; i++) {
    const row: Fraction[] = new Array(n).fill(Fraction.ZERO);
    row[i] = Fraction.ONE;
    m.push(row);
  }
  return m;
}

/**
 * Invert A exactly by Gauss-Jordan. Pivot choice is deterministic (first
 * non-zero column entry at or below the pivot row, in fixed facility order).
 * Throws TransferNetworkError on singularity — the reachability check by the
 * caller normally prevents that, this is the no-divide-by-zero guard.
 */
export function invertMatrix(A: Matrix, labels: string[]): Matrix {
  const n = A.length;
  const m: Matrix = A.map((row) => row.slice());
  const inv = identityMatrix(n);

  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let row = col; row < n; row++) {
      if (m[row][col].sign() !== 0) {
        pivot = row;
        break;
      }
    }
    if (pivot < 0) {
      throw new TransferNetworkError(
        'TRANSFER_NETWORK_NO_FINAL_USE',
        `singular transfer allocation: facilities ${labels.join(', ')} are trapped in a closed loop with no final use`,
        [
          {
            field: 'facilities',
            code: 'TRANSFER_NETWORK_NO_FINAL_USE',
            message: `facilities ${labels.join(', ')} form a closed loop with no final use`
          }
        ],
        labels
      );
    }
    if (pivot !== col) {
      [m[col], m[pivot]] = [m[pivot], m[col]];
      [inv[col], inv[pivot]] = [inv[pivot], inv[col]];
    }
    const pv = m[col][col];
    for (let j = 0; j < n; j++) {
      m[col][j] = m[col][j].div(pv);
      inv[col][j] = inv[col][j].div(pv);
    }
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row][col];
      if (factor.sign() === 0) continue;
      for (let j = 0; j < n; j++) {
        m[row][j] = m[row][j].sub(factor.mul(m[col][j]));
        inv[row][j] = inv[row][j].sub(factor.mul(inv[col][j]));
      }
    }
  }
  return inv;
}

// ---------------------------------------------------------------------------
// Monthly allocation
// ---------------------------------------------------------------------------

export function allocateMonth(input: MonthNetworkInput): AllocationResult {
  const { outputs, transfers, direct } = input;

  const facilitySet = new Set<string>();
  outputs.forEach((o) => facilitySet.add(o.facility));
  transfers.forEach((t) => {
    facilitySet.add(t.facility);
    if (t.toFacility) facilitySet.add(t.toFacility);
  });
  direct.forEach((d) => facilitySet.add(d.facility));
  const facilities = [...facilitySet].sort();

  // 1) Production sums Q_fc (GJ).
  const Q = new Map<string, Map<string, Fraction>>();
  for (const o of outputs) {
    let m = Q.get(o.facility);
    if (!m) {
      m = new Map();
      Q.set(o.facility, m);
    }
    m.set(o.carrier, (m.get(o.carrier) ?? Fraction.ZERO).add(o.quantity));
  }

  // 2) Product shares p_fc = (Q_fc/eta_c) / sum.
  const productShare = new Map<string, Map<string, Fraction>>();
  for (const f of facilities) {
    const qm = Q.get(f);
    if (!qm || qm.size === 0) continue;
    const weighted = new Map<string, Fraction>();
    let totalWeight = Fraction.ZERO;
    for (const [carrier, q] of qm) {
      const eta = input.carrierEta.get(carrier);
      if (!eta) {
        throw new TransferNetworkError(
          'CARRIER_EFFICIENCY_MISSING',
          `factor version has no reference efficiency for carrier ${carrier} (facility ${f}, month ${input.month})`,
          [
            {
              field: 'carrier',
              code: 'CARRIER_EFFICIENCY_MISSING',
              message: `missing reference efficiency for carrier ${carrier} in this factor version`
            }
          ]
        );
      }
      const w = q.div(eta);
      weighted.set(carrier, w);
      totalWeight = totalWeight.add(w);
    }
    const shares = new Map<string, Fraction>();
    for (const [carrier, w] of weighted) shares.set(carrier, w.div(totalWeight));
    productShare.set(f, shares);
  }

  // 3) Sent sums and the never-exceed-production checks.
  const sent = new Map<string, Map<string, Fraction>>();
  for (const t of transfers) {
    let m = sent.get(t.facility);
    if (!m) {
      m = new Map();
      sent.set(t.facility, m);
    }
    m.set(t.carrier, (m.get(t.carrier) ?? Fraction.ZERO).add(t.quantity));
  }
  for (const [f, byCarrier] of sent) {
    const qm = Q.get(f);
    for (const [carrier, total] of byCarrier) {
      const produced = qm?.get(carrier);
      if (!produced || produced.sign() === 0) {
        throw new TransferNetworkError(
          'TRANSFER_WITHOUT_OUTPUT',
          `${f} transfers ${carrier} in ${input.month} but has no effective output of that carrier`,
          [
            {
              field: 'carrier',
              code: 'TRANSFER_WITHOUT_OUTPUT',
              message: `transfer exists but no output record for ${f}/${carrier} in ${input.month}`
            }
          ]
        );
      }
      if (total.compare(produced) > 0) {
        throw new TransferNetworkError(
          'TRANSFER_EXCEEDS_OUTPUT',
          `${f}: transfers of ${carrier} (${total.toDecimalString(6)} GJ) exceed output (${produced.toDecimalString(6)} GJ) in ${input.month}`,
          [
            {
              field: 'quantity',
              code: 'TRANSFER_EXCEEDS_OUTPUT',
              message: `sum of transfers ${total.toDecimalString(6)} GJ > output ${produced.toDecimalString(6)} GJ for ${f}/${carrier} in ${input.month}`
            }
          ]
        );
      }
    }
  }

  // 4) Reachability of a final-use sink. A facility is a sink source when it
  //    (a) hands energy to a point feeding no facility, or (b) retains some
  //    produced energy (sent < produced). Reverse BFS then marks every
  //    facility that can eventually reach one. Anything left unmarked only
  //    circulates — name it.
  const outgoing = new Map<string, TransferEdge[]>();
  for (const t of transfers) {
    const arr = outgoing.get(t.facility) ?? [];
    arr.push(t);
    outgoing.set(t.facility, arr);
  }
  const canReachSink = new Set<string>();
  const queue: string[] = [];
  for (const f of facilities) {
    const edges = outgoing.get(f) ?? [];
    const hasSinkEdge = edges.some((e) => e.toFacility === null);
    let hasRetained = false;
    for (const [carrier, produced] of Q.get(f) ?? []) {
      const s = sent.get(f)?.get(carrier) ?? Fraction.ZERO;
      if (s.compare(produced) < 0) {
        hasRetained = true;
        break;
      }
    }
    if (hasSinkEdge || hasRetained) {
      canReachSink.add(f);
      queue.push(f);
    }
  }
  const incomingTo = new Map<string, string[]>();
  for (const t of transfers) {
    if (!t.toFacility) continue;
    const arr = incomingTo.get(t.toFacility) ?? [];
    arr.push(t.facility);
    incomingTo.set(t.toFacility, arr);
  }
  while (queue.length) {
    const g = queue.shift()!;
    for (const f of incomingTo.get(g) ?? []) {
      if (!canReachSink.has(f)) {
        canReachSink.add(f);
        queue.push(f);
      }
    }
  }
  const trapped = facilities.filter((f) => !canReachSink.has(f));
  if (trapped.length) {
    throw new TransferNetworkError(
      'TRANSFER_NETWORK_NO_FINAL_USE',
      `closed transfer loop with no final use in ${input.month}: all output of facilities ${trapped.join(', ')} circulates and nothing is finally consumed`,
      [
        {
          field: 'facilities',
          code: 'TRANSFER_NETWORK_NO_FINAL_USE',
          message: `facilities ${trapped.join(', ')} form a closed loop with no final use in ${input.month}`
        }
      ],
      trapped
    );
  }

  // 5) System matrix for E_to = D_to + sum_from flow E_from. The fraction of
  //    the *sender's* embodied responsibility leaving on an internal edge is
  //    p_from,c * (q / Q_from,c), so M[to][from] += that coefficient.
  const n = facilities.length;
  const index = new Map(facilities.map((f, i) => [f, i]));
  const M: Matrix = Array.from({ length: n }, () => new Array(n).fill(Fraction.ZERO));
  const internalEdges: TransferEdge[] = [];
  const sinkEdges: TransferEdge[] = [];
  for (const t of transfers) {
    if (t.toFacility) internalEdges.push(t);
    else sinkEdges.push(t);
    if (t.toFacility) {
      const pf = productShare.get(t.facility)?.get(t.carrier);
      const qf = Q.get(t.facility)?.get(t.carrier);
      if (pf && qf && qf.sign() > 0) {
        M[index.get(t.toFacility)!][index.get(t.facility)!] = M[index.get(t.toFacility)!][
          index.get(t.facility)!
        ].add(pf.mul(t.quantity).div(qf));
      }
    }
  }

  // 6) (I - M) E = D, invert exactly: E_g = sum_f inv[g][f] D_f.
  const A: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i === j ? Fraction.ONE.sub(M[i][j]) : M[i][j].neg()
    )
  );
  const inv = invertMatrix(A, facilities);
  const inverse = new Map<string, Map<string, Fraction>>();
  facilities.forEach((g, gi) => {
    const row = new Map<string, Fraction>();
    facilities.forEach((f, fi) => row.set(f, inv[gi][fi]));
    inverse.set(g, row);
  });

  // 7) Direct emissions D_f and embodied E_f = sum_f inverse[g][f] D_f.
  const directByFacility = new Map<string, DirectEmission[]>();
  for (const d of direct) {
    const arr = directByFacility.get(d.facility) ?? [];
    arr.push(d);
    directByFacility.set(d.facility, arr);
  }
  const D = new Map<string, GasMass>();
  for (const f of facilities) {
    let acc = zeroGas();
    for (const d of directByFacility.get(f) ?? []) {
      acc = addGas(acc, {
        CO2: d.byGas.CO2.gasTonnes,
        CH4: d.byGas.CH4.gasTonnes,
        N2O: d.byGas.N2O.gasTonnes
      });
    }
    D.set(f, acc);
  }
  const embodied = new Map<string, GasMass>();
  for (const g of facilities) {
    let acc = zeroGas();
    for (const f of facilities) {
      acc = addGas(acc, mulGas(D.get(f)!, inverse.get(g)!.get(f)!));
    }
    embodied.set(g, acc);
  }

  // 8) Allocate every edge per gas. Edge f -> point of carrier c carrying
  //    energy q carries E_f * p_fc * (q / Q_fc); its origin decomposition is
  //    that coefficient times inverse[f][u] for each direct record at u.
  const edges: AllocatedTransferEdge[] = [];
  for (const t of transfers) {
    const pf = productShare.get(t.facility)?.get(t.carrier) ?? Fraction.ZERO;
    const produced = Q.get(t.facility)?.get(t.carrier) ?? Fraction.ZERO;
    const edgeFraction = produced.sign() === 0 ? Fraction.ZERO : t.quantity.div(produced);
    const edgeCoefficient = pf.mul(edgeFraction);
    const Ef = embodied.get(t.facility)!;
    const perGas = {} as AllocatedTransferEdge['perGas'];
    for (const gas of GASES) {
      const origins: EdgeOrigin[] = [];
      for (const u of facilities) {
        const shareBase = edgeCoefficient.mul(inverse.get(t.facility)!.get(u)!);
        const ds = (directByFacility.get(u) ?? [])
          .filter((d) => d.byGas[gas].gasTonnes.sign() !== 0)
          .sort((a, b) => a.recordNo.localeCompare(b.recordNo));
        for (const d of ds) {
          origins.push({
            recordNo: d.recordNo,
            facility: u,
            factorId: d.byGas[gas].factorId,
            share: shareBase,
            gasTonnes: d.byGas[gas].gasTonnes.mul(shareBase)
          });
        }
      }
      origins.sort((a, b) =>
        a.recordNo.localeCompare(b.recordNo) || a.facility.localeCompare(b.facility)
      );
      perGas[gas] = { gasTonnes: Ef[gas].mul(edgeCoefficient), origins };
    }
    edges.push({
      month: input.month,
      scope: 2,
      siteCode: t.toSite,
      usePoint: t.toUsePoint,
      edge: {
        recordNo: t.recordNo,
        fromFacility: t.facility,
        toSite: t.toSite,
        toUsePoint: t.toUsePoint,
        carrier: t.carrier,
        quantity: t.quantity,
        toFacility: t.toFacility,
        coefficient: edgeCoefficient
      },
      perGas
    });
  }
  edges.sort((a, b) => a.edge.recordNo.localeCompare(b.edge.recordNo));

  // Retained production per facility/carrier: the embodied mass of output the
  // producer keeps and consumes on its own site:
  //   E_f * p_fc * (Q_fc - sent_fc)/Q_fc.
  const retained = new Map<string, Map<string, GasMass>>();
  for (const f of facilities) {
    const byCarrier = new Map<string, GasMass>();
    const Ef = embodied.get(f)!;
    for (const [carrier, p] of productShare.get(f) ?? []) {
      const produced = Q.get(f)!.get(carrier)!;
      const s = sent.get(f)?.get(carrier) ?? Fraction.ZERO;
      const retainedEnergyFraction = produced.sub(s).div(produced);
      byCarrier.set(carrier, mulGas(Ef, p.mul(retainedEnergyFraction)));
    }
    retained.set(f, byCarrier);
  }

  // Final-use accounting is exact by construction:
  //   sum_f D_f = sum_sinkEdges edgeMass + sum_f,c retainedProduction.
  // Internal (facility-to-facility) edges are intermediate flows and are not
  // final use: their mass is either converted and re-shipped, finally
  // delivered on a later sink edge, or retained by the receiving facility —
  // every case already appears in a sink edge or in retained production, so
  // counting internal edges here would double count the ring.
  const retainedInflows = new Map<string, GasMass>();
  for (const g of facilities) {
    // Informational: internal energy consumed at g itself (not re-shipped).
    // Derived per carrier as incoming-internal-c minus outgoing-c; negative
    // values simply mean g is a net producer of that carrier, so clamp at 0.
    const incoming = new Map<string, GasMass>();
    const outgoing = new Map<string, GasMass>();
    const add = (map: Map<string, GasMass>, c: string, m: GasMass) =>
      map.set(c, addGas(map.get(c) ?? zeroGas(), m));
    for (const e of edges) {
      const m = {
        CO2: e.perGas.CO2.gasTonnes,
        CH4: e.perGas.CH4.gasTonnes,
        N2O: e.perGas.N2O.gasTonnes
      };
      if (e.edge.toFacility === g) add(incoming, e.edge.carrier, m);
      if (e.edge.fromFacility === g) add(outgoing, e.edge.carrier, m);
    }
    let acc = zeroGas();
    for (const [c, mi] of incoming) {
      const mo = outgoing.get(c) ?? zeroGas();
      acc = addGas(acc, {
        CO2: mi.CO2.sub(mo.CO2).sign() > 0 ? mi.CO2.sub(mo.CO2) : Fraction.ZERO,
        CH4: mi.CH4.sub(mo.CH4).sign() > 0 ? mi.CH4.sub(mo.CH4) : Fraction.ZERO,
        N2O: mi.N2O.sub(mo.N2O).sign() > 0 ? mi.N2O.sub(mo.N2O) : Fraction.ZERO
      });
    }
    retainedInflows.set(g, acc);
  }

  return {
    month: input.month,
    facilities,
    edges,
    embodied,
    retained,
    retainedInflows,
    inverse,
    productShare,
    internalEdges,
    sinkEdges,
    directByFacility
  };
}

/**
 * Exact conservation identity (used by tests/audits). Internal
 * facility-to-facility edges are intermediate flows; only edges terminating
 * at final-use points plus retained production are final consumption:
 *
 *   sum_f D_f[gas] = sum_sinkEdges edgeMass[gas]
 *                    + sum_f,c retainedProduction[gas].
 *
 * This stays exact on rings because the recirculating mass never leaves the
 * internal-edge set until a sink edge or retained share absorbs it.
 */
export function conservationCheck(
  result: AllocationResult,
  input: MonthNetworkInput
): Record<Gas, { input: Fraction; outputs: Fraction }> {
  const out = {} as Record<Gas, { input: Fraction; outputs: Fraction }>;
  const sinkRecordNos = new Set(result.sinkEdges.map((e) => e.recordNo));
  for (const gas of GASES) {
    let inputMass = Fraction.ZERO;
    for (const d of input.direct) inputMass = inputMass.add(d.byGas[gas].gasTonnes);
    let sinkMass = Fraction.ZERO;
    for (const e of result.edges) {
      if (sinkRecordNos.has(e.edge.recordNo)) sinkMass = sinkMass.add(e.perGas[gas].gasTonnes);
    }
    let retainedMass = Fraction.ZERO;
    for (const [, byCarrier] of result.retained) {
      for (const [, m] of byCarrier) retainedMass = retainedMass.add(m[gas]);
    }
    out[gas] = { input: inputMass, outputs: sinkMass.add(retainedMass) };
  }
  return out;
}
