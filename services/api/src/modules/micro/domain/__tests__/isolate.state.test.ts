// C10-T02 isolate.state.ts (03-APP-FLOW §2.2 I1–I4 and §2.4 instrument record IR1–IR6).
// The plan lists only three files, so the instrument-record table (§2.4) lives here too (assumption — flagged in notes).
// Assumed API:
//   ISOLATE_STATUSES, RECORD_STATUSES
//   initialIsolateStatus({ cultureStatus, organismId? }): 'identified' | 'pending_id'   (I1; throws micro.culture_invalid_transition when culture not in incubating/growth_detected/amending)
//   nextIsolateStatus(from, action: 'identify' | 'withdraw'): IsolateStatus               (I2–I4; throws micro.isolate_invalid_transition)
//   assertAstPanelAssignable(status): only 'identified' else micro.isolate_invalid_transition
//   canRecordTransition(from: RecordStatus | null, to, trigger: 'consume'|'assign'|'apply'|'ignore', resolution?: 'use_instrument'|'keep_existing'): boolean
//   assertRecordTransition(...same args): void   throws micro.instrument_record_conflict (409)
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import {
  ISOLATE_STATUSES, RECORD_STATUSES, assertAstPanelAssignable, assertRecordTransition, canRecordTransition,
  initialIsolateStatus, nextIsolateStatus,
} from '../isolate.state.js';

const bad = (f: () => unknown, code: string) => {
  try { f(); } catch (e) { expect(e).toBeInstanceOf(LimsError); expect((e as LimsError).code).toBe(code); return; }
  throw new Error(`expected ${code}`);
};

describe('isolate state table', () => {
  it('has exactly the three DB states', () => expect([...ISOLATE_STATUSES].sort()).toEqual(['identified', 'pending_id', 'withdrawn']));

  describe('I1 create', () => {
    it.each(['incubating', 'growth_detected', 'amending'])('%s + organism -> identified', (cultureStatus) =>
      expect(initialIsolateStatus({ cultureStatus, organismId: 'org-1' } as never)).toBe('identified'));
    it.each(['incubating', 'growth_detected', 'amending'])('%s without organism -> pending_id', (cultureStatus) =>
      expect(initialIsolateStatus({ cultureStatus } as never)).toBe('pending_id'));
    it('forbidden: awaiting_setup (no plates yet) -> micro.culture_invalid_transition', () =>
      bad(() => initialIsolateStatus({ cultureStatus: 'awaiting_setup', organismId: 'org-1' } as never), 'micro.culture_invalid_transition'));
    it('forbidden: cancelled -> micro.culture_invalid_transition', () =>
      bad(() => initialIsolateStatus({ cultureStatus: 'cancelled' } as never), 'micro.culture_invalid_transition'));
    it('forbidden: final_submitted -> micro.report_final_locked', () =>
      bad(() => initialIsolateStatus({ cultureStatus: 'final_submitted' } as never), 'micro.report_final_locked'));
  });

  it('I2 identify: pending_id -> identified', () => expect(nextIsolateStatus('pending_id', 'identify')).toBe('identified'));
  it('I3 re-identify: identified -> identified', () => expect(nextIsolateStatus('identified', 'identify')).toBe('identified'));
  it.each(['pending_id', 'identified'] as const)('I4 withdraw from %s -> withdrawn', (s) => expect(nextIsolateStatus(s, 'withdraw')).toBe('withdrawn'));
  it.each(['identify', 'withdraw'] as const)('forbidden: withdrawn -> any via %s -> micro.isolate_invalid_transition', (a) =>
    bad(() => nextIsolateStatus('withdrawn', a), 'micro.isolate_invalid_transition'));
  it('forbidden: withdraw twice maps to HTTP 409', () => { try { nextIsolateStatus('withdrawn', 'withdraw'); } catch (e) { expect((e as LimsError).statusCode).toBe(409); } });

  describe('assignAstPanel requires identified', () => {
    it('identified ok', () => expect(() => assertAstPanelAssignable('identified')).not.toThrow());
    it.each(['pending_id', 'withdrawn'])('%s -> micro.isolate_invalid_transition', (s) => bad(() => assertAstPanelAssignable(s as never), 'micro.isolate_invalid_transition'));
  });

  it('rejects unknown / prototype statuses', () => {
    bad(() => nextIsolateStatus('__proto__' as never, 'identify'), 'micro.isolate_invalid_transition');
    bad(() => nextIsolateStatus('identified', 'constructor' as never), 'micro.isolate_invalid_transition');
  });
});

