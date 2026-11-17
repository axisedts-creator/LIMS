// C3 T-06 — orderable search ranking + LIKE escaping (domain/orderableSearch.ts).
// Spec: 02-TRD §7.9 ("q normalised (trim, upper-case for code comparison, %/_/\ escaped). Rank: exact code = 0, code prefix = 1, name prefix = 2,
//       name contains = 3; then length(code), code"), PRD AC-08.1 (code prefix ranks before name matches), AC-08.2 (% and _ matched literally),
//       07-SECURITY REQ-SEC-082 / S-12 (LIKE/ILIKE escaping).
// Interface expected from the writer (spec fixes behaviour, not names) — SEAMS (also in .orchestra/notes/T-06-tests.md):
//   export function escapeLike(s: string): string
//        backslash-escapes `\`, `%`, `_` (in that order of safety: the escape char itself first) so the result is a literal LIKE/ILIKE
//        operand for `ESCAPE '\'`. Nothing else is touched.
//   export function rankOf(row: { code: string; name: string }, q: string): 0 | 1 | 2 | 3 | undefined
//        q is trimmed; code comparison is upper-case; name comparison is case-insensitive; undefined = not a candidate (code is matched as a
//        PREFIX only, never as a substring; name as prefix or substring). The best (lowest) applicable rank wins.
//   export function rankOrderables<T extends { code: string; name: string }>(rows: readonly T[], q: string, limit: number): T[]
//        drops non-candidates, orders by rank, then length(code), then code (code-point order), then returns the first `limit`. Pure: does not
//        mutate `rows`, result independent of input order (codes are unique per tenant).
import { describe, expect, it } from 'vitest';
import { escapeLike, rankOf, rankOrderables } from '../orderableSearch.js';

const R = (code: string, name: string) => ({ code, name });

describe('escapeLike (REQ-SEC-082, AC-08.2)', () => {
  it.each([
    ['plain', 'plain'], ['100%', '100\\%'], ['a_b', 'a\\_b'], ['a\\b', 'a\\\\b'], ['%_\\', '\\%\\_\\\\'], ['', ''], ["o'brien", "o'brien"],
    ['\\%', '\\\\\\%'],                                   // an already-escaped looking input is escaped again, never trusted
  ])('%j -> %j', (input, expected) => { expect(escapeLike(input)).toBe(expected); });

  it('is injective and round-trips through an unescape (no input can smuggle a wildcard)', () => {
    const unescape = (s: string) => s.replace(/\\([\\%_])/g, '$1');
    for (const s of ['%', '_', '\\', '\\%', '%%', '\\\\', 'a%b_c\\d', '100% _x\\', '%_%_']) {
      const e = escapeLike(s);
      expect(unescape(e)).toBe(s);
      expect(e.replace(/\\[\\%_]/g, '')).not.toMatch(/[%_\\]/);   // every special char in the output is part of an escape pair
    }
  });
});

describe('rankOf (§7.9)', () => {
  it('exact code = 0, code prefix = 1, name prefix = 2, name contains = 3, no match = undefined', () => {
    expect(rankOf(R('CBC', 'Complete blood count'), 'cbc')).toBe(0);
    expect(rankOf(R('CBCD', 'Complete blood count + diff'), 'cbc')).toBe(1);
    expect(rankOf(R('HB1', 'CBC profile'), 'cbc')).toBe(2);
    expect(rankOf(R('ZZ', 'Basic CBC set'), 'cbc')).toBe(3);
    expect(rankOf(R('XCBC', 'Other'), 'cbc')).toBeUndefined();     // code is prefix-only
    expect(rankOf(R('A', 'Other'), 'cbc')).toBeUndefined();
  });

  it('the best applicable rank wins (code prefix beats a name match on the same row)', () => {
    expect(rankOf(R('CBCD', 'CBC with diff'), 'cbc')).toBe(1);
    expect(rankOf(R('CBC', 'CBC'), 'cbc')).toBe(0);
    expect(rankOf(R('Q1', 'cbc cbc'), 'cbc')).toBe(2);
  });

  it('q is trimmed; code match is on the upper-cased q; name match ignores case', () => {
    expect(rankOf(R('CBC', 'x'), '  cbc \t')).toBe(0);
    expect(rankOf(R('CBC', 'x'), 'CbC')).toBe(0);
    expect(rankOf(R('Q', 'Complete Blood Count'), 'BLOOD')).toBe(3);
    expect(rankOf(R('Q', 'complete blood count'), 'COMPLETE')).toBe(2);
  });

  it('wildcards and regex characters are literal (AC-08.2)', () => {
    expect(rankOf(R('A1', '100% pure'), '%')).toBe(3);
    expect(rankOf(R('A2', 'Alpha'), '%')).toBeUndefined();
    expect(rankOf(R('A3', 'Alpha_beta'), '_')).toBe(3);
    expect(rankOf(R('A4', 'AlphaXbeta'), '_')).toBeUndefined();
    expect(rankOf(R('A5', 'Alpha_beta'), 'alpha_b')).toBe(2);
    expect(rankOf(R('A6', 'AlphaXbeta'), 'alpha_b')).toBeUndefined();
    expect(rankOf(R('A7', 'back\\slash'), '\\')).toBe(3);
    expect(rankOf(R('A8', 'Alpha'), '\\')).toBeUndefined();
    expect(rankOf(R('A9', 'Alpha'), '.*')).toBeUndefined();
    expect(rankOf(R('B1', 'x'), '(')).toBeUndefined();
    expect(rankOf(R('A_B', 'x'), 'a_')).toBe(1);
    expect(rankOf(R('AXB', 'x'), 'a_')).toBeUndefined();
    expect(rankOf(R('A-B+C.D', 'x'), 'a-b+')).toBe(1);
  });
});

