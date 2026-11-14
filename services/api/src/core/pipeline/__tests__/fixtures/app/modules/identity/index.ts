// T0D-18 fixture identity module: claimsResolver (token sub -> seeded tenant A or B) + a REAL IdentityPort (assertRole records its calls).
// Tenant ids are the db/seeds/010 synthetic tenants (core.idempotency_keys.tenant_id has an FK to core.tenants).
export const SUB_A = '0190a000-0000-7000-8000-00000000a001';
export const SUB_B = '0190a000-0000-7000-8000-00000000b001';
export const TENANT_OF: Record<string, string> = {
  [SUB_A]: '01a1a98a-ac40-7000-8000-00000000a001',
  [SUB_B]: '01a1a98a-ac40-7000-8000-00000000b001',
};
const MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500';

export const assertRoleCalls = (): unknown[][] => ((globalThis as any).__t0d18AssertRole ??= []);

export const manifest = {
  name: 'identity',
  openapi: 'contracts/openapi/identity.yaml',
  produces: [],
  claimsResolver: {
    resolve: async (jwt: any) => {
      const tenantId = TENANT_OF[jwt.sub];
      if (!tenantId) return { kind: 'rejected', code: 'auth.token_invalid' };
      return {
        kind: 'tenant',
        claimsJson: JSON.stringify({ sub: jwt.sub, tenant_id: tenantId, membership_id: MEMBERSHIP, actor_type: 'user', aal: jwt.aal, lims_session_id: jwt.sessionId, session_state: 'active' }),
        tenantId,
        actor: { type: 'user', id: jwt.sub, membershipId: MEMBERSHIP },
        sessionState: 'active',
      };
    },
  },
  ports: {
    IdentityPort: {
      async assertRole(...a: unknown[]) { assertRoleCalls().push(a); },
      async getActor() { return { centreScope: { all: true, centreIds: [] } }; },
    },
  },
  handlers: {
    getIdentityPing: async () => ({ status: 200, body: { ok: true } }),
  },
};
