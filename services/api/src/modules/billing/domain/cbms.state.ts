// CBMS sync state (03-APP-FLOW §1.6; 05-SCHEMA invoices cbms_state / cbms_cancel_state, cbms_submissions__outcome__ck; US-BL-13.1-13.3). Pure.
import { LimsError } from '../../../core/errors.js';

export const CBMS_STATES = ['not_required', 'pending', 'synced', 'failed_permanent'] as const;
export type CbmsState = (typeof CBMS_STATES)[number];
export type CbmsOutcome = 'accepted' | 'rejected_permanent' | 'retryable_error' | 'stub_recorded';

const NEXT: Readonly<Record<CbmsState, readonly CbmsState[]>> = {
  not_required: ['pending'],
  pending: ['synced', 'failed_permanent'],
  failed_permanent: ['pending'], // B31 retry
  synced: [],
};
const AFTER: Readonly<Record<CbmsOutcome, CbmsState>> = {
  accepted: 'synced', rejected_permanent: 'failed_permanent', retryable_error: 'pending', stub_recorded: 'pending', // the stub never shows synced
};

export function canTransition(from: CbmsState, to: CbmsState): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: CbmsState): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;

/** cbms_cancel_state is NULL until the invoice is cancelled, then not_required | pending; never back to NULL. */
export function canTransitionCancel(from: CbmsState | null, to: CbmsState): boolean {
  if (from === null) return to === 'not_required' || to === 'pending';
  return canTransition(from, to);
}

export function nextCbmsState(state: CbmsState, outcome: CbmsOutcome): CbmsState {
  if (state !== 'pending') throw new LimsError('common.validation_failed', 'only a pending document is submitted');
  if (!Object.hasOwn(AFTER, outcome)) throw new LimsError('common.validation_failed', 'unknown CBMS outcome');
  return AFTER[outcome];
}
