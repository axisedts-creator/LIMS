// C9 T-03 — Westgard engine, pure (02-TRD §7.5, §7.9; 08 A17 D-54 exact decimals; 08 A17 D-58 N=3 rules pinned by vectors).
// done_when: all V01-V32 + extra cases of 02-TRD §7.9 pass; canonical rule order. ACs: AC-06.1 (every vector), AC-06.2 (classic gate vs modern),
//   AC-06.3 (R-4s within-run only, V06), AC-06.4 (3.5 SD + -0.6 SD -> only 1-3s, V07), AC-06.5 (exactly on 2.0 / 3.0 SD does not exceed, V24a/b).
// Vector table lives in ./fixtures/westgard-vectors.ts, copied verbatim from §7.9. No 07-SECURITY test targets this pure module.
// Interface expected from the writer (../westgard.ts) — signatures are fixed by TRD §7.5:
//   evaluate(current: readonly QcPoint[], history: readonly QcPoint[], o: WestgardOptions): WestgardResult
//   QcPoint = { id, level, dev: Decimal (= v - mean, exact), sd: Decimal, inCurrentRun: boolean }
// SEAMS the spec does not fix (the harness below decides, the caller T-04 must follow):
//   - `history` handed to evaluate() is ALREADY filtered by the caller: oldest first, rejected runs dropped when exclude_rejected_runs_from_history,
//     excluded observations dropped (V25/V26). The engine never sees run outcomes.
//   - `current` is in order-key order; the engine treats `S = history ++ current` and `S_L` by array order.
//   - Decimal import is relative until packages/shared-ts exports ./decimal (same as T-02 target-stats.test.ts, LD-05 precedent).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { add, mul, parseDecimal, sub, type Decimal } from '../../../../../../../packages/shared-ts/src/decimal/index.js';
import { evaluate, type QcPoint, type WestgardOptions } from '../westgard.js';
import { acc, p2, rep, VECTORS, type HistRun, type Obs, type Vector, type VOpts } from './fixtures/westgard-vectors.js';

const D = (s: string): Decimal => {
  const d = parseDecimal(s);
  if (!d) throw new Error(`bad decimal literal ${s}`);
  return d;
};
const CANON: readonly string[] = ['1-3s', '2-2s', '2of3-2s', 'R-4s', '4-1s', '3-1s', '6x', '8x', '9x', '10x', '12x'];

interface Scale { name: string; mean: string; sd: string }
const SCALES: readonly Scale[] = [
  { name: 'mean 100.0 sd 2.0', mean: '100.0', sd: '2.0' },
  { name: 'mean -10 sd 0.5 (sign handling)', mean: '-10', sd: '0.5' },
];

function point(id: string, o: Obs, sc: Scale, inCurrentRun: boolean): QcPoint {
  const mean = D(sc.mean), sd = D(sc.sd);
  const value = add(mean, mul(D(o[1]), sd)); // v = mean + z*sd, exact
  return { id, level: o[0], dev: sub(value, mean), sd, inCurrentRun };
}

function build(v: Vector, sc: Scale): { current: QcPoint[]; history: QcPoint[]; o: WestgardOptions } {
  const op: VOpts = v.opts ?? {};
  const excludeRejected = op.excludeRejected ?? true;
  const history: QcPoint[] = [];
  v.history.forEach((run, r) => {
    if (run.outcome === 'rejected' && excludeRejected) return;
    run.obs.forEach((ob, i) => { if (ob.length === 3) return; history.push(point(`h${r}.${i}`, ob, sc, false)); });
  });
  const current = v.current.filter((ob) => ob.length === 2).map((ob, i) => point(`c${i}`, ob, sc, true));
  return {
    current, history,
    o: {
      n: v.n, mode: v.mode, meanRule: op.meanRule ?? (v.n === 3 ? '6x' : '10x'),
      twoTwoAcrossRuns: op.twoTwoAcrossRuns ?? true, countAcrossMaterials: op.countAcrossMaterials ?? true,
    },
  };
}

function run(v: Vector, sc: Scale) {
  const { current, history, o } = build(v, sc);
  return { r: evaluate(current, history, o), current, history, o };
}

describe.each(SCALES)('westgard §7.9 vectors — $name', (sc) => {
  it.each(VECTORS.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const { r } = run(v, sc);
    expect(r.outcome).toBe(v.outcome);
    expect([...r.fired]).toEqual(v.fired);
    expect(r.warning).toBe(v.warning);
    // hits: '1-2s' listed iff warning; every rejection rule in `fired` has a hit; attribution — each hit has >=1 observation of the current run
    const hitRules = r.hits.map((h) => h.rule);
    expect(hitRules.includes('1-2s')).toBe(v.warning);
    for (const f of v.fired) expect(hitRules).toContain(f);
    const cur = new Set(['c0', 'c1', 'c2', 'c3']);
    for (const h of r.hits) expect(h.observationIds.some((id) => cur.has(id)), `${h.rule} attribution`).toBe(true);
  });
});

