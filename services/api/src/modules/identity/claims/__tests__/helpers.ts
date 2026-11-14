// T4 shared helper (not a test). Synthetic data only. Row = one output row of app.identity_resolve_session (05-SCHEMA §6, snake_case verbatim).
export const NOW = new Date('2026-11-07T10:00:00.000Z');
export const mins = (n: number) => new Date(NOW.getTime() + n * 60_000);
export const ID = {
  sub: '01a1a98a-ac40-7000-8000-00000000a300', gotrue: '01a1a98a-ac40-7000-8000-00000000a301', session: '01a1a98a-ac40-7000-8000-00000000a302',
  tenant: '01a1a98a-ac40-7000-8000-00000000b001', membership: '01a1a98a-ac40-7000-8000-00000000b002', req: '01a1a98a-ac40-7000-8000-00000000c001',
  staff: '01a1a98a-ac40-7000-8000-00000000d001', support: '01a1a98a-ac40-7000-8000-00000000d002', supportTenant: '01a1a98a-ac40-7000-8000-00000000b099',
};
export type Row = Record<string, unknown>;
const NULLS = {
  tenant_id: null, tenant_status: null, membership_id: null, membership_status: null, membership_locked: null, partner_role: null,
  platform_staff_id: null, platform_role: null, platform_allowed_cidrs: null,
  support_session_id: null, support_tenant_id: null, support_tenant_status: null, support_scope: null, support_expires_at: null, revoked_at: null,
};
const base = { session_id: ID.session, state: 'active', session_aal: 'aal1', idle_expires_at: mins(15), absolute_expires_at: mins(600), ...NULLS };
export const tenantRow = (o: Row = {}): Row => ({
  ...base, kind: 'tenant_staff', tenant_id: ID.tenant, tenant_status: 'active', membership_id: ID.membership, membership_status: 'active', membership_locked: false, ...o,
});
export const staffMobileRow = (o: Row = {}): Row => tenantRow({ kind: 'staff_mobile', ...o });
export const partnerRow = (o: Row = {}): Row => tenantRow({ kind: 'partner', partner_role: 'partner_admin', ...o });
export const patientRow = (o: Row = {}): Row => tenantRow({ kind: 'patient', ...o });
export const platformRow = (o: Row = {}): Row => ({
  ...base, kind: 'platform', session_aal: 'aal2', platform_staff_id: ID.staff, platform_role: 'platform_support', platform_allowed_cidrs: [], ...o,
});
export const supportRow = (o: Row = {}): Row => platformRow({
  support_session_id: ID.support, support_tenant_id: ID.supportTenant, support_tenant_status: 'active', support_scope: 'read_only', support_expires_at: mins(60), ...o,
});

export const jwt = (o: Record<string, unknown> = {}) => ({ sub: ID.sub, sessionId: ID.gotrue, aal: 'aal1' as const, exp: 1_800_000_000, iat: 1_799_990_000, ...o });
export const req = (o: Record<string, unknown> = {}) => ({ clientIp: '203.0.113.7', requestId: ID.req, endpointFamily: 'staff' as const, bffKey: 'staff_web' as const, ...o });

/** Fake core db: records every identityAuthTx call and every tx.query. `rows` = what the DEFINER returns (zero or one row). */
export function fakeDb(rows: Row[] | Error) {
  const txCalls: any[] = [];
  const queries: { text: string; values: unknown[] | undefined }[] = [];
  const db = {
    async identityAuthTx<T>(input: any, fn: (tx: any, ctl: any) => Promise<T>): Promise<T> {
      txCalls.push(input);
      if (rows instanceof Error) throw rows;
      const tx = { async query(text: string, values?: unknown[]) { queries.push({ text, values }); return { rows }; } };
      return fn(tx, { noRetry() {} });
    },
  };
  return { db, txCalls, queries };
}
