// C10-T02 culture.state.ts (03-APP-FLOW §2.1 C1–C10 + forbidden list; AC-03.3, AC-11.4).
// Assumed API (spec names no functions; same shape as anatomic/domain/case.state.ts):
//   CULTURE_STATUSES, CULTURE_ACTIONS,
//   nextCultureStatus(from: CultureStatus | null, action: CultureAction, ctx?: { reasonCode?: string }): CultureStatus
//     throws LimsError('micro.culture_invalid_transition') for an edge not in the table;
//     for 'reopen' on final_submitted without a non-blank ctx.reasonCode throws LimsError('micro.amendment_reason_required') (422).
//   assertCultureChildEditable(status): final_submitted -> micro.report_final_locked; cancelled -> micro.culture_invalid_transition.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { CULTURE_ACTIONS, CULTURE_STATUSES, assertCultureChildEditable, nextCultureStatus } from '../culture.state.js';

type S = 'awaiting_setup' | 'incubating' | 'growth_detected' | 'final_submitted' | 'amending' | 'cancelled';
const ctx = { reasonCode: 'wrong_result' };
const OPEN: S[] = ['awaiting_setup', 'incubating', 'growth_detected'];

// action -> from-state -> resulting state. Anything absent is forbidden.
const TABLE: Record<string, Partial<Record<S | 'null', S>>> = {
  receive: { null: 'awaiting_setup' }, // C1
  setup: { awaiting_setup: 'incubating' }, // C2
  growth: { incubating: 'growth_detected' }, // C3
  submit_preliminary: { awaiting_setup: 'awaiting_setup', incubating: 'incubating', growth_detected: 'growth_detected' }, // C4 (unchanged); amending = C7 forbidden
  submit_final: { incubating: 'final_submitted', growth_detected: 'final_submitted', amending: 'final_submitted' }, // C5, C6
  reopen: { final_submitted: 'amending' }, // C8
  cancel: { awaiting_setup: 'cancelled', incubating: 'cancelled', growth_detected: 'cancelled' }, // C9
  aliquot: { awaiting_setup: 'awaiting_setup' }, // C10
};

const bad = (f: () => unknown, code: string) => {
  try { f(); } catch (e) { expect(e).toBeInstanceOf(LimsError); expect((e as LimsError).code).toBe(code); return; }
  throw new Error(`expected ${code}`);
};

