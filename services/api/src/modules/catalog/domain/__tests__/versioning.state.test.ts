// C3 T-02 — versioning state machine (domain/versioning.state.ts). Spec: 03-APP-FLOW §2.1 (V1–V6 + forbidden row), 02-TRD §5.2 error columns.
// ACs: AC-03.2 (non-draft content change -> 409 catalog.version_in_use), AC-03.3 (effective_from < now-300 s -> 400 common.validation_failed /effective_from),
//      AC-03.4 (second draft -> 409 common.version_conflict), AC-13.4 (published price-list items immutable).
// Interface expected from the writer — SEAMS (spec fixes behaviour, not names):
//   export const VERSION_STATUSES: readonly VersionStatus[]   ['draft','published','superseded','retired','discarded']
//   export type VersionKind = 'analyte_version'|'reference_range_set'|'critical_limit_set'|'price_list_version'
//   export function versionTransition(from: VersionStatus|null, to: VersionStatus, kind: VersionKind): 'V1'|'V2'|'V3'|'V4'|'V5'|'V6'
//        pure; from===null = absent (V1). Throws LimsError('catalog.version_in_use') for everything not in the table
//        (02-TRD §5.2: publish/retire/discard/edit of a non-draft or non-published row all answer catalog.version_in_use).
//   export function isVersionTransitionAllowed(from, to, kind): boolean     same table, no throw
//   export function assertVersionEditable(status: VersionStatus): void     throws LimsError('catalog.version_in_use') unless 'draft' (content edits, V2 guard)
//   export function assertCanCreateDraft(siblingStatuses: readonly VersionStatus[]): void   throws LimsError('common.version_conflict') if any sibling is 'draft' (V1 guard)
//   export function assertEffectiveWindow(o: { effectiveFrom: Date; now: Date; toleranceSeconds?: number /*default 300*/; path?: string /*default '/effective_from'*/;
//        siblings?: readonly { status: VersionStatus; effectiveFrom: Date; effectiveTo?: Date|null }[] }): void
//        throws LimsError('common.validation_failed') with errors[0].path = path. Rules (V4/V6): effectiveFrom >= now - tolerance (boundary inclusive);
//        and, over siblings with status published|superseded|retired only (draft/discarded ignored): effectiveFrom > max(sibling.effectiveFrom);
//        and for a retired sibling with effectiveTo: effectiveFrom >= its effectiveTo. Invalid Date -> validation_failed.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import {
  assertCanCreateDraft, assertEffectiveWindow, assertVersionEditable, isVersionTransitionAllowed, VERSION_STATUSES,
  versionTransition, type VersionKind,
} from '../versioning.state.js';

type S = (typeof VERSION_STATUSES)[number];
const KINDS: VersionKind[] = ['analyte_version', 'reference_range_set', 'critical_limit_set', 'price_list_version'];
const RETIRABLE: VersionKind[] = ['reference_range_set', 'critical_limit_set'];

/** 03-APP-FLOW §2.1 as data: [from, to, id]. `retire` is only for RETIRABLE kinds. */
const TABLE: Array<[S | null, S, string]> = [
  [null, 'draft', 'V1'],
  ['draft', 'draft', 'V2'],
  ['draft', 'discarded', 'V3'],
  ['draft', 'published', 'V4'],
  ['published', 'superseded', 'V5'],
];
const RETIRE: [S, S, string] = ['published', 'retired', 'V6'];

const allowed = (f: S | null, t: S, k: VersionKind): string | undefined => {
  const hit = TABLE.find(([a, b]) => a === f && b === t);
  if (hit) return hit[2];
  return RETIRABLE.includes(k) && f === RETIRE[0] && t === RETIRE[1] ? RETIRE[2] : undefined;
};
const FROMS: Array<S | null> = [null, ...VERSION_STATUSES];

const catchErr = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } return undefined; };

