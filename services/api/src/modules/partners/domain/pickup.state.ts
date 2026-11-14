// C13 T04 — pickup request state table (03-APP-FLOW §2.3). Pure. null = no row yet.
import { LimsError } from '../../../core/errors.js';

export const PICKUP_STATES = ['requested', 'scheduled', 'picked_up', 'cancelled', 'rejected'] as const;
export type PickupState = (typeof PICKUP_STATES)[number];

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  '(none)': ['requested'],
  requested: ['scheduled', 'picked_up', 'cancelled', 'rejected'],
  scheduled: ['scheduled', 'picked_up', 'cancelled', 'rejected'], // scheduled -> scheduled = reschedule
};

export function canTransition(from: PickupState | null, to: PickupState): boolean {
  const key = from === null ? '(none)' : from;
  return typeof key === 'string' && Object.hasOwn(ALLOWED, key) && (ALLOWED[key] as readonly string[]).includes(to);
}

export function assertTransition(from: PickupState | null, to: PickupState): void {
  if (!canTransition(from, to)) throw new LimsError('partners.pickup_invalid_transition');
}
