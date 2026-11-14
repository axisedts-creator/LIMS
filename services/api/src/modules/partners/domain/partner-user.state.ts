// C13 T04 — partner user status table, mirror of the C2 membership (03-APP-FLOW §2.5). Pure. null = no row yet.
// invited->invited = U6 resend / role change; active->active = role change; deactivated->invited|active = status returned by C2 (U5).
import { LimsError } from '../../../core/errors.js';

export const PARTNER_USER_STATUSES = ['invited', 'active', 'deactivated'] as const;
export type PartnerUserStatus = (typeof PARTNER_USER_STATUSES)[number];

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  '(none)': ['invited'],
  invited: ['active', 'deactivated', 'invited'],
  active: ['deactivated', 'active'],
  deactivated: ['active', 'invited'],
};

export function canTransition(from: PartnerUserStatus | null, to: PartnerUserStatus): boolean {
  const key = from === null ? '(none)' : from;
  return typeof key === 'string' && Object.hasOwn(ALLOWED, key) && (ALLOWED[key] as readonly string[]).includes(to);
}

export function assertTransition(from: PartnerUserStatus | null, to: PartnerUserStatus): void {
  if (!canTransition(from, to)) throw new LimsError('partners.partner_user_invalid_transition');
}