describe('AC-06.2 classic gate vs modern (V10, V12, V18)', () => {
  const pairs: readonly [string, string][] = [['V10m', 'V10c'], ['V12m', 'V12c'], ['V18m', 'V18c']];
  it.each(pairs)('%s rejects, %s accepts on the same data', (m, c) => {
    const vm = VECTORS.find((v) => v.id === m)!, vc = VECTORS.find((v) => v.id === c)!;
    expect(run(vm, SCALES[0]!).r.outcome).toBe('rejected');
    expect(run(vc, SCALES[0]!).r.outcome).toBe('accepted');
  });
});

describe('AC-06.3 / AC-06.4 / AC-06.5 named', () => {
  it('AC-06.3 V06: R-4s split across two runs does not fire', () => {
    expect(run(VECTORS.find((v) => v.id === 'V06')!, SCALES[0]!).r.fired).not.toContain('R-4s');
  });
  it('AC-06.4 V07: +3.5 SD and -0.6 SD -> 1-3s only', () => {
    expect([...run(VECTORS.find((v) => v.id === 'V07')!, SCALES[0]!).r.fired]).toEqual(['1-3s']);
  });
  it('AC-06.5 V24a/b: exactly 2.0 / 3.0 SD does not exceed', () => {
    expect(run(VECTORS.find((v) => v.id === 'V24a')!, SCALES[0]!).r.warning).toBe(false);
    const b = run(VECTORS.find((v) => v.id === 'V24b')!, SCALES[0]!).r;
    expect(b.fired).toEqual([]);
    expect(b.warning).toBe(true);
  });
});

describe('extra cases — canonical order of fired (1-3s, 2-2s, 2of3-2s, R-4s, 4-1s, 3-1s, 6x, 8x, 9x, 10x, 12x)', () => {
  const mk = (id: string, n: 2 | 3 | 4, mode: 'classic' | 'modern', history: HistRun[], cur: Obs[], fired: string[], opts?: VOpts): Vector =>
    ({ id, n, mode, history, current: cur, opts, outcome: 'rejected', fired, warning: true });
  const cases: Vector[] = [
    mk('X1 1-3s+2-2s', 2, 'classic', [], p2('3.1', '3.2'), ['1-3s', '2-2s']),
    mk('X2 1-3s+R-4s', 2, 'classic', [], p2('3.5', '-2.2'), ['1-3s', 'R-4s']),
    mk('X3 1-3s+2-2s+4-1s+8x', 2, 'modern', rep(3, acc(...p2('1.5', '1.5'))), p2('3.1', '3.2'), ['1-3s', '2-2s', '4-1s', '8x'], { meanRule: '8x' }),
  ];
  it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, v) => {
    const { r } = run(v, SCALES[0]!);
    expect([...r.fired]).toEqual(v.fired);
    expect(r.fired.map((f) => CANON.indexOf(f))).toEqual([...r.fired.map((f) => CANON.indexOf(f))].sort((a, b) => a - b));
    expect(r.outcome).toBe('rejected');
  });
});

describe('extra cases — mean rule k fires with k points, never with k-1 (modern, N=2)', () => {
  const ks = [6, 8, 9, 10, 12] as const;
  // history: one below-mean point (breaks the run), then m above-mean points; current adds 2 above-mean points -> m + 2 consecutive above.
  const lvl = (i: number): 'L1' | 'L2' => (i % 2 === 0 ? 'L2' : 'L1'); // alternate so current (L1, L2) continues the sequence
  const mkv = (k: number, total: number): Vector => {
    const m = total - 2;
    const obs: Obs[] = [['L1', '-0.5'], ...Array.from({ length: m }, (_, i): Obs => [lvl(i + 1), '0.5'])];
    return { id: `k${k}/${total}`, n: 2, mode: 'modern', history: [acc(...obs)], current: p2('0.5', '0.5'), opts: { meanRule: `${k}x` as VOpts['meanRule'] }, outcome: 'accepted', fired: [], warning: false };
  };
  it.each(ks.map((k) => [k] as const))('%ix: k-1 consecutive does not fire, k fires', (k) => {
    for (const sc of SCALES) {
      expect(run(mkv(k, k - 1), sc).r.fired, `k-1 (${sc.name})`).not.toContain(`${k}x`);
      expect(run(mkv(k, k), sc).r.fired, `k (${sc.name})`).toContain(`${k}x`);
    }
  });
});

