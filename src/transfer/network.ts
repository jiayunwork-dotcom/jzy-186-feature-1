import { Fraction } from '../common/fraction';
import { NetworkStructureError } from '../common/errors';
import { GASES, type Carrier, type Gas } from '../factor-library/factor-library.service';

/**
 * Exact allocation & propagation of emissions over the internal
 * energy-transfer network (内部转供网络).
 *
 * Everything in this file is a pure function over Fraction rationals; there
 * is no I/O, no floating point and no iteration to convergence. The network
 * for one month is a linear system solved once per gas by Gauss–Jordan
 * elimination over exact rationals, so the results are exact (no residual,
 * no approximation), deterministic and bit-identical on repeated queries.
 *
 * ---------------------------------------------------------------------------
 * Model (per month, per gas)
 * ---------------------------------------------------------------------------
 *
 * Each facility f has:
 *  - primary input emissions P_f: fuel combustion / purchased electricity
 *    evaluated against the factor library, summed over its emission sources;
 *  - outputs q_{f,c} (GJ) per carrier c, weighted for allocation by
 *    w_{f,c} = q_{f,c} / eta_c  (reference-efficiency / "physical content"
 *    allocation, see below);
 *  - transfers to delivery points. A point is either bound to a receiving
 *    facility g (energy re-enters g's pool) or final use (embedded emissions
 *    settle at the receiving site as scope 2).
 *
 * Let T_f be the total emission pool (tonnes of this gas) entering f's
 * allocation: its own primary inputs plus emissions embedded in energy
 * received from other facilities:
 *
 *     T_f = P_f + Σ_{e: into f} (share_e · T_{src(e)})
 *
 * where share_e = (q_e/eta_{c(e)}) / (Σ_{c'} w_{src,c'}) is the fraction of
 * the sender's pool carried by transfer e. With B_{g,f} = Σ transfers
 * f→(point at g) share_e:
 *
 *     T = P + B · T        ⇒        (I − B) T = P .
 *
 * The embedded emission of transfer e is share_e · T_src; the part of the
 * pool not exported (self use / own final use) stays with the producer.
 *
 * Columns of B sum to ≤ 1; the deficit is emission settling at the sender
 * (self use). (I − B) is singular exactly when a group of facilities sends
 * 100% of every member's pool around inside the group with no escape — a
 * closed loop with no final energy use. Such a group is named and rejected
 * with CLOSED_LOOP_NO_FINAL_USE; the solver never hangs and never divides by
 * zero.
 *
 * ---------------------------------------------------------------------------
 * Allocation between electricity and heat (reference efficiencies)
 * ---------------------------------------------------------------------------
 *
 * Splitting by raw energy content (η_c = 1 for every carrier) charges heat
 * and electricity per GJ equally; because power generation is far less
 * efficient than heat delivery, that systematically over-allocates fuel
 * emissions to heat users and under-charges electricity users (and vice
 * versa for exergy-based splitting). The reference-efficiency method used
 * here allocates in proportion to the *fuel-equivalent input* each product
 * would have needed on its own:
 *
 *     allocated fraction to carrier c = (q_c / η_c) / Σ_{c'}(q_{c'}/η_{c'})
 *
 * with η from the factor library version (electricity default 0.45,
 * steam/hot-water 0.90). Fairness:
 *  - a heat user is charged at the heat-benchmark efficiency, never made to
 *    subsidize the electricity product's lower efficiency;
 *  - an electricity user is charged at the power-generation benchmark, which
 *    is precisely the avoided-grid-burden framing of CHP;
 *  - single-product facilities: η cancels exactly and the method reduces to
 *    proportional-to-energy (the 14.025 t worked example).
 * Parameters ship with (and are versioned by) the factor library, so their
 * changes land in the "factors" component of a restatement.
 * ---------------------------------------------------------------------------
 */

export interface FacilityOutputs {
  siteCode: string;
  facilityCode: string;
  /** output energy in GJ per carrier */
  outputsGj: Partial<Record<Carrier, Fraction>>;
}

