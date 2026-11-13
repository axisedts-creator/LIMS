// C13 T04 — partner referrer mapping table (03-APP-FLOW §2.6). Pure. null = no row yet.
import { LimsError } from '../../../core/errors.js';

export const REFERRER_MAPPING_STATES = ['unmapped', 'mapped', 'rejected'] as const;
export type ReferrerMappingState = (typeof REFERRER_MAPPING_STATES)[number];

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  '(none)': ['unmapped'],
  unmapped: ['mapped', 'rejected'],
  mapped: ['unmapped'],
  rejected: ['unmapped'],
};

export function canTransition(from: ReferrerMappingState | null, to: ReferrerMappingState): boolean {
  const key = from === null ? '(none)' : from;
  return typeof key === 'string' && Object.hasOwn(ALLOWED, key) && (ALLOWED[key] as readonly string[]).includes(to);
}

export function assertTransition(from: ReferrerMappingState | null, to: ReferrerMappingState): void {
  if (!canTransition(from, to)) throw new LimsError('partners.referrer_invalid_transition');
}