describe('extra cases — classic V22 with L2 2.1 replaced by 1.9', () => {
  it('no 1-2s, so the gated 4-1s is not reported -> accepted', () => {
    const v: Vector = { id: 'V22x', n: 4, mode: 'classic', history: [], current: [['L1', '1.2'], ['L1', '1.4'], ['L2', '1.1'], ['L2', '1.9']], outcome: 'accepted', fired: [], warning: false };
    for (const sc of SCALES) {
      const { r } = run(v, sc);
      expect(r.outcome).toBe('accepted');
      expect(r.fired).toEqual([]);
      expect(r.warning).toBe(false);
    }
  });
});

describe('extra cases — incomplete run is the caller\'s call', () => {
  it('N=2 single member z 0.5: engine returns accepted, no warning, no fired (T-04 turns it into `incomplete`)', () => {
    const { r } = run({ id: 'inc', n: 2, mode: 'classic', history: [], current: [['L1', '0.5']], outcome: 'accepted', fired: [], warning: false }, SCALES[0]!);
    expect(r.outcome).toBe('accepted');
    expect(r.fired).toEqual([]);
    expect(r.warning).toBe(false);
  });
});

describe('purity and exactness (D-54)', () => {
  it('does not mutate or retain its inputs; same input -> same output', () => {
    const v = VECTORS.find((x) => x.id === 'V12m')!;
    const { current, history, o } = build(v, SCALES[0]!);
    const snap = JSON.stringify([current, history, o], (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    Object.freeze(current); Object.freeze(history); Object.freeze(o);
    const a = evaluate(current, history, o);
    const b = evaluate(current, history, o);
    expect(a).toEqual(b);
    expect(JSON.stringify([current, history, o], (_k, x) => (typeof x === 'bigint' ? x.toString() : x))).toBe(snap);
  });
  it('limit is exact: dev = 2.0000000000000000000000001 x sd exceeds, 2.0 x sd does not (no float)', () => {
    const sd = D('2.0');
    const mk = (z: string): QcPoint => ({ id: 'c0', level: 'L1', dev: mul(D(z), sd), sd, inCurrentRun: true });
    const o: WestgardOptions = { n: 2, mode: 'classic', meanRule: '10x', twoTwoAcrossRuns: true, countAcrossMaterials: true };
    expect(evaluate([mk('2.0')], [], o).warning).toBe(false);
    expect(evaluate([mk('2.0000000000000000000000001')], [], o).warning).toBe(true);
    expect(evaluate([mk('-2.0000000000000000000000001')], [], o).warning).toBe(true);
    expect(evaluate([mk('3.0')], [], o).fired).toEqual([]);
    expect([...evaluate([mk('3.0000000000000000000000001')], [], o).fired]).toEqual(['1-3s']);
  });
  it('value equal to the mean breaks an n-x run (DECISION §7.1) and is on neither side', () => {
    const sd = D('2.0');
    const pt = (id: string, z: string, cur: boolean): QcPoint => ({ id, level: 'L1', dev: mul(D(z), sd), sd, inCurrentRun: cur });
    const o: WestgardOptions = { n: 2, mode: 'modern', meanRule: '6x', twoTwoAcrossRuns: true, countAcrossMaterials: true };
    const hist = ['0.5', '0.5', '0.5', '0', '0.5'].map((z, i) => pt(`h${i}`, z, false));
    expect(evaluate([pt('c0', '0.5', true)], hist, o).fired).toEqual([]); // 2 above after the zero
    const hist6 = ['0.5', '0.5', '0.5', '0.5', '0.5'].map((z, i) => pt(`h${i}`, z, false));
    expect([...evaluate([pt('c0', '0.5', true)], hist6, o).fired]).toEqual(['6x']);
  });
  it('attribution: an old violation alone never rejects a new run', () => {
    const sd = D('2.0');
    const pt = (id: string, z: string, cur: boolean): QcPoint => ({ id, level: 'L1', dev: mul(D(z), sd), sd, inCurrentRun: cur });
    const o: WestgardOptions = { n: 2, mode: 'modern', meanRule: '10x', twoTwoAcrossRuns: true, countAcrossMaterials: true };
    const hist = [pt('h0', '2.2', false), pt('h1', '2.2', false)]; // an old 2-2s in history
    const r = evaluate([pt('c0', '0.1', true)], hist, o);
    expect(r.fired).toEqual([]);
    expect(r.outcome).toBe('accepted');
  });
  it('source stays decimal-only: no division, no double (08 A17 D-54)', () => {
    const src = readFileSync(new URL('../westgard.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bdiv\b|toDouble|Number\(|parseFloat|Math\./);
    expect(src).toMatch(/shared-ts/);
  });
});
