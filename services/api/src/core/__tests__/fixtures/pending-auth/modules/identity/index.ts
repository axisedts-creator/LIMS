// T0B-BOOTGATE-1 fixture: postIdentityEcho (bearerJwt) has no handler and is pending. The handler records calls in globalThis.__pendingAuthCalls.
const A = '0190a000-0000-7000-8000-00000000aaaa';
export const calls = (): string[] => ((globalThis as any).__pendingAuthCalls ??= []);

export const manifest = {
  name: 'identity',
  openapi: 'contracts/openapi/identity.yaml',
  produces: [],
  pendingOperations: ['postIdentityEcho'],
  claimsResolver: {
    resolve: async (jwt: any) => ({
      kind: 'tenant',
      claimsJson: JSON.stringify({ sub: jwt.sub, tenant_id: A, membership_id: 'm1', actor_type: 'user', aal: jwt.aal, lims_session_id: jwt.sessionId, session_state: 'active' }),
      tenantId: A,
      actor: { type: 'user', id: jwt.sub, membershipId: 'm1' },
      sessionState: 'active',
    }),
  },
  handlers: {
    getIdentityWhoami: async () => { calls().push('getIdentityWhoami'); return { status: 200, body: { ok: true } }; },
  },
};
