// AN-T02 domain/scope.ts (02-TRD §4 `Scope`; PRD US-15.1–5, §8.3). Pure; no I/O.
// Assumed API:
//   Scope = { readonly all: boolean; readonly centreIds: readonly string[] }
//   intersect(a: Scope, b: Scope): Scope                 — all∩all = all; all∩S = S; S∩T = S∩T (deduped, order of `a`)
//   assertWithin(scope: Scope, requested: readonly string[]): void   — throws LimsError common.not_found (404) if any id is outside scope
import { describe, expect, it } from 'vitest';
import { assertWithin, intersect, type Scope } from '../scope.js';
import { expectLims } from './helpers.js';

const ALL: Scope = { all: true, centreIds: [] };
const only = (...ids: string[]): Scope => ({ all: false, centreIds: ids });
const A1 = '0192f0a0-0000-7000-8000-0000000000a1';
const A2 = '0192f0a0-0000-7000-8000-0000000000a2';
const B1 = '0192f0a0-0000-7000-8000-0000000000b1';
const C1 = '0192f0a0-0000-7000-8000-0000000000c1';

describe('intersect — effective scope (US-15.4: recipient ∩ schedule; US-15.5: snapshot ∩ current)', () => {
  it('all ∩ all = all', () => {
    expect(intersect(ALL, ALL).all).toBe(true);
  });
  it('all ∩ {A1} = {A1} and {A1} ∩ all = {A1} (never widens to all)', () => {
    for (const r of [intersect(ALL, only(A1)), intersect(only(A1), ALL)]) {
      expect(r.all).toBe(false);
      expect([...r.centreIds]).toEqual([A1]);
    }
  });
  it('{A1,A2} ∩ {A2,B1} = {A2}', () => {
    const r = intersect(only(A1, A2), only(A2, B1));
    expect(r.all).toBe(false);
    expect([...r.centreIds]).toEqual([A2]);
  });
  it('disjoint scopes give the EMPTY restricted scope (sees nothing), not all', () => {
    const r = intersect(only(A1), only(B1));
    expect(r.all).toBe(false);
    expect([...r.centreIds]).toEqual([]);
  });
  it('an empty restricted scope stays empty even against all', () => {
    const r = intersect(only(), ALL);
    expect(r.all).toBe(false);
    expect([...r.centreIds]).toEqual([]);
  });
  it('duplicates collapse; commutative as a set; associative', () => {
    const r = intersect(only(A1, A1, A2), only(A2, A2, A1));
    expect([...r.centreIds].sort()).toEqual([A1, A2].sort());
    expect(new Set(intersect(only(A1, A2), only(A2, C1)).centreIds)).toEqual(new Set(intersect(only(A2, C1), only(A1, A2)).centreIds));
    const l = intersect(intersect(only(A1, A2, B1), only(A2, B1, C1)), only(B1, C1));
    const r2 = intersect(only(A1, A2, B1), intersect(only(A2, B1, C1), only(B1, C1)));
    expect(new Set(l.centreIds)).toEqual(new Set(r2.centreIds));
  });
  it('does not mutate its inputs', () => {
    const a = only(A1, A2), b = only(A2, B1);
    const snap = JSON.stringify([a, b]);
    intersect(a, b);
    expect(JSON.stringify([a, b])).toBe(snap);
  });
});

describe('assertWithin — a centre_id outside the caller scope is 404 common.not_found (no existence oracle, US-15.2)', () => {
  it('all-centre callers may name any centre', () => {
    expect(() => assertWithin(ALL, [A1, B1, C1])).not.toThrow();
  });
  it('restricted callers may name their own centres, and an empty request is fine', () => {
    expect(() => assertWithin(only(A1, A2), [A1])).not.toThrow();
    expect(() => assertWithin(only(A1, A2), [A2, A1])).not.toThrow();
    expect(() => assertWithin(only(A1), [])).not.toThrow();
  });
  it('one foreign id among valid ones -> 404', () => {
    expectLims(() => assertWithin(only(A1, A2), [A1, B1]), 'common.not_found', 404);
  });
  it('a foreign id and a non-existent id are indistinguishable (same code, status and detail)', () => {
    const f = expectLims(() => assertWithin(only(A1), [B1]), 'common.not_found', 404) as Error & { detail?: string };
    const g = expectLims(() => assertWithin(only(A1), ['0192f0a0-0000-7000-8000-ffffffffffff']), 'common.not_found', 404) as Error & { detail?: string };
    expect(f.message).toBe(g.message);
    expect(f.detail).toBe(g.detail);
  });
  it('the error never echoes the foreign id', () => {
    const e = expectLims(() => assertWithin(only(A1), [B1]), 'common.not_found', 404) as Error & { detail?: string };
    expect(JSON.stringify({ m: e.message, d: e.detail, errors: (e as { errors?: unknown }).errors })).not.toContain(B1);
  });
  it('a restricted caller with an empty scope can name nothing', () => {
    expectLims(() => assertWithin(only(), [A1]), 'common.not_found', 404);
  });
  it('id comparison is exact: case and padding variants of an in-scope id are not in scope', () => {
    expectLims(() => assertWithin(only(A1), [A1.toUpperCase()]), 'common.not_found', 404);
    expectLims(() => assertWithin(only(A1), [`${A1} `]), 'common.not_found', 404);
  });
});
