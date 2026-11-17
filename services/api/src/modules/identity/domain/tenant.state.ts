// Tenant state table (03-APP-FLOW §2.3 T1–T5; core.tenants.status, C0 CHECK set per 08 A3.3). Pure.
export const STATES = ['provisioning', 'active', 'suspended', 'offboarded'] as const;
export type TenantStatus = (typeof STATES)[number];

const EDGES: Readonly<Record<TenantStatus | '(none)', readonly TenantStatus[]>> = {
  '(none)': ['provisioning'], // T1
  provisioning: ['active', 'offboarded'], // T2, T5
  active: ['suspended'], // T3
  suspended: ['active', 'offboarded'], // T4, T5
  offboarded: [],
};

export function canTransition(from: TenantStatus | null, to: TenantStatus): boolean {
  const k = from ?? '(none)';
  return Object.hasOwn(EDGES, k) && EDGES[k].includes(to);
}
