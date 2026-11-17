// FD-T02 discountApproval.state.ts (03-APP-FLOW §1.3, §2.3 step 4; US-FD-07.2-07.5; 07-SECURITY A2, aal2 row).
// Assumed API: APPROVAL_STATUSES, canTransition, isTerminal, approvalExpiresAt(createdAt: Date) (+15 min), effectiveStatus(approval, now),
//   checkApprove({approval, approverMembershipId, approverAal, approverCoversCentre, now}) -> {ok:true}|{ok:false, code?},
//   checkConsume({approval, now, baseFingerprint, patientRef, centreId, discounts}) -> {ok:true}|{ok:false, code}.
import { describe, expect, it } from 'vitest';
import { APPROVAL_STATUSES, approvalExpiresAt, canTransition, checkApprove, checkConsume, effectiveStatus, isTerminal } from '../discountApproval.state.js';

const ALLOWED: Record<string, string[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['consumed', 'expired'],
  rejected: [],
  expired: [],
  consumed: [],
};

describe('approval state table', () => {
  it('has the five DB states', () => expect([...APPROVAL_STATUSES].sort()).toEqual(['approved', 'consumed', 'expired', 'pending', 'rejected']));
  const pairs = APPROVAL_STATUSES.flatMap((f) => APPROVAL_STATUSES.map((t) => [f, t] as const));
  it.each(pairs)('%s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(ALLOWED[from]!.includes(to));
  });
  it('terminal states: rejected, expired, consumed', () => {
    expect(APPROVAL_STATUSES.filter((s) => isTerminal(s)).sort()).toEqual(['consumed', 'expired', 'rejected']);
  });
  it('forbidden examples: approved->pending, consumed->approved, pending->consumed, rejected->approved', () => {
    expect(canTransition('approved', 'pending')).toBe(false);
    expect(canTransition('consumed', 'approved')).toBe(false);
    expect(canTransition('pending', 'consumed')).toBe(false);
    expect(canTransition('rejected', 'approved')).toBe(false);
  });
  it('rejects unknown statuses', () => expect(canTransition('bogus' as never, 'approved')).toBe(false));
});

const T0 = new Date('2026-11-07T10:00:00.000Z');
const plus = (min: number) => new Date(T0.getTime() + min * 60_000);

describe('expiry', () => {
  it('approvalExpiresAt = created + 15 min', () => expect(approvalExpiresAt(T0).toISOString()).toBe('2026-11-07T10:15:00.000Z'));
  it('effectiveStatus lazily expires pending/approved at now >= expiresAt', () => {
    const exp = plus(15);
    expect(effectiveStatus({ status: 'pending', expiresAt: exp }, plus(14))).toBe('pending');
    expect(effectiveStatus({ status: 'pending', expiresAt: exp }, plus(15))).toBe('expired');
    expect(effectiveStatus({ status: 'approved', expiresAt: exp }, plus(16))).toBe('expired');
  });
  it('terminal states are never changed by time', () => {
    for (const status of ['rejected', 'consumed', 'expired'] as const) expect(effectiveStatus({ status, expiresAt: plus(1) }, plus(60))).toBe(status);
  });
});

