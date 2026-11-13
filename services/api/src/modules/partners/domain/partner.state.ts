// C13 T04 — partner status table (03-APP-FLOW §2.4). Pure. null = no row yet.
import { LimsError } from '../../../core/errors.js';

export const PARTNER_STATUSES = ['active', 'suspended'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  '(none)': ['active'],
  active: ['suspended'],
  suspended: ['active'],
};

export function canTransition(from: PartnerStatus | null, to: PartnerStatus): boolean {
  const key = from === null ? '(none)' : from;
  return typeof key === 'string' && Object.hasOwn(ALLOWED, key) && (ALLOWED[key] as readonly string[]).includes(to);
}

export function assertTransition(from: PartnerStatus | null, to: PartnerStatus): void {
  if (!canTransition(from, to)) throw new LimsError('partners.partner_invalid_transition');
}