describe('culture state table', () => {
  it('has exactly the six DB states and the eight actions', () => {
    expect([...CULTURE_STATUSES].sort()).toEqual(['amending', 'awaiting_setup', 'cancelled', 'final_submitted', 'growth_detected', 'incubating']);
    expect([...CULTURE_ACTIONS].sort()).toEqual(Object.keys(TABLE).sort());
  });

  it('C1 receive: null -> awaiting_setup', () => expect(nextCultureStatus(null, 'receive')).toBe('awaiting_setup'));
  it('C2 setup: awaiting_setup -> incubating', () => expect(nextCultureStatus('awaiting_setup', 'setup')).toBe('incubating'));
  it('C3 growth: incubating -> growth_detected', () => expect(nextCultureStatus('incubating', 'growth')).toBe('growth_detected'));
  it.each(OPEN)('C4 preliminary from %s leaves the status unchanged', (s) => expect(nextCultureStatus(s, 'submit_preliminary')).toBe(s));
  it.each(['incubating', 'growth_detected'] as S[])('C5 final from %s -> final_submitted', (s) => expect(nextCultureStatus(s, 'submit_final')).toBe('final_submitted'));
  it('C6 final from amending -> final_submitted', () => expect(nextCultureStatus('amending', 'submit_final')).toBe('final_submitted'));
  it('C7 forbidden: preliminary while amending -> 409', () => bad(() => nextCultureStatus('amending', 'submit_preliminary'), 'micro.culture_invalid_transition'));
  it('C8 reopen with reason: final_submitted -> amending', () => expect(nextCultureStatus('final_submitted', 'reopen', ctx)).toBe('amending'));
  it.each(OPEN)('C9 cancel from %s -> cancelled', (s) => expect(nextCultureStatus(s, 'cancel')).toBe('cancelled'));
  it('C10 aliquot: awaiting_setup -> awaiting_setup', () => expect(nextCultureStatus('awaiting_setup', 'aliquot')).toBe('awaiting_setup'));

  // Full cross product: every (from, action) pair is either the table result or a 409.
  const froms: (S | null)[] = [null, ...(['awaiting_setup', 'incubating', 'growth_detected', 'final_submitted', 'amending', 'cancelled'] as S[])];
  const pairs = froms.flatMap((f) => Object.keys(TABLE).map((a) => [f, a] as const));
  it.each(pairs)('matrix %s + %s', (from, action) => {
    const want = TABLE[action]![(from ?? 'null') as S | 'null'];
    if (want) expect(nextCultureStatus(from, action as never, ctx)).toBe(want);
    else bad(() => nextCultureStatus(from, action as never, ctx), 'micro.culture_invalid_transition');
  });

  describe('forbidden list (03-APP-FLOW §2.1)', () => {
    it.each(Object.keys(TABLE))('cancelled -> * via %s', (a) => bad(() => nextCultureStatus('cancelled', a as never, ctx), 'micro.culture_invalid_transition'));
    it('final_submitted -> incubating (setup)', () => bad(() => nextCultureStatus('final_submitted', 'setup'), 'micro.culture_invalid_transition'));
    it('awaiting_setup -> final_submitted', () => bad(() => nextCultureStatus('awaiting_setup', 'submit_final'), 'micro.culture_invalid_transition'));
    it('amending -> cancelled', () => bad(() => nextCultureStatus('amending', 'cancel'), 'micro.culture_invalid_transition'));
    it.each(Object.keys(TABLE).filter((a) => a !== 'reopen'))('final_submitted changes only via reopen (%s forbidden)', (a) =>
      bad(() => nextCultureStatus('final_submitted', a as never, ctx), 'micro.culture_invalid_transition'));
  });

  describe('AC-03.3 setupCulture on a culture not in awaiting_setup -> 409 micro.culture_invalid_transition', () => {
    it.each(['incubating', 'growth_detected', 'final_submitted', 'amending', 'cancelled'] as S[])('%s', (s) =>
      bad(() => nextCultureStatus(s, 'setup'), 'micro.culture_invalid_transition'));
    it('error maps to HTTP 409', () => { try { nextCultureStatus('incubating', 'setup'); } catch (e) { expect((e as LimsError).statusCode).toBe(409); } });
  });

  describe('AC-11.4 reopenCulture without a reason -> 422 micro.amendment_reason_required', () => {
    it('no ctx', () => bad(() => nextCultureStatus('final_submitted', 'reopen'), 'micro.amendment_reason_required'));
    it.each(['', '   ', undefined])('reasonCode %j', (reasonCode) =>
      bad(() => nextCultureStatus('final_submitted', 'reopen', { reasonCode } as never), 'micro.amendment_reason_required'));
    it('maps to HTTP 422', () => { try { nextCultureStatus('final_submitted', 'reopen'); } catch (e) { expect((e as LimsError).statusCode).toBe(422); } });
    it('state is checked before the reason: reopen of an incubating culture without reason is 409', () =>
      bad(() => nextCultureStatus('incubating', 'reopen'), 'micro.culture_invalid_transition'));
  });

  describe('child edits (03-APP-FLOW §2.1 note)', () => {
    it('final_submitted -> micro.report_final_locked', () => bad(() => assertCultureChildEditable('final_submitted'), 'micro.report_final_locked'));
    it('cancelled -> micro.culture_invalid_transition', () => bad(() => assertCultureChildEditable('cancelled'), 'micro.culture_invalid_transition'));
    it.each(['incubating', 'growth_detected', 'amending'] as S[])('%s is editable', (s) => expect(() => assertCultureChildEditable(s)).not.toThrow());
  });

  it('does not match prototype keys', () => {
    bad(() => nextCultureStatus('__proto__' as never, 'setup'), 'micro.culture_invalid_transition');
    bad(() => nextCultureStatus('awaiting_setup', 'constructor' as never), 'micro.culture_invalid_transition');
  });
});
