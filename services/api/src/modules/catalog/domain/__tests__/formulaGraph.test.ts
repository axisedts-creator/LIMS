// T-11 (C3) — domain/formulaGraph.ts: formula dependency graph, cycle path, chain depth, dependency order (pure; 02-TRD §7.2 steps 1–5).
// Spec: 02-TRD §7.2 (iterative DFS with colours; a grey hit returns the cycle path `A -> … -> A`; chain depth = longest path through formula analytes, > 5 rejected by the
//       SERVICE; dependency_order = inputs before dependants over A's reachable set), §7.1 limits (chain depth ≤ 5), §14 unit-test list ("self-cycle, 2- and 3-cycles, chain depth 5 vs 6,
//       dependency order"); PRD AC-04.3, AC-04.7; 07-SECURITY AB-17 (no stack overflow).
// SEAM (spec names the file, not the signature — see .orchestra/notes/C3.T-11-tests.md):
//   export function analyzeFormulaGraph(input: {
//     root: string;                                    // analyte CODE whose candidate formula is checked
//     rootInputs: readonly string[];                   // the candidate's distinct analyte refs (order of first appearance)
//     edges: ReadonlyMap<string, readonly string[]>;   // other FORMULA analytes' input codes (published + scheduled); an entry for `root` is REPLACED by rootInputs (§7.2 step 2)
//   }): { cycle: readonly string[] }                   // path root -> … -> root (first === last) when a cycle is reachable from root
//     | { cycle?: undefined; chainDepth: number; dependencyOrder: readonly string[] };
//   chainDepth counts FORMULA analytes on the longest path including the root (root with only leaf inputs = 1); analytes without an `edges` entry are leaves (0).
//   dependencyOrder = every code reachable from root (leaves included, root excluded or last), each input before every analyte that reads it, no duplicates.
//   Pure: never mutates its input, no I/O, iterative (a 5 000-deep chain must not overflow the stack, a 2^40-path ladder must finish: memoise).
import { describe, expect, it } from 'vitest';
import { analyzeFormulaGraph } from '../formulaGraph.js';

type Edges = Map<string, string[]>;
const E = (o: Record<string, string[]>): Edges => new Map(Object.entries(o));
const run = (root: string, rootInputs: string[], edges: Edges = new Map()): any => analyzeFormulaGraph({ root, rootInputs, edges });
const order = (r: any, root: string): string[] => (r.dependencyOrder as string[]).filter((c) => c !== root);
/** Every dependant comes after each of its inputs (leaves and the root included). */
const topological = (list: string[], g: Edges) => {
  for (const [dep, inputs] of g) for (const i of inputs) {
    const a = list.indexOf(i), b = list.indexOf(dep);
    if (a >= 0 && b >= 0) expect(a, `${i} must precede ${dep}`).toBeLessThan(b);
  }
};

describe('cycles — path is root -> … -> root (AC-04.3)', () => {
  it('self-cycle: A reads A -> [A, A]', () => {
    expect(run('A', ['A']).cycle).toEqual(['A', 'A']);
  });

  it('AC-04.3 two-cycle: published A = B + 1, draft B = A * 2 -> validating B yields B -> A -> B', () => {
    const r = run('B', ['A'], E({ A: ['B'] }));
    expect(r.cycle).toEqual(['B', 'A', 'B']);
    expect(r.cycle.join(' -> ')).toBe('B -> A -> B');
  });

  it('the same cycle seen from the other side is rooted at that side: A -> B -> A', () => {
    expect(run('A', ['B'], E({ B: ['A'] })).cycle).toEqual(['A', 'B', 'A']);
  });

  it('three-cycle: A -> B -> C -> A', () => {
    expect(run('A', ['B'], E({ B: ['C'], C: ['A'] })).cycle).toEqual(['A', 'B', 'C', 'A']);
  });

  it('a cycle is found when only one branch of several leads back, and the path names only cycle members', () => {
    const r = run('B', ['A', 'HB', 'RBC'], E({ A: ['HB', 'B'], X: ['HB'] }));
    expect(r.cycle).toEqual(['B', 'A', 'B']);
  });

  it('the stale edges of the root (its published formula) are REPLACED by the candidate: A used to read B, the draft no longer does -> no cycle', () => {
    const r = run('A', ['HB'], E({ A: ['B'], B: ['A'] }));
    expect(r.cycle).toBeUndefined();
    expect(r.chainDepth).toBe(1);
  });

  it('a cycle that does not pass through the root but is reachable from it is still reported as a closed path', () => {
    const r = run('R', ['X'], E({ X: ['Y'], Y: ['X'] }));
    expect(r.cycle).toBeDefined();
    const p = r.cycle as string[];
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(p[0]).toBe(p[p.length - 1]);
    const g = E({ X: ['Y'], Y: ['X'] });
    for (let i = 0; i + 1 < p.length; i++) expect(g.get(p[i]!) ?? []).toContain(p[i + 1]);
  });

  it('a cycle that is NOT reachable from the root is none of its business', () => {
    expect(run('A', ['HB'], E({ X: ['Y'], Y: ['X'] })).cycle).toBeUndefined();
  });
});

