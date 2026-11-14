// C15 TRD §4.2 refund transition table (R2–R8; R1 is creation).
import { LimsError } from '../../../core/errors.js';

export const REFUND_STATUSES = ['pending_approval', 'approved', 'requested', 'completed', 'rejected', 'held_for_review', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** In-flight set of the partial unique index (one per intent). */
export const OPEN_REFUND_STATUSES: readonly RefundStatus[] = ['pending_approval', 'approved', 'requested', 'held_for_review'];

const TABLE: Readonly<Record<RefundStatus, readonly RefundStatus[]>> = {
  pending_approval: ['rejected', 'approved'], // R2, R3
  approved: ['requested'], // R4
  requested: ['completed', 'held_for_review', 'failed'], // R5, R6, R8
  held_for_review: ['completed', 'failed'], // R7, R8
  completed: [],
  rejected: [],
  failed: [],
};

export function isRefundTransitionAllowed(from: RefundStatus, to: RefundStatus): boolean {
  return Object.hasOwn(TABLE, from) && TABLE[from].includes(to);
}

export function assertRefundTransition(from: RefundStatus, to: RefundStatus): void {
  if (!isRefundTransitionAllowed(from, to)) throw new LimsError('payments.refund_not_allowed');
}
