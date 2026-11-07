// T-12 (C3) — domain/panelGraph.ts: pure panel expansion, cycle and depth checks (02-TRD §7.7, §3 layout "panelGraph.ts — expansion, cycle + depth (pure)").
// Spec: PRD AC-07.1 (expansion to 6 tests), AC-07.2 (a test in two places once), AC-07.3 (cycle), AC-07.4 (depth > 4), 03-IC §4.2 contract tests (4) (5).
// SEAM (spec silent on names; see .orchestra/notes/T-12-tests.md) — no I/O, no clock, no DB, never mutates its inputs:
//   export const PANEL_MAX_DEPTH = 4                                       // LIMS_CATALOG_PANEL_MAX_DEPTH default [CONV]
//   export interface Member { readonly kind: 'test' | 'panel'; readonly id: string }
//   export type PanelGraph = ReadonlyMap<string, readonly Member[]>        // panel id -> its members, already in sort_order
//   wouldCreateCycle(graph, panelId, members): boolean                     // would `panelId` with `members` (REPLACING its current ones) be on a cycle?
//   nestingDepth(graph, panelId, members?): number                         // panels on the longest downward chain starting at panelId (a panel of tests only = 1);
//                                                                          // `members` (optional) replaces panelId's own members; a cycle throws LimsError catalog.panel_cycle
//   depthThrough(graph, panelId, members): number                          // longest chain of panels that passes THROUGH panelId once its members are replaced
//                                                                          // (ancestors above + panelId + descendants below); a cycle throws catalog.panel_cycle
//   expandToTestIds(graph, root: Member): string[]                         // depth-first in member order, de-duplicated, first occurrence wins; a test root -> [id];
//                                                                          // an unknown / empty panel -> []; a cycle throws LimsError catalog.panel_cycle
// DEPTH UNIT (02-TRD §11: PANEL_MAX_DEPTH = 4 is "package -> panel -> panel -> test", i.e. levels INCLUDING the leaf test; reviewer T-12-review item 1):
// nestingDepth/depthThrough still count PANELS on a chain (a panel chain of n always ends in a test at level n + 1); the SERVICE rejects when
// depthThrough + 1 > PANEL_MAX_DEPTH, so at most 3 panels on a chain are allowed and a 4-panel chain is over the limit.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { PANEL_MAX_DEPTH, depthThrough, expandToTestIds, nestingDepth, wouldCreateCycle, type Member, type PanelGraph } from '../panelGraph.js';

const T = (id: string): Member => ({ kind: 'test', id });
const P = (id: string): Member => ({ kind: 'panel', id });
const graph = (o: Record<string, Member[]>): PanelGraph => new Map(Object.entries(o));
/** Panels p1 -> p2 -> … -> pN, the last one holding one test. */
const chain = (n: number, prefix = 'p'): PanelGraph => graph(Object.fromEntries(Array.from({ length: n }, (_v, i) => [`${prefix}${i + 1}`, i + 1 < n ? [P(`${prefix}${i + 2}`)] : [T('leaf')]])));
const cycleErr = (fn: () => unknown) => { try { fn(); } catch (e) { expect(isLimsError(e, 'catalog.panel_cycle'), String((e as Error)?.message)).toBe(true); return; } throw new Error('expected catalog.panel_cycle'); };

describe('PANEL_MAX_DEPTH', () => {
  it('is 4 (LIMS_CATALOG_PANEL_MAX_DEPTH default, 02-TRD §11 [CONV])', () => { expect(PANEL_MAX_DEPTH).toBe(4); });
});

