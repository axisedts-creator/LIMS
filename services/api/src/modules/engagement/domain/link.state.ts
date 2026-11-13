// Account-patient link state machine (03-APP-FLOW §3.4 L-2..L-5). active->active = idempotent re-link. Pure.

export const LINK_STATUSES = ['active', 'suspended', 'revoked'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

const NEXT: Readonly<Record<LinkStatus, readonly LinkStatus[]>> = {
  active: ['active', 'suspended', 'revoked'],
  suspended: ['active', 'revoked'],
  revoked: [],
};

export function canTransition(from: LinkStatus, to: LinkStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: LinkStatus): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;
