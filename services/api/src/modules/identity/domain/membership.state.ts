// Membership state table (03-APP-FLOW §2.2; core.memberships.status M1–M6, lock L1–L2 orthogonal). Pure.
export const STATES = ['invited', 'active', 'deactivated'] as const;
export type MembershipStatus = (typeof STATES)[number];

const EDGES: Readonly<Record<MembershipStatus | '(none)', readonly MembershipStatus[]>> = {
  '(none)': ['invited'], // M1
  invited: ['active', 'deactivated'], // M2, M3
  active: ['deactivated'], // M4
  deactivated: ['active', 'invited'], // M5, M6
};

export function canTransition(from: MembershipStatus | null, to: MembershipStatus): boolean {
  const k = from ?? '(none)';
  return Object.hasOwn(EDGES, k) && EDGES[k].includes(to);
}

// L1 lock / L2 unlock (locked = locked_at IS NOT NULL); a no-op change is not a transition.
export function canLockTransition(fromLocked: boolean, toLocked: boolean): boolean {
  return fromLocked !== toLocked;
}