export interface NetworkTransfer {
  recordNo: string;
  fromSiteCode: string;
  fromFacilityCode: string;
  toSiteCode: string;
  /** null = final energy use at toSiteCode (point not bound to a facility) */
  toFacilityCode: string | null;
  toPointCode: string;
  month: string;
  carrier: Carrier;
  /** transferred energy in GJ */
  quantityGj: Fraction;
}

export interface FacilityPrimary {
  /** primary input gas masses in tonnes, per gas */
  primary: Record<Gas, Fraction>;
}

export interface NetworkInput {
  month: string;
  /** facilities that have any outputs this month (ordered, deterministic) */
  facilities: FacilityOutputs[];
  /** facilities that receive energy but produce no output this month */
  sinkFacilities?: Array<{ siteCode: string; facilityCode: string }>;
  transfers: NetworkTransfer[];
  /** primary gas mass per facility key "site/facility" */
  primaryByFacility: Map<string, Record<Gas, Fraction>>;
  eta: Record<Carrier, Fraction>;
}

export interface AllocationHop {
  fromSiteCode: string;
  fromFacilityCode: string;
  toSiteCode: string;
  toPointCode: string;
  toFacilityCode: string | null;
  carrier: Carrier;
  recordNo: string;
  /** share of the sender's pool this transfer carries */
  share: Fraction;
  /** embedded gas mass this transfer carries, per gas, tonnes */
  embedded: Record<Gas, Fraction>;
}

export interface FacilityBalance {
  siteCode: string;
  facilityCode: string;
  /** pool T = primary + received embedded, per gas */
  pool: Record<Gas, Fraction>;
  /** embedded mass received from other facilities, per gas */
  received: Record<Gas, Fraction>;
  /** embedded mass exported through transfers, per gas */
  exported: Record<Gas, Fraction>;
  /** pool − exported: self use staying with the producer, per gas */
  selfUse: Record<Gas, Fraction>;
  /** allocation weight per carrier (q/eta) */
  weights: Partial<Record<Carrier, Fraction>>;
}

export interface NetworkSolution {
  month: string;
  facilities: FacilityBalance[];
  transfers: AllocationHop[];
  /**
   * Coefficient matrix C = (I − B)^{-1}: coeff[receiverKey][producerKey] is
   * the fraction of producer p's primary pool that ends up in receiver r's
   * pool (cycle effects included, computed in closed form — no path
   * expansion). Used by lineage to trace across rings without looping.
   */
  coefficients: Map<string, Map<string, Fraction>>;
}

export function facilityKey(siteCode: string, facilityCode: string): string {
  return `${siteCode}/${facilityCode}`;
}

function zeroGas(): Record<Gas, Fraction> {
  return { CO2: Fraction.ZERO, CH4: Fraction.ZERO, N2O: Fraction.ZERO };
}

/** Allocation weight vector q/eta per carrier and the weight total. */
function allocationWeights(
  f: FacilityOutputs,
  eta: Record<Carrier, Fraction>
): { weights: Partial<Record<Carrier, Fraction>>; total: Fraction } {
  const weights: Partial<Record<Carrier, Fraction>> = {};
  let total = Fraction.ZERO;
  for (const c of ['STEAM', 'HOT_WATER', 'ELECTRICITY'] as Carrier[]) {
    const q = f.outputsGj[c];
    if (q && q.sign() > 0) {
      const w = q.div(eta[c]);
      weights[c] = w;
      total = total.add(w);
    }
  }
  return { weights, total };
}

interface IndexedNetwork {
  keys: string[];
  index: Map<string, number>;
  /** B[i][j] = fraction of pool j flowing into pool i */
  b: Fraction[][];
  meta: Map<
    string,
    { siteCode: string; facilityCode: string; weightTotal: Fraction; weights: Partial<Record<Carrier, Fraction>> }
  >;
}

/**
 * Solve the linear system once per gas but share the structural pieces
 * (indexing, B, the inverse). The inverse is gas-independent so rings are
 * handled in closed form.
 */
