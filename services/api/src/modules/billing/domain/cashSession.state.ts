// Cash session state machine (03-APP-FLOW §1.5; 05-SCHEMA cash_sessions__status__ck, guard "open→closed only"). Pure.

export const CASH_SESSION_STATUSES = ['open', 'closed'] as const;
export type CashSessionStatus = (typeof CASH_SESSION_STATUSES)[number];

const NEXT: Readonly<Record<CashSessionStatus, readonly CashSessionStatus[]>> = { open: ['closed'], closed: [] };

export function canTransition(from: CashSessionStatus, to: CashSessionStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: CashSessionStatus): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;