describe('expandToTestIds — AC-07.1 / AC-07.2', () => {
  it('a test root expands to itself', () => { expect(expandToTestIds(graph({}), T('t1'))).toEqual(['t1']); });

  it('AC-07.1: package {CBC, LIPID, FBS} with LIPID {TC, HDL, TG, LDL} -> the 6 test ids in member order, each once', () => {
    const g = graph({ LIPID: [T('tc'), T('hdl'), T('tg'), T('ldl')], HP_ELITE_M: [T('cbc'), P('LIPID'), T('fbs')] });
    expect(expandToTestIds(g, P('HP_ELITE_M'))).toEqual(['cbc', 'tc', 'hdl', 'tg', 'ldl', 'fbs']);
  });

  it('depth-first in member order: a nested panel is expanded where it sits, not after its siblings', () => {
    const g = graph({ root: [T('a'), P('mid'), T('d')], mid: [T('b'), P('inner'), T('c')], inner: [T('x'), T('y')] });
    expect(expandToTestIds(g, P('root'))).toEqual(['a', 'b', 'x', 'y', 'c', 'd']);
  });

  it('AC-07.2: a test reachable twice (same panel listed twice in the tree, or via two paths) appears once, at its FIRST position', () => {
    const g = graph({ root: [T('a'), P('p1'), P('p2'), T('a')], p1: [T('b'), T('c')], p2: [T('c'), T('d')] });
    expect(expandToTestIds(g, P('root'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a diamond (two panels sharing one child panel) is NOT a cycle and de-duplicates the shared tests', () => {
    const g = graph({ top: [P('left'), P('right')], left: [P('shared')], right: [P('shared')], shared: [T('s1'), T('s2')] });
    expect(expandToTestIds(g, P('top'))).toEqual(['s1', 's2']);
  });

  it('an empty panel and a panel id missing from the graph expand to nothing', () => {
    expect(expandToTestIds(graph({ e: [] }), P('e'))).toEqual([]);
    expect(expandToTestIds(graph({}), P('ghost'))).toEqual([]);
    expect(expandToTestIds(graph({ r: [P('ghost'), T('t')] }), P('r'))).toEqual(['t']);
  });

  it('is deterministic and does not mutate the graph or the member arrays', () => {
    const lipid = Object.freeze([T('tc'), T('hdl')]) as Member[];
    const g = graph({ LIPID: lipid, pkg: Object.freeze([P('LIPID'), T('tc')]) as Member[] });
    const before = JSON.stringify([...g.entries()]);
    expect(expandToTestIds(g, P('pkg'))).toEqual(expandToTestIds(g, P('pkg')));
    expect(JSON.stringify([...g.entries()])).toBe(before);
  });

  it('defensive: stored cycles (self loop, 2-cycle, 3-cycle reached below the root) throw catalog.panel_cycle instead of looping', () => {
    cycleErr(() => expandToTestIds(graph({ a: [P('a')] }), P('a')));
    cycleErr(() => expandToTestIds(graph({ a: [P('b')], b: [P('a')] }), P('a')));
    cycleErr(() => expandToTestIds(graph({ root: [T('t'), P('a')], a: [P('b')], b: [P('c')], c: [P('a')] }), P('root')));
  });

  it('a very deep chain (5 000 panels) and a wide one (2 000 members) finish without a stack overflow', { timeout: 20_000 }, () => {
    expect(expandToTestIds(chain(5000), P('p1'))).toEqual(['leaf']);
    const wide = graph({ w: Array.from({ length: 2000 }, (_v, i) => T(`t${i}`)) });
    expect(expandToTestIds(wide, P('w'))).toHaveLength(2000);
  });
});

describe('wouldCreateCycle — AC-07.3', () => {
  it('AC-07.3: P1 contains P2; adding P1 into P2 -> true', () => {
    const g = graph({ P1: [P('P2')], P2: [T('t')] });
    expect(wouldCreateCycle(g, 'P2', [T('t'), P('P1')])).toBe(true);
  });
  it('a panel as a member of itself -> true', () => { expect(wouldCreateCycle(graph({ a: [] }), 'a', [P('a')])).toBe(true); });
  it('indirect cycles of length 3 and 5 -> true', () => {
    expect(wouldCreateCycle(graph({ a: [P('b')], b: [P('c')], c: [] }), 'c', [P('a')])).toBe(true);
    const g = graph({ a: [P('b')], b: [P('c')], c: [P('d')], d: [P('e')], e: [] });
    expect(wouldCreateCycle(g, 'e', [P('a')])).toBe(true);
    expect(wouldCreateCycle(g, 'e', [T('x'), P('c')])).toBe(true);
  });
  it('a new panel (not in the graph yet) can never close a cycle', () => { expect(wouldCreateCycle(graph({ a: [T('t')] }), 'fresh', [P('a'), T('x')])).toBe(false); });
  it('a diamond / a panel already reachable by another path is fine -> false', () => {
    const g = graph({ top: [P('l'), P('r')], l: [P('shared')], r: [], shared: [T('t')] });
    expect(wouldCreateCycle(g, 'r', [P('shared')])).toBe(false);
  });
  it('tests never form cycles, even when a test id equals a panel id string', () => {
    expect(wouldCreateCycle(graph({ a: [] }), 'a', [T('a')])).toBe(false);
  });
  it('the new members REPLACE the old ones: an edge that exists only in the old member list does not count', () => {
    const g = graph({ a: [P('b')], b: [P('a')] });                       // (already cyclic stored data)
    expect(wouldCreateCycle(g, 'a', [T('t')])).toBe(false);              // a no longer points at b, so b -> a -> t
    expect(wouldCreateCycle(g, 'b', [T('t')])).toBe(false);              // b no longer points at a, so a -> b -> t
    expect(wouldCreateCycle(g, 'b', [P('a')])).toBe(true);               // b -> a is kept/re-added and a -> b is still stored
  });
  it('does not mutate its inputs', () => {
    const g = graph({ P1: [P('P2')], P2: [T('t')] });
    const before = JSON.stringify([...g.entries()]);
    wouldCreateCycle(g, 'P2', [P('P1')]);
    expect(JSON.stringify([...g.entries()])).toBe(before);
  });
  it('a deep chain (5 000) is checked without a stack overflow', { timeout: 20_000 }, () => {
    const g = chain(5000);
    expect(wouldCreateCycle(g, 'p5000', [P('p1')])).toBe(true);
    expect(wouldCreateCycle(g, 'p5000', [T('x')])).toBe(false);
  });
});

describe('nestingDepth / depthThrough — AC-07.4', () => {
  it('a panel of tests only has depth 1; an empty panel has depth 1', () => {
    expect(nestingDepth(graph({ a: [T('t1'), T('t2')] }), 'a')).toBe(1);
    expect(nestingDepth(graph({ a: [] }), 'a')).toBe(1);
  });
  it('counts panels on the longest chain: 1, 2, 3, 4, 5', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(nestingDepth(chain(n), 'p1'), `chain ${n}`).toBe(n);
  });
  it('package -> panel -> panel -> test (the TRD example) has 3 panels = 4 levels with the leaf test = PANEL_MAX_DEPTH', () => {
    expect(nestingDepth(graph({ pkg: [P('lipid')], lipid: [P('sub')], sub: [T('t')] }), 'pkg')).toBe(3);
  });
  it('the longest branch wins when branches differ (and a diamond is not double counted)', () => {
    const g = graph({ top: [T('a'), P('short'), P('long1')], short: [T('b')], long1: [P('long2')], long2: [P('long3')], long3: [T('c')] });
    expect(nestingDepth(g, 'top')).toBe(4);
    expect(nestingDepth(graph({ top: [P('l'), P('r')], l: [P('s')], r: [P('s')], s: [T('t')] }), 'top')).toBe(3);
  });
  it('`members` replaces the panel\'s own members: nestingDepth(g, id, newMembers)', () => {
    const g = graph({ x: [T('t')], ...Object.fromEntries([...chain(3, 'q')]) });
    expect(nestingDepth(g, 'x', [P('q1')])).toBe(4);                      // x + q1,q2,q3
    expect(nestingDepth(g, 'x', [T('t')])).toBe(1);
    expect(nestingDepth(g, 'fresh', [P('q1')])).toBe(4);                  // a panel not in the graph yet
  });
  it('levels incl. the leaf test (panels + 1): the 3-panel chain (package -> panel -> panel -> test) is within PANEL_MAX_DEPTH, the 4-panel chain is over it', () => {
    expect(nestingDepth(chain(3), 'p1') + 1).toBeLessThanOrEqual(PANEL_MAX_DEPTH);
    expect(nestingDepth(chain(4), 'p1') + 1).toBeGreaterThan(PANEL_MAX_DEPTH);
  });
  it('depthThrough counts the ANCESTORS above the panel too (a short subtree under a deep parent chain is still too deep)', () => {
    const g = graph({ top: [P('mid')], mid: [P('leaf')], leaf: [T('t')], c1: [P('c2')], c2: [P('c3')], c3: [T('t')] });
    expect(depthThrough(g, 'leaf', [T('t')])).toBe(3);                    // top, mid, leaf
    expect(depthThrough(g, 'leaf', [P('c3')])).toBe(4);                   // top, mid, leaf, c3
    expect(depthThrough(g, 'leaf', [P('c1')])).toBe(6);                   // top, mid, leaf, c1, c2, c3
    expect(depthThrough(g, 'top', [P('mid')])).toBe(3);
  });
  it('depthThrough of a panel nobody contains equals its own nesting depth; of a fresh panel too', () => {
    const g = chain(3);
    expect(depthThrough(g, 'p1', [P('p2')])).toBe(3);
    expect(depthThrough(g, 'fresh', [P('p1')])).toBe(4);
  });
  it('depthThrough with several parents uses the deepest ancestor chain', () => {
    const g = graph({ a1: [P('a2')], a2: [P('x')], b1: [P('x')], x: [T('t')] });
    expect(depthThrough(g, 'x', [T('t')])).toBe(3);                       // a1, a2, x
  });
  it('cycles throw catalog.panel_cycle (no infinite loop)', () => {
    cycleErr(() => nestingDepth(graph({ a: [P('b')], b: [P('a')] }), 'a'));
    cycleErr(() => depthThrough(graph({ a: [P('b')], b: [] }), 'b', [P('a')]));
  });
  it('a 5 000-panel chain is measured without a stack overflow', { timeout: 20_000 }, () => {
    expect(nestingDepth(chain(5000), 'p1')).toBe(5000);
    expect(depthThrough(chain(5000), 'p2500', [P('p2501')])).toBe(5000);
  });
});