describe('checkApprove (US-FD-07.3, 07.4)', () => {
  const approval = { status: 'pending' as const, requestedByMembershipId: 'm-requester', expiresAt: plus(15) };
  const ok = { approval, approverMembershipId: 'm-finance', approverAal: 'aal2' as const, approverCoversCentre: true, now: plus(1) };
  it('different person at aal2, centre covered, pending, unexpired -> ok', () => expect(checkApprove(ok)).toEqual({ ok: true }));
  it('07.3 aal1 approver -> auth.mfa_required', () => {
    expect(checkApprove({ ...ok, approverAal: 'aal1' })).toEqual({ ok: false, code: 'auth.mfa_required' });
  });
  it('07.4 approving own request -> frontdesk.discount_self_approval_forbidden (even at aal2)', () => {
    expect(checkApprove({ ...ok, approverMembershipId: 'm-requester' })).toEqual({ ok: false, code: 'frontdesk.discount_self_approval_forbidden' });
  });
  it.each(['approved', 'rejected', 'expired', 'consumed'] as const)('already %s cannot be approved', (status) => {
    expect(checkApprove({ ...ok, approval: { ...approval, status } })).toEqual({ ok: false, code: 'common.immutable_record' });
  });
  it('expired by clock (now >= expiresAt) cannot be approved', () => {
    expect(checkApprove({ ...ok, now: plus(15) })).toEqual({ ok: false, code: 'common.immutable_record' });
    expect(checkApprove({ ...ok, now: plus(14.9) }).ok).toBe(true);
  });
  it('approver not covering the centre cannot approve', () => expect(checkApprove({ ...ok, approverCoversCentre: false }).ok).toBe(false));
});

describe('checkConsume (US-FD-07.2, 07.5; security A2)', () => {
  const discounts = [{ scope: 'bill', kind: 'percent', percentBp: 3000, reasonCode: 'staff_family' }];
  const FP = 'a'.repeat(64);
  const approval = {
    status: 'approved' as const, expiresAt: plus(15), baseFingerprint: FP, patientRef: { patientId: 'p-1' }, centreId: 'c-1', discounts,
  };
  const ask = { approval, now: plus(5), baseFingerprint: FP, patientRef: { patientId: 'p-1' }, centreId: 'c-1', discounts };
  const DENIED = { ok: false, code: 'frontdesk.discount_approval_required' };
  it('everything bound and fresh -> ok', () => expect(checkConsume(ask as never)).toEqual({ ok: true }));
  it('key order of the discounts JSON is irrelevant', () => {
    const reordered = [{ reasonCode: 'staff_family', percentBp: 3000, kind: 'percent', scope: 'bill' }];
    expect(checkConsume({ ...ask, discounts: reordered } as never)).toEqual({ ok: true });
  });
  it('07.5 older than 15 min (now >= expiresAt) -> denied', () => {
    expect(checkConsume({ ...ask, now: plus(15) } as never)).toEqual(DENIED);
    expect(checkConsume({ ...ask, now: plus(40) } as never)).toEqual(DENIED);
  });
  it.each(['pending', 'rejected', 'expired', 'consumed'] as const)('07.5 status %s (not approved / already consumed) -> denied', (status) => {
    expect(checkConsume({ ...ask, approval: { ...approval, status } } as never)).toEqual(DENIED);
  });
  it('07.5 server-recomputed base fingerprint differs -> denied', () => {
    expect(checkConsume({ ...ask, baseFingerprint: 'b'.repeat(64) } as never)).toEqual(DENIED);
  });
  it('07.5 discounts differ -> denied', () => {
    expect(checkConsume({ ...ask, discounts: [{ ...discounts[0], percentBp: 3500 }] } as never)).toEqual(DENIED);
    expect(checkConsume({ ...ask, discounts: [] } as never)).toEqual(DENIED);
  });
  it('A2 approval reused for another patient -> denied', () => {
    expect(checkConsume({ ...ask, patientRef: { patientId: 'p-2' } } as never)).toEqual(DENIED);
  });
  it('approval for a draft (new patient) binds to draftHash; mismatch or kind switch -> denied', () => {
    const draft = { ...approval, patientRef: { draftHash: 'h1' } };
    expect(checkConsume({ ...ask, approval: draft, patientRef: { draftHash: 'h1' } } as never)).toEqual({ ok: true });
    expect(checkConsume({ ...ask, approval: draft, patientRef: { draftHash: 'h2' } } as never)).toEqual(DENIED);
    expect(checkConsume({ ...ask, approval: draft, patientRef: { patientId: 'p-1' } } as never)).toEqual(DENIED);
  });
  it('different centre -> denied', () => {
    expect(checkConsume({ ...ask, centreId: 'c-2' } as never)).toEqual(DENIED);
  });
});
