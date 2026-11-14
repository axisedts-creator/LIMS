// C17 HC-T02 — visit state table (03-APP-FLOW §1.1 V1–V12). done_when: pure; every allowed + forbidden transition covered.
// Interface expected from the writer (../../domain/visit.state.ts) — SEAMS (spec fixes behaviour, not names):
//   export const VISIT_STATUSES: readonly VisitStatus[]   'unassigned'|'assigned'|'in_progress'|'completed'|'failed'|'cancelled'
//   export const CLOSED_VISIT_STATUSES: readonly VisitStatus[]   completed | failed | cancelled
//   export function isVisitTransitionAllowed(from: VisitStatus | null, to: VisitStatus): boolean   pure, no throw. null = no row yet (V1–V4).
//   export function assertVisitTransition(from: VisitStatus | null, to: VisitStatus): void
//        throws LimsError('homecollection.visit_closed') when `from` is closed (any target);
//        throws LimsError('homecollection.mutation_superseded') for in_progress -> unassigned (spec §1.1 Forbidden);
//        throws a LimsError (code left to the writer: the spec names none) for every other pair not in the table.
// V12 (in_progress|completed stay unchanged on a cancel attempt) is not a transition: it is not in the table.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { assertVisitTransition, CLOSED_VISIT_STATUSES, isVisitTransitionAllowed, VISIT_STATUSES } from '../../domain/visit.state.js';

type V = (typeof VISIT_STATUSES)[number];
const ALL = ['unassigned', 'assigned', 'in_progress', 'completed', 'failed', 'cancelled'] as V[];
const CLOSED = ['completed', 'failed', 'cancelled'] as V[];

/** 03-APP-FLOW §1.1 as data: [from, to, id]. Anything not listed must be forbidden. */
const ALLOWED: Array<[V | null, V, string]> = [
  [null, 'unassigned', 'V1-V4'],
  ['unassigned', 'assigned', 'V5'],
  ['assigned', 'assigned', 'V6 reassign'],
  ['assigned', 'unassigned', 'V7'],
  ['assigned', 'in_progress', 'V8'],
  ['in_progress', 'completed', 'V9'],
  ['assigned', 'failed', 'V10'],
  ['in_progress', 'failed', 'V10'],
  ['unassigned', 'cancelled', 'V11'],
  ['assigned', 'cancelled', 'V11'],
];
const key = (f: V | null, t: V): string => `${f ?? '∅'}>${t}`;
const allowedKeys = new Set(ALLOWED.map(([f, t]) => key(f, t)));
const FORBIDDEN: Array<[V | null, V]> = [];
for (const f of [null, ...ALL] as Array<V | null>) for (const t of ALL) if (!allowedKeys.has(key(f, t))) FORBIDDEN.push([f, t]);

const codeOf = (fn: () => void): string | undefined => {
  try { fn(); } catch (e) { expect(isLimsError(e)).toBe(true); return (e as { code: string }).code; }
  return undefined;
};

describe('VISIT_STATUSES', () => {
  it('is exactly the six statuses of homecollection.visits.status', () => {
    expect([...VISIT_STATUSES].sort()).toEqual([...ALL].sort());
  });
  it('closed set = completed | failed | cancelled', () => {
    expect([...CLOSED_VISIT_STATUSES].sort()).toEqual([...CLOSED].sort());
  });
});

describe('visit transitions — allowed (V1–V11)', () => {
  it.each(ALLOWED)('%s -> %s (%s) is allowed and does not throw', (from, to) => {
    expect(isVisitTransitionAllowed(from, to)).toBe(true);
    expect(() => assertVisitTransition(from, to)).not.toThrow();
  });
});

describe('visit transitions — forbidden', () => {
  it('table sanity: 10 allowed pairs, the other 53 of the 7x6 matrix are forbidden', () => {
    expect(ALLOWED).toHaveLength(10);
    expect(FORBIDDEN).toHaveLength(7 * 6 - 10);
  });
  it.each(FORBIDDEN)('%s -> %s is forbidden (predicate false, assert throws LimsError)', (from, to) => {
    expect(isVisitTransitionAllowed(from, to)).toBe(false);
    expect(codeOf(() => assertVisitTransition(from, to))).toBeDefined();
  });

  // spec §1.1 "Forbidden (unit-tested)" list, named
  it('cancelled -> assigned is forbidden (closed: homecollection.visit_closed)', () => {
    expect(codeOf(() => assertVisitTransition('cancelled', 'assigned'))).toBe('homecollection.visit_closed');
  });
  it('completed -> in_progress is forbidden (closed: homecollection.visit_closed)', () => {
    expect(codeOf(() => assertVisitTransition('completed', 'in_progress'))).toBe('homecollection.visit_closed');
  });
  it('failed -> assigned is forbidden (use V4 revisit; closed: homecollection.visit_closed)', () => {
    expect(codeOf(() => assertVisitTransition('failed', 'assigned'))).toBe('homecollection.visit_closed');
  });
  it('in_progress -> unassigned is forbidden with homecollection.mutation_superseded', () => {
    expect(codeOf(() => assertVisitTransition('in_progress', 'unassigned'))).toBe('homecollection.mutation_superseded');
  });
  it('unassigned -> in_progress is forbidden (D-126: pulled visits stay assigned)', () => {
    expect(isVisitTransitionAllowed('unassigned', 'in_progress')).toBe(false);
    expect(codeOf(() => assertVisitTransition('unassigned', 'in_progress'))).toBeDefined();
  });

  // "Closed = no transition out; any action -> 409 homecollection.visit_closed"
  it.each(CLOSED.flatMap((f) => ALL.map((t) => [f, t] as [V, V])))('closed %s -> %s answers homecollection.visit_closed', (from, to) => {
    expect(isVisitTransitionAllowed(from, to)).toBe(false);
    expect(codeOf(() => assertVisitTransition(from, to))).toBe('homecollection.visit_closed');
  });

  it('a row can only be created as unassigned (V1–V4): none -> any other status is forbidden', () => {
    for (const t of ALL.filter((s) => s !== 'unassigned')) expect(isVisitTransitionAllowed(null, t)).toBe(false);
  });
  it('one forbidden example per non-closed state: unassigned->completed, assigned->completed, in_progress->assigned, in_progress->cancelled', () => {
    for (const [f, t] of [['unassigned', 'completed'], ['assigned', 'completed'], ['in_progress', 'assigned'], ['in_progress', 'cancelled']] as Array<[V, V]>) {
      expect(isVisitTransitionAllowed(f, t)).toBe(false);
      expect(codeOf(() => assertVisitTransition(f, t))).toBeDefined();
    }
  });
});

describe('purity', () => {
  it('same inputs give same answers (no hidden state)', () => {
    for (const [f, t] of ALLOWED) { expect(isVisitTransitionAllowed(f, t)).toBe(isVisitTransitionAllowed(f, t)); }
    expect(isVisitTransitionAllowed('assigned', 'in_progress')).toBe(true);
  });
});
