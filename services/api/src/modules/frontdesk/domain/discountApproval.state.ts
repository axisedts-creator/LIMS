// Discount approval state machine (03-APP-FLOW §1.3, §2.3 step 4; US-FD-07.2-07.5; 07-SECURITY A2). Pure.
import { sameDiscounts, type Discount } from './discount.js';

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'consumed'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type PatientRef = { readonly patientId: string } | { readonly draftHash: string };
export type Check = { ok: true } | { ok: false; code: string };

const NEXT: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['consumed', 'expired'],
  rejected: [],
  expired: [],
  consumed: [],
};
const TTL_MS = 15 * 60_000;

export function canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: ApprovalStatus): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;
export const approvalExpiresAt = (createdAt: Date): Date => new Date(createdAt.getTime() + TTL_MS);

/** Lazy expiry on read: pending/approved at now >= expiresAt -> expired. */
export function effectiveStatus(a: { status: ApprovalStatus; expiresAt: Date }, now: Date): ApprovalStatus {
  return (a.status === 'pending' || a.status === 'approved') && now.getTime() >= a.expiresAt.getTime() ? 'expired' : a.status;
}

export function checkApprove(x: {
  approval: { status: ApprovalStatus; requestedByMembershipId: string; expiresAt: Date };
  approverMembershipId: string; approverAal: 'aal1' | 'aal2'; approverCoversCentre: boolean; now: Date;
}): Check {
  if (x.approverMembershipId === x.approval.requestedByMembershipId) return { ok: false, code: 'frontdesk.discount_self_approval_forbidden' };
  if (x.approverAal !== 'aal2') return { ok: false, code: 'auth.mfa_required' };
  // [CONV] centre not covered is indistinguishable from missing (common.not_found meaning).
  if (!x.approverCoversCentre) return { ok: false, code: 'common.not_found' };
  if (effectiveStatus(x.approval, x.now) !== 'pending') return { ok: false, code: 'common.immutable_record' };
  return { ok: true };
}

const samePatient = (a: PatientRef, b: PatientRef): boolean =>
  'patientId' in a ? 'patientId' in b && a.patientId === b.patientId : 'draftHash' in b && a.draftHash === b.draftHash;

export function checkConsume(x: {
  approval: { status: ApprovalStatus; expiresAt: Date; baseFingerprint: string; patientRef: PatientRef; centreId: string; discounts: readonly Discount[] };
  now: Date; baseFingerprint: string; patientRef: PatientRef; centreId: string; discounts: readonly Discount[];
}): Check {
  const a = x.approval;
  const ok = effectiveStatus(a, x.now) === 'approved' && a.baseFingerprint === x.baseFingerprint
    && samePatient(a.patientRef, x.patientRef) && a.centreId === x.centreId && sameDiscounts(a.discounts, x.discounts);
  return ok ? { ok: true } : { ok: false, code: 'frontdesk.discount_approval_required' };
}
