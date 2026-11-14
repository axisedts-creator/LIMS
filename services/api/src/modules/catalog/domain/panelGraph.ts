// Panel graph: expansion, cycle and depth checks (02-TRD §7.7). Pure: no I/O, no clock, never mutates its inputs.
// Every walk is iterative (explicit stack) so a 5 000-deep chain cannot overflow the call stack.
// The helpers below count PANELS on a chain; the limit counts levels including the leaf test (02-TRD §11: package -> panel -> panel -> test = 4).
import { LimsError } from '../../../core/errors.js';

/** LIMS_CATALOG_PANEL_MAX_DEPTH default (02-TRD §11): levels incl. the leaf test, i.e. at most 3 panels on a chain. */
export const PANEL_MAX_DEPTH = 4;

export interface Member { readonly kind: 'test' | 'panel'; readonly id: string }
/** panel id -> its members, already in sort_order. */
export type PanelGraph = ReadonlyMap<string, readonly Member[]>;

const cycle = () => new LimsError('catalog.panel_cycle');
const NONE: readonly Member[] = [];

/** The graph with `panelId`'s members replaced by `members` (when given). */
const edgesOf = (graph: PanelGraph, panelId?: string, members?: readonly Member[]) =>
  (id: string): readonly Member[] => (members !== undefined && id === panelId ? members : graph.get(id) ?? NONE);

/** Longest chain of panels downward from `root`, `root` included. A cycle throws catalog.panel_cycle. */
function longestDown(children: (id: string) => readonly Member[], root: string): number {
  const memo = new Map<string, number>();
  const onPath = new Set<string>([root]);
  const stack = [{ id: root, kids: children(root), i: 0, best: 0 }];
  while (stack.length) {
    const f = stack[stack.length - 1]!;
    if (f.i >= f.kids.length) {
      stack.pop(); onPath.delete(f.id);
      const depth = 1 + f.best;
      memo.set(f.id, depth);
      const parent = stack[stack.length - 1];
      if (parent) parent.best = Math.max(parent.best, depth);
      continue;
    }
    const m = f.kids[f.i++]!;
    if (m.kind !== 'panel') continue;
    if (onPath.has(m.id)) throw cycle();
    const known = memo.get(m.id);
    if (known !== undefined) { f.best = Math.max(f.best, known); continue; }
    onPath.add(m.id);
    stack.push({ id: m.id, kids: children(m.id), i: 0, best: 0 });
  }
  return memo.get(root)!;
}

/** Would `panelId`, holding `members` instead of its current ones, be on a cycle? */
export function wouldCreateCycle(graph: PanelGraph, panelId: string, members: readonly Member[]): boolean {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const m of members) if (m.kind === 'panel') stack.push(m.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (id === panelId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const m of graph.get(id) ?? NONE) if (m.kind === 'panel') stack.push(m.id);
  }
  return false;
}

/** Panels on the longest downward chain starting at `panelId` (a panel of tests only = 1); `members` replaces its own members. */
export function nestingDepth(graph: PanelGraph, panelId: string, members?: readonly Member[]): number {
  return longestDown(edgesOf(graph, panelId, members), panelId);
}

/** Longest chain of panels passing THROUGH `panelId` once its members are replaced: ancestors above + itself + descendants below. */
export function depthThrough(graph: PanelGraph, panelId: string, members: readonly Member[]): number {
  const edges = edgesOf(graph, panelId, members);
  const parents = new Map<string, string[]>();
  const link = (from: string, ms: readonly Member[]) => {
    for (const m of ms) if (m.kind === 'panel') { const p = parents.get(m.id); if (p) p.push(from); else parents.set(m.id, [from]); }
  };
  for (const id of graph.keys()) if (id !== panelId) link(id, edges(id));
  link(panelId, members);
  const up = longestDown((id) => (parents.get(id) ?? []).map((p): Member => ({ kind: 'panel', id: p })), panelId);
  return up + longestDown(edges, panelId) - 1;
}

/** Test ids under `root`, depth-first in member order, de-duplicated (first occurrence wins). A cycle throws catalog.panel_cycle. */
export function expandToTestIds(graph: PanelGraph, root: Member): string[] {
  if (root.kind === 'test') return [root.id];
  const out: string[] = [];
  const seen = new Set<string>();
  const done = new Set<string>();
  const onPath = new Set<string>([root.id]);
  const stack = [{ id: root.id, kids: graph.get(root.id) ?? NONE, i: 0 }];
  while (stack.length) {
    const f = stack[stack.length - 1]!;
    if (f.i >= f.kids.length) { stack.pop(); onPath.delete(f.id); done.add(f.id); continue; }
    const m = f.kids[f.i++]!;
    if (m.kind === 'test') { if (!seen.has(m.id)) { seen.add(m.id); out.push(m.id); } continue; }
    if (onPath.has(m.id)) throw cycle();
    if (done.has(m.id)) continue;          // a diamond: already expanded, nothing new
    onPath.add(m.id);
    stack.push({ id: m.id, kids: graph.get(m.id) ?? NONE, i: 0 });
  }
  return out;
}

/** Every panel id reachable from the given roots (roots included). Cycle-safe. */
export function reachablePanels(graph: PanelGraph, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const m of graph.get(id) ?? NONE) if (m.kind === 'panel') stack.push(m.id);
  }
  return seen;
}