export function solveNetwork(input: NetworkInput): NetworkSolution {
  const { keys, index, b, meta } = buildIndexed(input);
  const n = keys.length;

  // Detect the "fully closed loop, no final energy use" failure structurally
  // on the facility graph before any division. A sink SCC whose members send
  // no emission anywhere outside the SCC (column sum to outside = 0) is a
  // group of facilities whose whole output is circulated forever.
  const trapped = findTrappedSccs(keys, index, b);
  if (trapped.length > 0) {
    const names = trapped[0].map((k) => k);
    throw new NetworkStructureError(
      'CLOSED_LOOP_NO_FINAL_USE',
      `closed transfer loop with no final energy use in ${input.month}: facilities ${names.join(', ')} circulate 100% of their output among themselves`,
      names,
      input.month
    );
  }

  // C = (I − B)^{-1} via exact Gauss–Jordan elimination. B is column
  // substochastic with a trapped SCC already rejected, so I − B is
  // invertible; a missing pivot still throws a structured error rather than
  // a raw division-by-zero.
  const inverse = invertSubstochastic(keys, b, input.month);

  // Pool T per gas: T = C · P.
  const pools = new Map<string, Record<Gas, Fraction>>();
  for (let i = 0; i < n; i++) {
    const pool = zeroGas();
    for (const g of GASES) {
      let v = Fraction.ZERO;
      for (let j = 0; j < n; j++) {
        const pj = input.primaryByFacility.get(keys[j]);
        if (pj) v = v.add(inverse[i][j].mul(pj[g]));
      }
      pool[g] = v;
    }
    pools.set(keys[i], pool);
  }

  // Transfer shares & embedded masses. Share of a transfer =
  //   (q_e / eta_c) / weightTotal_src.
  const weightTotalByKey = new Map<string, Fraction>();
  for (const f of input.facilities) {
    weightTotalByKey.set(facilityKey(f.siteCode, f.facilityCode), meta.get(facilityKey(f.siteCode, f.facilityCode))!.weightTotal);
  }

  const hops: AllocationHop[] = [];
  const exported = new Map<string, Record<Gas, Fraction>>();
  const received = new Map<string, Record<Gas, Fraction>>();
  keys.forEach((k) => {
    exported.set(k, zeroGas());
    received.set(k, zeroGas());
  });

  // Deterministic transfer order.
  const transfers = [...input.transfers].sort((a, b2) =>
    a.recordNo < b2.recordNo ? -1 : a.recordNo > b2.recordNo ? 1 : 0
  );
  for (const t of transfers) {
    const srcKey = facilityKey(t.fromSiteCode, t.fromFacilityCode);
    const total = weightTotalByKey.get(srcKey);
    if (!total || total.sign() === 0) {
      // Transfer with no (or zero-weight) outputs: rejected upstream in the
      // bundle validation; guard anyway.
      throw new NetworkStructureError(
        'ZERO_ENERGY_OUTPUT',
        `transfer ${t.recordNo} from ${srcKey} but the facility has no positive output of the carrier in ${t.month}`,
        [srcKey],
        t.month
      );
    }
    const share = t.quantityGj.div(input.eta[t.carrier]).div(total);
    const srcPool = pools.get(srcKey)!;
    const embedded = zeroGas();
    for (const g of GASES) embedded[g] = share.mul(srcPool[g]);
    hops.push({
      fromSiteCode: t.fromSiteCode,
      fromFacilityCode: t.fromFacilityCode,
      toSiteCode: t.toSiteCode,
      toPointCode: t.toPointCode,
      toFacilityCode: t.toFacilityCode,
      carrier: t.carrier,
      recordNo: t.recordNo,
      share,
      embedded
    });
    for (const g of GASES) exported.get(srcKey)![g] = exported.get(srcKey)![g].add(embedded[g]);
    if (t.toFacilityCode) {
      const rk = facilityKey(t.toSiteCode, t.toFacilityCode);
      for (const g of GASES) received.get(rk)![g] = received.get(rk)![g].add(embedded[g]);
    }
  }

  const balances: FacilityBalance[] = keys.map((k) => {
    const m = meta.get(k)!;
    const pool = pools.get(k)!;
    const exp = exported.get(k)!;
    const selfUse = zeroGas();
    for (const g of GASES) selfUse[g] = pool[g].sub(exp[g]);
    return {
      siteCode: m.siteCode,
      facilityCode: m.facilityCode,
      pool,
      received: received.get(k)!,
      exported: exp,
      selfUse,
      weights: m.weights
    };
  });

  const coefficientMap = new Map<string, Map<string, Fraction>>();
  for (let i = 0; i < n; i++) {
    const row = new Map<string, Fraction>();
    for (let j = 0; j < n; j++) row.set(keys[j], inverse[i][j]);
    coefficientMap.set(keys[i], row);
  }

  return { month: input.month, facilities: balances, transfers: hops, coefficients: coefficientMap };
}

