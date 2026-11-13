// C17 HC-T02 — handover state table (03-APP-FLOW §1.3, H15 in 02-TRD §5.1). done_when: pure; every allowed + forbidden transition covered.
// Interface expected from the writer (../../domain/handover.state.ts) — SEAMS:
//   export const HANDOVER_STATUSES: readonly HandoverStatus[]   'pending'|'confirmed'|'discrepancy'
//   export interface HandoverTransitionOpts { confirmationRequired?: boolean /* default true = settings.handover_confirmation_required */; itemCount?: number }
//   export function isHandoverTransitionAllowed(from: HandoverStatus | null, to: HandoverStatus, opts?: HandoverTransitionOpts): boolean
//   export function assertHandoverTransition(from, to, opts?): void
//        none -> pending needs itemCount >= 1 when itemCount is given: 0 throws LimsError('common.validation_failed') (spec: mutation rejected);
//        none -> confirmed only when opts.confirmationRequired === false (received_at = handed_over_at), else forbidden;
//        pending -> confirmed | discrepancy; confirmed -> * and discrepancy -> * throw LimsError('common.version_conflict') (H15 "not pending");
//        any other forbidden pair throws a LimsError (code not named by the spec).
//   export function handoverConfirmOutcome(received: readonly boolean[]): 'confirmed' | 'discrepancy'
//        H15: all received -> confirmed; >= 1 missing -> discrepancy; empty list (H15 needs 1..50 items) -> LimsError('common.validation_failed').
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { assertHandoverTransition, HANDOVER_STATUSES, handoverConfirmOutcome, isHandoverTransitionAllowed } from '../../domain/handover.state.js';

type H = (typeof HANDOVER_STATUSES)[number];
const ALL = ['pending', 'confirmed', 'discrepancy'] as H[];
const codeOf = (fn: () => void): string | undefined => {
  try { fn(); } catch (e) { expect(isLimsError(e)).toBe(true); return (e as { code: string }).code; }
  return undefined;
};

describe('HANDOVER_STATUSES', () => {
  it('is pending | confirmed | discrepancy', () => expect([...HANDOVER_STATUSES].sort()).toEqual([...ALL].sort()));
});

describe('handover transitions — allowed', () => {
  it('none -> pending (push handover.recorded, >= 1 item, confirmation required)', () => {
    expect(isHandoverTransitionAllowed(null, 'pending', { itemCount: 1 })).toBe(true);
    expect(isHandoverTransitionAllowed(null, 'pending')).toBe(true);
    expect(() => assertHandoverTransition(null, 'pending', { itemCount: 3 })).not.toThrow();
  });
  it('none -> confirmed only when handover_confirmation_required = false', () => {
    expect(isHandoverTransitionAllowed(null, 'confirmed', { confirmationRequired: false, itemCount: 1 })).toBe(true);
    expect(() => assertHandoverTransition(null, 'confirmed', { confirmationRequired: false, itemCount: 1 })).not.toThrow();
  });
  it('pending -> confirmed (H15 all received)', () => {
    expect(isHandoverTransitionAllowed('pending', 'confirmed')).toBe(true);
    expect(() => assertHandoverTransition('pending', 'confirmed')).not.toThrow();
  });
  it('pending -> discrepancy (H15 >= 1 missing)', () => {
    expect(isHandoverTransitionAllowed('pending', 'discrepancy')).toBe(true);
    expect(() => assertHandoverTransition('pending', 'discrepancy')).not.toThrow();
  });
});

describe('handover transitions — forbidden', () => {
  it('none -> pending with 0 items is rejected with common.validation_failed', () => {
    expect(isHandoverTransitionAllowed(null, 'pending', { itemCount: 0 })).toBe(false);
    expect(codeOf(() => assertHandoverTransition(null, 'pending', { itemCount: 0 }))).toBe('common.validation_failed');
  });
  it('none -> confirmed while confirmation is required is forbidden (default and explicit true)', () => {
    expect(isHandoverTransitionAllowed(null, 'confirmed')).toBe(false);
    expect(isHandoverTransitionAllowed(null, 'confirmed', { confirmationRequired: true })).toBe(false);
    expect(codeOf(() => assertHandoverTransition(null, 'confirmed', { confirmationRequired: true }))).toBeDefined();
  });
  it('none -> discrepancy is forbidden (only H15 can set it)', () => {
    for (const confirmationRequired of [true, false]) {
      expect(isHandoverTransitionAllowed(null, 'discrepancy', { confirmationRequired })).toBe(false);
      expect(codeOf(() => assertHandoverTransition(null, 'discrepancy', { confirmationRequired }))).toBeDefined();
    }
  });
  it('pending -> pending is forbidden', () => {
    expect(isHandoverTransitionAllowed('pending', 'pending')).toBe(false);
    expect(codeOf(() => assertHandoverTransition('pending', 'pending'))).toBeDefined();
  });
  it.each(['confirmed', 'discrepancy'].flatMap((f) => ALL.map((t) => [f, t] as [H, H])))(
    'terminal %s -> %s answers common.version_conflict (H15 on a handover that is not pending)',
    (from, to) => {
      expect(isHandoverTransitionAllowed(from, to)).toBe(false);
      expect(codeOf(() => assertHandoverTransition(from, to))).toBe('common.version_conflict');
    },
  );
});

describe('handoverConfirmOutcome (H15)', () => {
  it('all items received -> confirmed', () => expect(handoverConfirmOutcome([true, true, true])).toBe('confirmed'));
  it('a single received item -> confirmed', () => expect(handoverConfirmOutcome([true])).toBe('confirmed'));
  it('one missing item among many -> discrepancy', () => expect(handoverConfirmOutcome([true, false, true])).toBe('discrepancy'));
  it('all missing -> discrepancy', () => expect(handoverConfirmOutcome([false, false])).toBe('discrepancy'));
  it('empty list is invalid (H15 needs exactly the handover items, 1..50)', () => {
    expect(codeOf(() => handoverConfirmOutcome([]))).toBe('common.validation_failed');
  });
});
