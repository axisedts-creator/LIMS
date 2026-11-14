// C17 handover state table (03-APP-FLOW §1.3, H15 in 02-TRD §5.1). Pure.
import { LimsError } from '../../../core/errors.js';

export type HandoverStatus = 'pending' | 'confirmed' | 'discrepancy';
export const HANDOVER_STATUSES: readonly HandoverStatus[] = ['pending', 'confirmed', 'discrepancy'];
export interface HandoverTransitionOpts {
  /** settings.handover_confirmation_required; default true */
  confirmationRequired?: boolean;
  itemCount?: number;
}

const bad = (detail: string): LimsError => new LimsError('common.validation_failed', detail);

export function isHandoverTransitionAllowed(from: HandoverStatus | null, to: HandoverStatus, opts: HandoverTransitionOpts = {}): boolean {
  if (from === null) {
    if (opts.itemCount !== undefined && !(opts.itemCount >= 1)) return false;
    return to === 'pending' || (to === 'confirmed' && opts.confirmationRequired === false);
  }
  return from === 'pending' && (to === 'confirmed' || to === 'discrepancy');
}

export function assertHandoverTransition(from: HandoverStatus | null, to: HandoverStatus, opts: HandoverTransitionOpts = {}): void {
  if (isHandoverTransitionAllowed(from, to, opts)) return;
  if (from === null && opts.itemCount !== undefined && !(opts.itemCount >= 1)) throw bad('handover needs at least one specimen');
  // [CONV] H15 on a non-pending handover = version conflict; other forbidden pairs reuse it (spec names no code).
  throw new LimsError('common.version_conflict');
}

/** H15: all received -> confirmed; at least one missing -> discrepancy. */
export function handoverConfirmOutcome(received: readonly boolean[]): 'confirmed' | 'discrepancy' {
  if (received.length === 0) throw bad('handover has no items');
  return received.every(Boolean) ? 'confirmed' : 'discrepancy';
}