function buildIndexed(input: NetworkInput): IndexedNetwork {
  const keys: string[] = [];
  const keySet = new Set<string>();
  const push = (siteCode: string, facilityCode: string) => {
    const k = facilityKey(siteCode, facilityCode);
    if (!keySet.has(k)) {
      keySet.add(k);
      keys.push(k);
    }
    return k;
  };
  for (const f of input.facilities) push(f.siteCode, f.facilityCode);
  for (const s of input.sinkFacilities ?? []) push(s.siteCode, s.facilityCode);
  // Also include any facilities referenced by transfers (bound points).
  for (const t of input.transfers) {
    push(t.fromSiteCode, t.fromFacilityCode);
    if (t.toFacilityCode) push(t.toSiteCode, t.toFacilityCode);
  }
  keys.sort();
  const index = new Map<string, number>();
  keys.forEach((k, i) => index.set(k, i));
  const n = keys.length;

  const outputByKey = new Map<string, FacilityOutputs>();
  for (const f of input.facilities) outputByKey.set(facilityKey(f.siteCode, f.facilityCode), f);

  const meta = new Map<
    string,
    { siteCode: string; facilityCode: string; weightTotal: Fraction; weights: Partial<Record<Carrier, Fraction>> }
  >();
  for (const k of keys) {
    const [siteCode, facilityCode] = splitKey(k);
    const f = outputByKey.get(k);
    const { weights, total } = f
      ? allocationWeights(f, input.eta)
      : { weights: {}, total: Fraction.ZERO };
    meta.set(k, { siteCode, facilityCode, weightTotal: total, weights });
  }

  // B[i][j]: fraction of pool j flowing into pool i.
  const b: Fraction[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => Fraction.ZERO)
  );
  for (const t of input.transfers) {
    const srcKey = facilityKey(t.fromSiteCode, t.fromFacilityCode);
    const j = index.get(srcKey);
    if (j === undefined) continue;
    const total = meta.get(srcKey)!.weightTotal;
    if (total.sign() === 0) continue; // structural guard; validated upstream
    const share = t.quantityGj.div(input.eta[t.carrier]).div(total);
    if (t.toFacilityCode) {
      const i = index.get(facilityKey(t.toSiteCode, t.toFacilityCode));
      if (i !== undefined) b[i][j] = b[i][j].add(share);
    }
  }

  return { keys, index, b, meta };
}

function splitKey(k: string): [string, string] {
  const i = k.indexOf('/');
  return [k.slice(0, i), k.slice(i + 1)];
}

/**
 * Exact Gauss–Jordan inverse of (I − B). B is column-substochastic with all
 * column sums ≤ 1; when no trapped SCC exists the matrix is invertible.
 * Complexity O(n³) bigint-rational operations per month (the inverse is
 * computed once and shared by all three gases).
 */
