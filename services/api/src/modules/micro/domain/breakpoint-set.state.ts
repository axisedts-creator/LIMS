// Breakpoint set state table (03-APP-FLOW §2.5 B1–B6). Pure: no I/O.
import { LimsError } from '../../../core/errors.js';

export const BREAKPOINT_STATUSES = ['uploaded', 'validating', 'validated', 'invalid', 'active', 'retired', 'discarded'] as const;
export type BpStatus = (typeof BREAKPOINT_STATUSES)[number];

// from ('' = new) -> allowed targets. Keys are checked with Object.hasOwn so prototype names never match.
const NEXT: Record<string, readonly BpStatus[]> = {
  '': ['uploaded'], // B1
  uploaded: ['validating', 'discarded'], // B2, B6
  validating: ['validated', 'invalid'], // B3
  validated: ['active', 'discarded'], // B4, B6
  invalid: ['discarded'], // B6
  active: ['retired'], // B5
};

export function canTransition(from: BpStatus | null, to: BpStatus): boolean {
  const k = from ?? '';
  return Object.hasOwn(NEXT, k) && NEXT[k]!.includes(to);
}

export function assertTransition(from: BpStatus | null, to: BpStatus): void {
  if (!canTransition(from, to)) throw new LimsError('micro.breakpoint_set_invalid_transition');
}

/** B4 guard: importer cannot activate their own import. */
export function assertFourEyes(i: { actorId: string; createdBy: string }): void {
  if (i.actorId === i.createdBy) throw new LimsError('micro.breakpoint_four_eyes_required');
}

/** B5: effective_to = greatest(now, effective_from). */
export const retireEffectiveTo = (now: Date, effectiveFrom: Date): Date => (effectiveFrom > now ? effectiveFrom : now);
