// C15 TRD §4.1 intent transition table (I2–I14). I1 "(none) -> created" is creation, not a pair.
import { LimsError } from '../../../core/errors.js';

export const INTENT_STATUSES = [
  'created', 'initiated', 'pending', 'settled', 'failed', 'expired', 'held_for_review', 'partially_refunded', 'refunded',
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** Partial unique index set (REQ-SEC-053). */
export const OPEN_INTENT_STATUSES: readonly IntentStatus[] = ['created', 'initiated', 'pending'];

const TABLE: Readonly<Record<IntentStatus, readonly IntentStatus[]>> = {
  created: ['initiated', 'failed'], // I2, I14
  initiated: ['pending', 'settled', 'failed', 'expired', 'held_for_review'], // I3–I7
  pending: ['settled', 'failed', 'expired', 'held_for_review'], // I4–I7
  held_for_review: ['settled', 'failed'], // I8, I9
  settled: ['partially_refunded', 'refunded'], // I10, I11
  partially_refunded: ['partially_refunded', 'refunded'], // I12, I11
  failed: ['held_for_review'], // I13
  expired: ['held_for_review'], // I13
  refunded: [],
};

export function isIntentTransitionAllowed(from: IntentStatus, to: IntentStatus): boolean {
  return Object.hasOwn(TABLE, from) && TABLE[from].includes(to);
}

export function assertIntentTransition(from: IntentStatus, to: IntentStatus): void {
  if (!isIntentTransitionAllowed(from, to)) throw new LimsError('payments.intent_invalid_transition');
}