describe('chain depth — formula analytes on the longest path, root included (AC-04.7)', () => {
  const chain = (formulaAnalytes: number): Edges => {
    // C1 reads LEAF; C2 reads C1; …; the root reads C<n> ⇒ depth = n + 1
    const g: Edges = new Map();
    for (let k = 1; k <= formulaAnalytes; k++) g.set(`C${k}`, [k === 1 ? 'LEAF' : `C${k - 1}`]);
    return g;
  };

  it('a formula over leaf analytes only has depth 1 (OpenAPI example: HGB * 3 -> chain_depth 1); with no refs at all depth is 1 as well', () => {
    expect(run('A', ['HGB']).chainDepth).toBe(1);
    expect(run('A', []).chainDepth).toBe(1);
  });

  it('depth 5 is accepted territory (root + 4 formula analytes), depth 6 is the first too-deep chain (root + 5)', () => {
    expect(run('TOP', ['C4'], chain(4)).chainDepth).toBe(5);
    expect(run('TOP', ['C5'], chain(5)).chainDepth).toBe(6);
  });

  it('the longest of several branches wins; shared sub-chains are counted once per path, not summed', () => {
    const g = E({ B: ['C'], C: ['LEAF'], D: ['LEAF'] });
    expect(run('A', ['B', 'D', 'HB'], g).chainDepth).toBe(3);                         // A -> B -> C
  });

  it('leaf analytes (no edges entry) contribute 0, even when they are many', () => {
    expect(run('A', ['HB', 'RBC', 'MCV', 'PLT', 'WBC'], E({})).chainDepth).toBe(1);
  });

  it('a 5 000-deep chain neither overflows the stack nor throws (AB-17 spirit) and reports its depth', () => {
    const n = 5000, g: Edges = new Map();
    for (let k = 1; k <= n; k++) g.set(`N${k}`, [k === n ? 'LEAF' : `N${k + 1}`]);
    const r = run('ROOT', ['N1'], g);
    expect(r.cycle).toBeUndefined();
    expect(r.chainDepth).toBe(n + 1);
  });

  it('a ladder with 2^40 root-to-leaf paths finishes (memoised, not path-enumerating)', () => {
    const g: Edges = new Map(); const L = 40;
    for (let i = 0; i < L; i++) for (const side of ['A', 'B']) g.set(`${side}${i}`, [`A${i + 1}`, `B${i + 1}`]);
    const t0 = Date.now();
    const r = run('ROOT', ['A0', 'B0'], g);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.chainDepth).toBe(L + 1);                                                  // ROOT + layers 0..L-1 (layer L holds leaves)
  });
});

describe('dependency order — inputs before dependants over the reachable set (§7.2 step 5)', () => {
  it('a linear chain has exactly one order: leaf first, then each dependant', () => {
    const g = E({ N3: ['N2'], N2: ['N1'], N1: ['HB'] });
    expect(order(run('ROOT', ['N3'], g), 'ROOT')).toEqual(['HB', 'N1', 'N2', 'N3']);
  });

  it('a diamond lists the shared input once, before both of its readers', () => {
    const g = E({ B: ['D'], C: ['D'] });
    const list = order(run('A', ['B', 'C'], g), 'A');
    expect([...list].sort()).toEqual(['B', 'C', 'D']);
    expect(list.indexOf('D')).toBeLessThan(list.indexOf('B'));
    expect(list.indexOf('D')).toBeLessThan(list.indexOf('C'));
  });

  it('contains exactly the reachable codes: unreachable formula analytes and the stale root entry are absent', () => {
    const g = E({ A: ['STALE'], B: ['HB'], UNRELATED: ['RBC'] });
    const list = order(run('A', ['B'], g), 'A');
    expect([...list].sort()).toEqual(['B', 'HB']);
  });

  it('root, if listed at all, comes last', () => {
    const r = run('A', ['B'], E({ B: ['HB'] }));
    const i = (r.dependencyOrder as string[]).indexOf('A');
    if (i >= 0) expect(i).toBe(r.dependencyOrder.length - 1);
  });

  it('a larger random DAG: every edge is respected and nothing is listed twice', () => {
    let s = 7; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const g: Edges = new Map();
    for (let i = 1; i <= 60; i++) g.set(`F${i}`, Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => (rnd() < 0.15 ? 'LEAF' : `F${Math.max(0, i - 1 - Math.floor(rnd() * 5))}`)).filter((c) => c !== 'F0'));
    const r = run('ROOT', ['F60', 'F59'], g);
    expect(r.cycle).toBeUndefined();
    const list = order(r, 'ROOT');
    expect(new Set(list).size).toBe(list.length);
    topological(list, g);
  });
});

describe('purity and hostile input', () => {
  it('never mutates the edges map, its arrays or rootInputs', () => {
    const g = E({ B: ['C'], C: ['HB'], A: ['STALE'] }); const before = JSON.stringify([...g]);
    const inputs = Object.freeze(['B']) as unknown as string[];
    run('A', inputs, g);
    expect(JSON.stringify([...g])).toBe(before);
  });

  it('a second call with the same input gives the same answer (no module-level state)', () => {
    const g = E({ B: ['C'], C: ['HB'] });
    expect(run('A', ['B'], g)).toEqual(run('A', ['B'], g));
  });

  it('codes that look like Object.prototype keys are plain codes (Map semantics, no prototype lookups)', () => {
    const r = run('ROOT', ['constructor', '__proto__', 'toString'], E({ constructor: ['hasOwnProperty'] }));
    expect(r.cycle).toBeUndefined();
    expect(r.chainDepth).toBe(2);
    expect(order(r, 'ROOT')).toEqual(expect.arrayContaining(['hasOwnProperty', 'constructor', '__proto__', 'toString']));
  });

  it('duplicate refs in rootInputs do not duplicate anything in the order', () => {
    const list = order(run('A', ['HB', 'HB', 'RBC', 'HB']), 'A');
    expect([...list].sort()).toEqual(['HB', 'RBC']);
  });
});
