// C17 HC-T02 — collection state table (03-APP-FLOW §1.2 C1–C4). done_when: pure; every allowed + forbidden transition covered.
// Interface expected from the writer (../../domain/collection.state.ts) — SEAMS:
//   export const COLLECTION_STATUSES: readonly CollectionStatus[]   'applied'|'held'|'discarded'
//   export function isCollectionTransitionAllowed(from: CollectionStatus | null, to: CollectionStatus): boolean   null = no row (C1/C2)
//   export function assertCollectionTransition(from, to): void
//        applied -> * and discarded -> * throw LimsError('homecollection.collection_not_held') (spec §1.2 "Forbidden");
//        any other pair not in the table throws a LimsError (code not named by the spec — writer's choice).
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { assertCollectionTransition, COLLECTION_STATUSES, isCollectionTransitionAllowed } from '../../domain/collection.state.js';

type C = (typeof COLLECTION_STATUSES)[number];
const ALL = ['applied', 'held', 'discarded'] as C[];
const ALLOWED: Array<[C | null, C, string]> = [
  [null, 'applied', 'C1'],
  [null, 'held', 'C2'],
  ['held', 'applied', 'C3'],
  ['held', 'discarded', 'C4'],
];
const k = (f: C | null, t: C): string => `${f ?? '∅'}>${t}`;
const okKeys = new Set(ALLOWED.map(([f, t]) => k(f, t)));
const FORBIDDEN: Array<[C | null, C]> = [];
for (const f of [null, ...ALL] as Array<C | null>) for (const t of ALL) if (!okKeys.has(k(f, t))) FORBIDDEN.push([f, t]);

const codeOf = (fn: () => void): string | undefined => {
  try { fn(); } catch (e) { expect(isLimsError(e)).toBe(true); return (e as { code: string }).code; }
  return undefined;
};

describe('COLLECTION_STATUSES', () => {
  it('is applied | held | discarded', () => expect([...COLLECTION_STATUSES].sort()).toEqual([...ALL].sort()));
});

describe('collection transitions — allowed', () => {
  it.each(ALLOWED)('%s -> %s (%s)', (from, to) => {
    expect(isCollectionTransitionAllowed(from, to)).toBe(true);
    expect(() => assertCollectionTransition(from, to)).not.toThrow();
  });
});

describe('collection transitions — forbidden', () => {
  it('table sanity: 4 allowed, 5 forbidden of the 4x3 matrix', () => {
    expect(ALLOWED).toHaveLength(4);
    expect(FORBIDDEN).toHaveLength(4 * 3 - 4);
  });
  it.each(FORBIDDEN)('%s -> %s is forbidden', (from, to) => {
    expect(isCollectionTransitionAllowed(from, to)).toBe(false);
    expect(codeOf(() => assertCollectionTransition(from, to))).toBeDefined();
  });
  it.each(['applied', 'discarded'].flatMap((f) => ALL.map((t) => [f, t] as [C, C])))('%s -> %s answers homecollection.collection_not_held', (from, to) => {
    expect(isCollectionTransitionAllowed(from, to)).toBe(false);
    expect(codeOf(() => assertCollectionTransition(from, to))).toBe('homecollection.collection_not_held');
  });
  it('a held collection cannot be created directly as discarded', () => {
    expect(isCollectionTransitionAllowed(null, 'discarded')).toBe(false);
  });
  it('held -> held (re-review that changes nothing) is forbidden', () => {
    expect(isCollectionTransitionAllowed('held', 'held')).toBe(false);
  });
});