function invertSubstochastic(keys: string[], b: Fraction[][], month: string): Fraction[][] {
  const n = keys.length;
  const a: Fraction[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: 2 * n }, (__, j) =>
      j < n ? (i === j ? Fraction.ONE.sub(b[i][j]) : b[i][j].neg()) : i === j - n ? Fraction.ONE : Fraction.ZERO
    )
  );

  for (let col = 0; col < n; col++) {
    let pivot = col;
    while (pivot < n && a[pivot][col].sign() === 0) pivot++;
    if (pivot === n) {
      throw new NetworkStructureError(
        'CLOSED_LOOP_NO_FINAL_USE',
        `transfer network in ${month} has no solution: facilities circulate all output with no final energy use`,
        keys,
        month
      );
    }
    if (pivot !== col) {
      const tmp = a[pivot];
      a[pivot] = a[col];
      a[col] = tmp;
    }
    const pv = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] = a[col][j].div(pv);
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = a[row][col];
      if (f.sign() === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[row][j] = a[row][j].sub(f.mul(a[col][j]));
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * Find sink strongly-connected components with no emission escape.
 *
 * Graph: nodes are facilities; there is an edge j → i when B[i][j] > 0
 * (pool flows from j to i). A node additionally has an implicit escape edge
 * when its column sum is < 1 (self use / final use). A sink SCC is trapped
 * exactly when every member's column sum into the SCC is 1 and there is no
 * outgoing edge (implicit or explicit) leaving it. Tarjan runs in O(V+E);
 * only the trapped groups are reported, deterministically ordered.
 */
function findTrappedSccs(keys: string[], index: Map<string, number>, b: Fraction[][]): string[][] {
  const n = keys.length;
  // outgoing adjacency on positive flows
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (b[i][j].sign() > 0) adj[j].push(i);
    }
    adj[j].sort((x, y) => x - y);
  }
  const sccs = tarjan(n, adj);

  const trapped: string[][] = [];
  for (const scc of sccs) {
    const set = new Set(scc);
    let escapes = false;
    let outgoingEdge = false;
    for (const j of scc) {
      let colSumInside = Fraction.ZERO;
      for (const i of scc) colSumInside = colSumInside.add(b[i][j]);
      if (colSumInside.compare(Fraction.ONE) < 0) escapes = true; // self use / final use
      for (const i of adj[j]) {
        if (!set.has(i)) outgoingEdge = true;
      }
    }
    if (!escapes && !outgoingEdge && scc.length > 0) {
      trapped.push(scc.map((i) => keys[i]).sort());
    }
  }
  trapped.sort((x, y) => x[0].localeCompare(y[0]));
  return trapped;
}

/** Iterative Tarjan SCC (deterministic; avoids recursion depth limits). */
function tarjan(n: number, adj: number[][]): number[][] {
  let disc = 0;
  const dfs = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const sccs: number[][] = [];

  // Iterative frames: [node, nextEdgeIndex]
  for (let root = 0; root < n; root++) {
    if (dfs[root] !== -1) continue;
    const frames: Array<[number, number]> = [[root, 0]];
    dfs[root] = low[root] = disc++;
    stack.push(root);
    onStack[root] = true;

    while (frames.length) {
      const [v, edgeIdx] = frames[frames.length - 1];
      if (edgeIdx < adj[v].length) {
        const w = adj[v][edgeIdx];
        frames[frames.length - 1][1]++;
        if (dfs[w] === -1) {
          dfs[w] = low[w] = disc++;
          stack.push(w);
          onStack[w] = true;
          frames.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], dfs[w]);
        }
      } else {
        if (low[v] === dfs[v]) {
          const comp: number[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack[w] = false;
            comp.push(w);
            if (w === v) break;
          }
          sccs.push(comp);
        }
        frames.pop();
        if (frames.length) {
          const parent = frames[frames.length - 1][0];
          low[parent] = Math.min(low[parent], low[v]);
        }
      }
    }
  }
  return sccs;
}

/**
 * Trace a transfer hop back to producer facilities.
 *
 * Returns the raw closed-form producer coefficients C[sender][producer]
 * (every ring traversal already folded in, so tracing never expands paths
 * and cannot loop). The mass this hop carries from producer p is
 * hop.share · C[sender][p] · P_p — callers multiply by the hop share and
 * each primary record's mass.
 */
export function traceTransfer(
  solution: NetworkSolution,
  transferRecordNo: string
): { hop: AllocationHop; producerCoefficients: Map<string, Fraction> } | null {
  const hop = solution.transfers.find((t) => t.recordNo === transferRecordNo);
  if (!hop) return null;
  const senderKey = facilityKey(hop.fromSiteCode, hop.fromFacilityCode);
  return { hop, producerCoefficients: new Map(solution.coefficients.get(senderKey)!) };
}
