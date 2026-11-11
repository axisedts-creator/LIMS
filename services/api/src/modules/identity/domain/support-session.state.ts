// Support session state table (03-APP-FLOW §2.4 SP1–SP10; identity.support_sessions.status; US-E4). Pure.
export const STATES = ['requested', 'approved', 'denied', 'active', 'ended', 'expired', 'revoked'] as const;
export type SupportSessionStatus = (typeof STATES)[number];

const EDGES: Readonly<Record<SupportSessionStatus | '(none)', readonly SupportSessionStatus[]>> = {
  '(none)': ['active', 'requested'], // SP1 (notify), SP2 (approval_required)
  requested: ['approved', 'denied', 'expired'], // SP3, SP4, SP5
  approved: ['active', 'expired', 'revoked'], // SP6, SP7, SP10
  active: ['ended', 'expired', 'revoked'], // SP8, SP9, SP10
  denied: [],
  ended: [],
  expired: [],
  revoked: [],
};

export function canTransition(from: SupportSessionStatus | null, to: SupportSessionStatus): boolean {
  const k = from ?? '(none)';
  return Object.hasOwn(EDGES, k) && EDGES[k].includes(to);
}