describe('instrument record state table (§2.4)', () => {
  type R = 'pending_match' | 'needs_mapping' | 'conflict' | 'late_after_final' | 'applied' | 'ignored';
  const ALL: R[] = ['pending_match', 'needs_mapping', 'conflict', 'late_after_final', 'applied', 'ignored'];
  const TRIGGERS = ['consume', 'assign', 'apply', 'ignore'] as const;
  const RES = [undefined, 'use_instrument', 'keep_existing'] as const;

  // [from, to, trigger, resolution] — every allowed edge. Everything else is forbidden.
  const ALLOWED: [R | null, R, string, string | undefined][] = [
    ...ALL.map((to): [null, R, string, undefined] => [null, to, 'consume', undefined]), // IR1
    ...(['applied', 'needs_mapping', 'conflict', 'late_after_final'] as R[]).map((to): [R, R, string, undefined] => ['pending_match', to, 'assign', undefined]), // IR2
    ...(['needs_mapping', 'late_after_final', 'pending_match'] as R[]).flatMap((from) =>
      (['applied', 'conflict', 'needs_mapping'] as R[]).map((to): [R, R, string, undefined] => [from, to, 'apply', undefined])), // IR3
    ['conflict', 'applied', 'apply', 'use_instrument'], ['conflict', 'applied', 'assign', 'use_instrument'], // IR4
    ['conflict', 'ignored', 'apply', 'keep_existing'], ['conflict', 'ignored', 'assign', 'keep_existing'], // IR5
    ...(['pending_match', 'needs_mapping', 'conflict', 'late_after_final'] as R[]).map((from): [R, R, string, undefined] => [from, 'ignored', 'ignore', undefined]), // IR6
  ];
  const allowed = (f: R | null, t: R, tr: string, r: string | undefined) => ALLOWED.some((a) => a[0] === f && a[1] === t && a[2] === tr && a[3] === r);

  it('has exactly the six DB states', () => expect([...RECORD_STATUSES].sort()).toEqual([...ALL].sort()));

  it('IR1 consume: null -> each of the six', () => ALL.forEach((to) => expect(canRecordTransition(null, to, 'consume')).toBe(true)));
  it('IR2 assign: pending_match -> applied/needs_mapping/conflict/late_after_final', () =>
    (['applied', 'needs_mapping', 'conflict', 'late_after_final'] as R[]).forEach((to) => expect(canRecordTransition('pending_match', to, 'assign')).toBe(true)));
  it.each(['needs_mapping', 'late_after_final', 'pending_match'] as R[])('IR3 apply from %s -> applied/conflict/needs_mapping', (from) =>
    (['applied', 'conflict', 'needs_mapping'] as R[]).forEach((to) => expect(canRecordTransition(from, to, 'apply')).toBe(true)));
  it.each(['apply', 'assign'] as const)('IR4 conflict -> applied via %s + use_instrument', (t) => expect(canRecordTransition('conflict', 'applied', t, 'use_instrument')).toBe(true));
  it.each(['apply', 'assign'] as const)('IR5 conflict -> ignored via %s + keep_existing', (t) => expect(canRecordTransition('conflict', 'ignored', t, 'keep_existing')).toBe(true));
  it.each(['pending_match', 'needs_mapping', 'conflict', 'late_after_final'] as R[])('IR6 ignore from %s -> ignored', (from) => expect(canRecordTransition(from, 'ignored', 'ignore')).toBe(true));

  // Complete cross product: from × to × trigger × resolution.
  const froms: (R | null)[] = [null, ...ALL];
  const cases = froms.flatMap((f) => ALL.flatMap((t) => TRIGGERS.flatMap((tr) => RES.map((r) => [f, t, tr, r] as const))));
  it('cross product matches the table exactly (no extra edges)', () => {
    const wrong = cases.filter(([f, t, tr, r]) => canRecordTransition(f, t, tr, r as never) !== allowed(f, t, tr, r));
    expect(wrong).toEqual([]);
  });

  describe('forbidden (§2.4): applied / ignored -> any => 409 micro.instrument_record_conflict', () => {
    it.each(['applied', 'ignored'] as R[])('%s is terminal under every trigger', (from) => {
      for (const to of ALL) for (const tr of TRIGGERS) for (const r of RES) {
        expect(canRecordTransition(from, to, tr, r as never)).toBe(false);
        bad(() => assertRecordTransition(from, to, tr, r as never), 'micro.instrument_record_conflict');
      }
    });
    it('conflict -> applied without a resolution is forbidden', () => expect(canRecordTransition('conflict', 'applied', 'apply')).toBe(false));
    it('conflict -> ignored via ignore is allowed, via apply without keep_existing is not', () => expect(canRecordTransition('conflict', 'ignored', 'apply')).toBe(false));
    it('needs_mapping cannot be assigned (assign is pending_match only)', () => expect(canRecordTransition('needs_mapping', 'applied', 'assign')).toBe(false));
    it('a record never goes back to pending_match through a user action', () =>
      (['assign', 'apply', 'ignore'] as const).forEach((tr) => expect(canRecordTransition('needs_mapping', 'pending_match', tr)).toBe(false)));
    it('consume only creates (from null)', () => expect(canRecordTransition('pending_match', 'applied', 'consume')).toBe(false));
    it('error maps to HTTP 409', () => { try { assertRecordTransition('applied', 'ignored', 'ignore'); } catch (e) { expect((e as LimsError).statusCode).toBe(409); } });
    it('assert passes on a legal edge', () => expect(() => assertRecordTransition('pending_match', 'applied', 'assign')).not.toThrow());
    it('rejects unknown / prototype values', () => {
      expect(canRecordTransition('__proto__' as never, 'ignored', 'ignore')).toBe(false);
      expect(canRecordTransition('pending_match', 'ignored', 'constructor' as never)).toBe(false);
    });
  });
});