describe('versionTransition — exhaustive matrix (done_when: 100 % branch coverage of the table)', () => {
  it('statuses are exactly the five of the schema', () => {
    expect([...VERSION_STATUSES].sort()).toEqual(['discarded', 'draft', 'published', 'retired', 'superseded']);
  });

  describe.each(KINDS)('kind %s', (kind) => {
    for (const from of FROMS) {
      for (const to of VERSION_STATUSES) {
        const id = allowed(from, to, kind);
        const label = `${from ?? '∅'} -> ${to}`;
        if (id) {
          it(`ALLOWED ${label} = ${id}`, () => {
            expect(versionTransition(from, to, kind)).toBe(id);
            expect(isVersionTransitionAllowed(from, to, kind)).toBe(true);
          });
        } else {
          it(`FORBIDDEN ${label} -> 409 catalog.version_in_use`, () => {
            const e = catchErr(() => versionTransition(from, to, kind));
            expect(isLimsError(e, 'catalog.version_in_use')).toBe(true);
            expect((e as { statusCode: number }).statusCode).toBe(409);
            expect(isVersionTransitionAllowed(from, to, kind)).toBe(false);
          });
        }
      }
    }
  });

  it('allowed set has exactly 5 pairs for non-retirable kinds and 6 for range/critical sets', () => {
    const count = (k: VersionKind) => FROMS.flatMap((f) => VERSION_STATUSES.map((t) => [f, t] as const)).filter(([f, t]) => isVersionTransitionAllowed(f, t, k)).length;
    expect(count('analyte_version')).toBe(5);
    expect(count('price_list_version')).toBe(5);
    expect(count('reference_range_set')).toBe(6);
    expect(count('critical_limit_set')).toBe(6);
  });

  it('named forbidden examples from the spec', () => {
    // published/superseded/retired/discarded -> draft
    for (const f of ['published', 'superseded', 'retired', 'discarded'] as const) expect(isVersionTransitionAllowed(f, 'draft', 'analyte_version')).toBe(false);
    // retire of an analyte version / price-list version is forbidden (use a new version / deactivate the list)
    expect(isVersionTransitionAllowed('published', 'retired', 'analyte_version')).toBe(false);
    expect(isVersionTransitionAllowed('published', 'retired', 'price_list_version')).toBe(false);
    expect(isVersionTransitionAllowed('published', 'retired', 'reference_range_set')).toBe(true);
    // superseded/retired/discarded are terminal
    for (const f of ['superseded', 'retired', 'discarded'] as const) for (const t of VERSION_STATUSES) expect(isVersionTransitionAllowed(f, t, 'reference_range_set')).toBe(false);
    // published cannot be discarded or go back; a draft cannot be superseded or retired directly
    expect(isVersionTransitionAllowed('published', 'discarded', 'analyte_version')).toBe(false);
    expect(isVersionTransitionAllowed('draft', 'superseded', 'analyte_version')).toBe(false);
    expect(isVersionTransitionAllowed('draft', 'retired', 'reference_range_set')).toBe(false);
  });

  it('adversarial: unknown strings / bad kind never count as allowed', () => {
    const bad = ['', 'Draft', 'DRAFT', 'publish', '__proto__', 'constructor', 'toString', 'hasOwnProperty'] as unknown as S[];
    for (const b of bad) {
      expect(isVersionTransitionAllowed(b, 'draft', 'analyte_version')).toBe(false);
      expect(isVersionTransitionAllowed('draft', b, 'analyte_version')).toBe(false);
      expect(isLimsError(catchErr(() => versionTransition(b, 'published', 'analyte_version')), 'catalog.version_in_use')).toBe(true);
    }
    expect(isVersionTransitionAllowed('published', 'retired', 'bogus' as VersionKind)).toBe(false);
    expect(isVersionTransitionAllowed('published', 'retired', '__proto__' as VersionKind)).toBe(false);
  });
});

describe('assertVersionEditable — AC-03.2 / AC-13.4', () => {
  it('draft is editable', () => { expect(() => assertVersionEditable('draft')).not.toThrow(); });
  it.each(['published', 'superseded', 'retired', 'discarded'] as const)('%s -> 409 catalog.version_in_use', (s) => {
    const e = catchErr(() => assertVersionEditable(s));
    expect(isLimsError(e, 'catalog.version_in_use')).toBe(true);
    expect((e as { statusCode: number }).statusCode).toBe(409);
  });
  it('unknown status fails closed', () => {
    for (const s of ['', 'Draft', 'x', undefined, null] as unknown as S[]) expect(isLimsError(catchErr(() => assertVersionEditable(s)), 'catalog.version_in_use')).toBe(true);
  });
});

describe('assertCanCreateDraft — AC-03.4 (one open draft per parent)', () => {
  it('no siblings / only closed siblings -> ok', () => {
    expect(() => assertCanCreateDraft([])).not.toThrow();
    expect(() => assertCanCreateDraft(['published', 'superseded', 'retired', 'discarded'])).not.toThrow();
  });
  it.each([['draft'], ['published', 'draft'], ['draft', 'draft'], ['discarded', 'superseded', 'draft']] as S[][])('with a draft among %j -> 409 common.version_conflict', (...siblings) => {
    const e = catchErr(() => assertCanCreateDraft(siblings));
    expect(isLimsError(e, 'common.version_conflict')).toBe(true);
    expect((e as { statusCode: number }).statusCode).toBe(409);
  });
});

