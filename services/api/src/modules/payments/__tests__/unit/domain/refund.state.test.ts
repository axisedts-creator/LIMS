// PG-T02 — TRD §4.2 refund transition table (R2–R8; R1 is creation).
import { describe, expect, it } from 'vitest';
import {
  assertRefundTransition,
  isRefundTransitionAllowed,
  OPEN_REFUND_STATUSES,
  REFUND_STATUSES,
} from '../../../domain/refund.state.js';

const ALL = ['pending_approval', 'approved', 'requested', 'completed', 'rejected', 'held_for_review', 'failed'] as const;

const ALLOWED: ReadonlyArray<readonly [string, string, string]> = [
  ['R2', 'pending_approval', 'rejected'],
  ['R3', 'pending_approval', 'approved'],
  ['R4', 'approved', 'requested'],
  ['R5', 'requested', 'completed'],
  ['R6', 'requested', 'held_for_review'],
  ['R7', 'held_for_review', 'completed'],
  ['R8', 'requested', 'failed'], ['R8', 'held_for_review', 'failed'],
];

// One explicit forbidden exit per state.
const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  ['pending_approval', 'requested'], // approval cannot be skipped
  ['approved', 'completed'],         // must go through requested
  ['requested', 'approved'],
  ['completed', 'failed'], ['completed', 'requested'], // terminal
  ['rejected', 'approved'],          // terminal
  ['held_for_review', 'requested'],
  ['failed', 'completed'],           // terminal
];

describe('refund state table', () => {
  it('exposes the seven statuses and the in-flight set (partial unique index)', () => {
    expect([...REFUND_STATUSES].sort()).toEqual([...ALL].sort());
    expect([...OPEN_REFUND_STATUSES].sort()).toEqual(['approved', 'held_for_review', 'pending_approval', 'requested']);
  });

  it.each(ALLOWED)('%s: %s -> %s is allowed', (_id, from, to) => {
    expect(isRefundTransitionAllowed(from as never, to as never)).toBe(true);
    expect(() => assertRefundTransition(from as never, to as never)).not.toThrow();
  });

  it.each(FORBIDDEN)('forbidden: %s -> %s', (from, to) => {
    expect(isRefundTransitionAllowed(from as never, to as never)).toBe(false);
  });

  it('allowed set is EXACTLY R2–R8: every other of the 49 pairs is forbidden', () => {
    const allowed = new Set(ALLOWED.map(([, f, t]) => `${f}>${t}`));
    for (const f of ALL) for (const t of ALL) {
      expect(isRefundTransitionAllowed(f, t), `${f} -> ${t}`).toBe(allowed.has(`${f}>${t}`));
    }
  });

  it('terminal states (completed, rejected, failed) have no exit', () => {
    for (const s of ['completed', 'rejected', 'failed'] as const) for (const t of ALL) expect(isRefundTransitionAllowed(s, t)).toBe(false);
  });

  it('assertRefundTransition throws payments.refund_not_allowed (409, CR-C15-006)', () => {
    let err: { code?: string; statusCode?: number } | undefined;
    try { assertRefundTransition('completed', 'failed'); } catch (e) { err = e as never; }
    expect(err?.code).toBe('payments.refund_not_allowed');
    expect(err?.statusCode).toBe(409);
  });

  it('unknown status fails closed', () => {
    expect(isRefundTransitionAllowed('bogus' as never, 'approved')).toBe(false);
  });
});
