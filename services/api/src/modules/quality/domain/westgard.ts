// C9 T-03 — Westgard multirule engine, pure (02-TRD §7.1, §7.2, §7.5; 08 A17 D-54 exact decimals; 08 A17 D-58 N=3 rules pinned by vectors).
// No DB, no clock, no float: limits are compared with exact decimal multiplication (k * sd), never z-scores.
// [CONV] Relative import until packages/shared-ts exports ./decimal (target-stats.ts / core/errors.ts precedent, LD-05).
import { cmp, ZERO, type Decimal } from '../../../../../../packages/shared-ts/src/decimal/index.js';

export type RuleCode = '1-2s' | '1-3s' | '2-2s' | 'R-4s' | '4-1s' | '10x' | '2of3-2s' | '3-1s' | '6x' | '8x' | '9x' | '12x';
export interface QcPoint { id: string; level: string; dev: Decimal; sd: Decimal; inCurrentRun: boolean } // dev = v - mean (exact)
export interface WestgardOptions {
  n: 2 | 3 | 4; mode: 'classic' | 'modern'; meanRule: '6x' | '8x' | '9x' | '10x' | '12x';
  twoTwoAcrossRuns: boolean; countAcrossMaterials: boolean;
}
export interface WestgardResult {
  warning: boolean;
  fired: readonly RuleCode[]; // rejection rules, canonical order
  hits: readonly { rule: RuleCode; observationIds: readonly string[] }[]; // includes '1-2s'
  outcome: 'accepted' | 'accepted_warning' | 'rejected'; // 'incomplete' is decided by the caller (T-04)
}

/** Canonical order of `fired` (02-TRD §7.5). */
const CANON: readonly RuleCode[] = ['1-3s', '2-2s', '2of3-2s', 'R-4s', '4-1s', '3-1s', '6x', '8x', '9x', '10x', '12x'];

type Side = 1 | -1;

/** exc(o, k, side): dev > k*sd (side +1) or dev < -k*sd (side -1), strict, exact. */
function exc(p: QcPoint, k: bigint, side: Side): boolean {
  const lim: Decimal = { m: p.sd.m * k, s: p.sd.s };
  return side === 1 ? cmp(p.dev, lim) === 1 : cmp(p.dev, { m: -lim.m, s: lim.s }) === -1;
}
const excEither = (p: QcPoint, k: bigint): boolean => exc(p, k, 1) || exc(p, k, -1);
/** +1 above the mean, -1 below, 0 on it (on neither side). */
const sideOf = (p: QcPoint): -1 | 0 | 1 => cmp(p.dev, ZERO);

/** Every window of `size` consecutive elements of `seq`, as [start, end) index pairs. */
function* windows(len: number, size: number): Generator<[number, number]> {
  for (let i = 0; i + size <= len; i++) yield [i, i + size];
}

/**
 * Collects ids of the violating elements of every window that satisfies `isViolating`-count and has >= 1 violating element in C
 * (attribution, TRD §7.1: old violations never reject a new run). `need` = violating elements required in the window.
 */
function scan(seq: readonly QcPoint[], size: number, need: number, violates: (p: QcPoint) => boolean, into: Set<string>): void {
  for (const [a, b] of windows(seq.length, size)) {
    const viol = seq.slice(a, b).filter(violates);
    if (viol.length >= need && viol.some((p) => p.inCurrentRun)) viol.forEach((p) => into.add(p.id));
  }
}

/** Sequences a run-spanning rule looks at: each S_L, plus S when countAcrossMaterials. */
function sequences(all: readonly QcPoint[], countAcrossMaterials: boolean): QcPoint[][] {
  const levels = [...new Set(all.map((p) => p.level))];
  const out = levels.map((l) => all.filter((p) => p.level === l));
  if (countAcrossMaterials) out.push([...all]);
  return out;
}

/**
 * Evaluates the multirule set for one run. `history` is already filtered by the caller (oldest first; rejected runs and
 * excluded observations dropped); `current` is in order-key order. S = history ++ current.
 */
export function evaluate(current: readonly QcPoint[], history: readonly QcPoint[], o: WestgardOptions): WestgardResult {
  const all: readonly QcPoint[] = [...history, ...current];
  const hitIds = new Map<RuleCode, Set<string>>();
  const hit = (r: RuleCode): Set<string> => { let s = hitIds.get(r); if (!s) { s = new Set(); hitIds.set(r, s); } return s; };
  const ids = (r: RuleCode): readonly string[] => [...(hitIds.get(r) ?? [])];

  // 1-2s warning and 1-3s: current run only.
  const warnPts = current.filter((p) => excEither(p, 2n));
  const warning = warnPts.length > 0;
  if (warning) warnPts.forEach((p) => hit('1-2s').add(p.id));
  current.filter((p) => excEither(p, 3n)).forEach((p) => hit('1-3s').add(p.id));

  // R-4s: one > +2SD and one < -2SD, both inside the current run (within-run only, AC-06.3).
  const up = current.filter((p) => exc(p, 2n, 1)), down = current.filter((p) => exc(p, 2n, -1));
  if (up.length > 0 && down.length > 0) [...up, ...down].forEach((p) => hit('R-4s').add(p.id));

  // 2-2s (N=2/4) or 2of3-2s (N=3): within C across levels, and across runs per level when twoTwoAcrossRuns.
  const twoSeqs: QcPoint[][] = [[...current]];
  if (o.twoTwoAcrossRuns) twoSeqs.push(...sequences(all, false));
  for (const side of [1, -1] as const) {
    for (const seq of twoSeqs) {
      if (o.n === 3) scan(seq, 3, 2, (p) => exc(p, 2n, side), hit('2of3-2s'));
      else scan(seq, 2, 2, (p) => exc(p, 2n, side), hit('2-2s'));
    }
  }

  // 4-1s (N=2/4) or 3-1s (N=3), and the n-x rule: per level, and across materials when countAcrossMaterials.
  const runSeqs = sequences(all, o.countAcrossMaterials);
  const oneSd = o.n === 3 ? 3 : 4;
  const k = parseInt(o.meanRule, 10); // '6x' -> 6; the digits come from the closed WestgardOptions union
  for (const seq of runSeqs) {
    for (const side of [1, -1] as const) {
      scan(seq, oneSd, oneSd, (p) => exc(p, 1n, side), hit(o.n === 3 ? '3-1s' : '4-1s'));
      scan(seq, k, k, (p) => sideOf(p) === side, hit(o.meanRule));
    }
  }

  // Mode gate: classic reports 4-1s / 3-1s / kx only after a 1-2s warning in C; modern evaluates every rule independently.
  const gated = new Set<RuleCode>(['4-1s', '3-1s', '6x', '8x', '9x', '10x', '12x']);
  const live = (r: RuleCode): boolean => ids(r).length > 0 && (o.mode === 'modern' || warning || !gated.has(r));
  const fired = CANON.filter(live);
  const hits: { rule: RuleCode; observationIds: readonly string[] }[] = [];
  if (warning) hits.push({ rule: '1-2s', observationIds: ids('1-2s') });
  for (const rule of fired) hits.push({ rule, observationIds: ids(rule) });

  return { warning, fired, hits, outcome: fired.length > 0 ? 'rejected' : warning ? 'accepted_warning' : 'accepted' };
}