describe('rankOrderables (§7.9, AC-08.1)', () => {
  const rows = [
    R('ZZ', 'Basic CBC set'), R('CBCD', 'Diff'), R('HB1', 'CBC profile'), R('CBC', 'Complete blood count'), R('CBCX1', 'x'),
    R('XCBC', 'no match'), R('CBCB', 'b'), R('CBCA', 'a'), R('NAME2', 'cbc later'),
  ];
  const ORDER = ['CBC', 'CBCA', 'CBCB', 'CBCD', 'CBCX1', 'HB1', 'NAME2', 'ZZ'];

  it('exact code, then code prefix (shorter code first, then code), then name prefix, then name contains; non-candidates dropped', () => {
    expect(rankOrderables(rows, 'cbc', 50).map((r) => r.code)).toEqual(ORDER);
  });

  it('inside one rank the order is length(code) then code, not name or input order', () => {
    const got = rankOrderables([R('CBCAA', 'z'), R('CBCB', 'a'), R('CBCA', 'm')], 'CBC', 10).map((r) => r.code);
    expect(got).toEqual(['CBCA', 'CBCB', 'CBCAA']);
  });

  it('result does not depend on input order', () => {
    const rev = [...rows].reverse();
    const rot = [...rows.slice(3), ...rows.slice(0, 3)];
    for (const input of [rev, rot]) expect(rankOrderables(input, 'cbc', 50).map((r) => r.code)).toEqual(ORDER);
  });

  it('limit applies AFTER ranking (a rank-0 row late in code order is never cut)', () => {
    const many = Array.from({ length: 60 }, (_, i) => R(`K${String(i).padStart(2, '0')}`, `n${i}`));
    const all = [...many, R('K', 'exact'), R('ZZZ', 'has k inside')];
    expect(rankOrderables(all, 'k', 3).map((r) => r.code)).toEqual(['K', 'K00', 'K01']);
    expect(rankOrderables(all, 'k', 100)).toHaveLength(62);
    expect(rankOrderables(all, 'k', 100).at(-1)!.code).toBe('ZZZ');
  });

  it('does not mutate its input; limit 0 -> empty; empty input -> empty', () => {
    const copy = JSON.stringify(rows);
    rankOrderables(rows, 'cbc', 5);
    expect(JSON.stringify(rows)).toBe(copy);
    expect(rankOrderables(rows, 'cbc', 0)).toEqual([]);
    expect(rankOrderables([], 'cbc', 5)).toEqual([]);
  });

  it('returns the original row objects (extra fields survive)', () => {
    const row = { code: 'CBC', name: 'x', id: 'keep-me' };
    expect(rankOrderables([row], 'cbc', 5)[0]).toBe(row);
  });

  it('literal wildcard queries through the whole pipeline', () => {
    const w = [R('A1', '100% pure'), R('A2', 'Alpha'), R('A3', 'Alpha_beta'), R('A4', 'AlphaXbeta')];
    expect(rankOrderables(w, '%', 20).map((r) => r.code)).toEqual(['A1']);
    expect(rankOrderables(w, '_', 20).map((r) => r.code)).toEqual(['A3']);
    expect(rankOrderables(w, 'alpha_', 20).map((r) => r.code)).toEqual(['A3']);
  });
});