describe('assertEffectiveWindow — AC-03.3 (no back-dating) + V4/V6 window rules', () => {
  const now = new Date('2026-11-07T10:00:00.000Z');
  const at = (ms: number) => new Date(now.getTime() + ms);
  const bad = (o: Parameters<typeof assertEffectiveWindow>[0], path = '/effective_from') => {
    const e = catchErr(() => assertEffectiveWindow(o));
    expect(isLimsError(e, 'common.validation_failed')).toBe(true);
    expect((e as { statusCode: number }).statusCode).toBe(400);
    expect((e as { errors?: Array<{ path: string }> }).errors?.[0]?.path).toBe(path);
  };

  it('now, future and exactly now-300 s (boundary, inclusive) are accepted with the default tolerance', () => {
    for (const ms of [0, 1, 86_400_000, -300_000]) expect(() => assertEffectiveWindow({ effectiveFrom: at(ms), now })).not.toThrow();
  });
  it('AC-03.3: now-300 s-1 ms is rejected at /effective_from', () => {
    bad({ effectiveFrom: at(-300_001), now });
    bad({ effectiveFrom: new Date('2020-01-01T00:00:00Z'), now });
  });
  it('tolerance is configurable (0 and 600 s) and bounds move with it', () => {
    expect(() => assertEffectiveWindow({ effectiveFrom: at(0), now, toleranceSeconds: 0 })).not.toThrow();
    bad({ effectiveFrom: at(-1), now, toleranceSeconds: 0 });
    expect(() => assertEffectiveWindow({ effectiveFrom: at(-600_000), now, toleranceSeconds: 600 })).not.toThrow();
    bad({ effectiveFrom: at(-600_001), now, toleranceSeconds: 600 });
  });
  it('path override (V6 retire uses /effective_at)', () => {
    bad({ effectiveFrom: at(-301_000), now, path: '/effective_at' }, '/effective_at');
    expect(() => assertEffectiveWindow({ effectiveFrom: at(0), now, path: '/effective_at' })).not.toThrow();
  });
  it('invalid Date fails closed', () => {
    bad({ effectiveFrom: new Date('nope'), now });
  });

  describe('sibling rules (V4)', () => {
    const t0 = new Date('2026-11-07T12:00:00.000Z'); // future-dated predecessors
    const sib = (status: S, from: Date, to?: Date | null) => ({ status, effectiveFrom: from, effectiveTo: to ?? null });
    it('must be strictly after the latest published/superseded/retired sibling effective_from', () => {
      for (const s of ['published', 'superseded', 'retired'] as const) {
        bad({ effectiveFrom: t0, now, siblings: [sib(s, t0)] }); // equal -> rejected (strict)
        bad({ effectiveFrom: new Date(t0.getTime() - 1), now, siblings: [sib(s, t0)] });
        expect(() => assertEffectiveWindow({ effectiveFrom: new Date(t0.getTime() + 1), now, siblings: [sib(s, t0)] })).not.toThrow();
      }
    });
    it('uses the MAX effective_from over all siblings, not the first or last in the array', () => {
      const sibs = [sib('superseded', at(1000)), sib('published', t0), sib('retired', at(2000))];
      bad({ effectiveFrom: new Date(t0.getTime() - 1), now, siblings: sibs });
      expect(() => assertEffectiveWindow({ effectiveFrom: new Date(t0.getTime() + 1), now, siblings: sibs })).not.toThrow();
    });
    it('draft and discarded siblings are ignored', () => {
      const far = new Date('2030-01-01T00:00:00Z');
      expect(() => assertEffectiveWindow({ effectiveFrom: at(0), now, siblings: [sib('draft', far), sib('discarded', far)] })).not.toThrow();
    });
    it('a retired sibling with effective_to: new effective_from must be >= that effective_to (no overlap with the retired window)', () => {
      const from = at(10_000), to = at(60_000);
      const retired = sib('retired', from, to);
      bad({ effectiveFrom: at(59_999), now, siblings: [retired] });
      expect(() => assertEffectiveWindow({ effectiveFrom: to, now, siblings: [retired] })).not.toThrow();
      expect(() => assertEffectiveWindow({ effectiveFrom: at(60_001), now, siblings: [retired] })).not.toThrow();
    });
    it('empty / absent siblings only apply the tolerance rule', () => {
      expect(() => assertEffectiveWindow({ effectiveFrom: at(0), now, siblings: [] })).not.toThrow();
    });
  });
});
