// Fixture identity module for the T0D-02 HTTP tests. The claimsResolver records every call in globalThis.__authCalls.
const A = '0190a000-0000-7000-8000-00000000aaaa';
export const REJECTED_SESSION = '0190a000-0000-7000-8000-0000000000e2';

export const calls = (): Array<{ jwt: any; request: any }> => ((globalThis as any).__authCalls ??= []);

export const manifest = {
  name: 'identity',
  openapi: 'contracts/openapi/identity.yaml',
  produces: [],
  claimsResolver: {
    resolve: async (jwt: any, request: any) => {
      calls().push({ jwt, request });
      if (jwt.sessionId === REJECTED_SESSION) return { kind: 'rejected', code: 'auth.session_expired' };
      return {
        kind: 'tenant',
        claimsJson: JSON.stringify({ sub: jwt.sub, tenant_id: A, membership_id: 'm1', actor_type: 'user', aal: jwt.aal, lims_session_id: jwt.sessionId, session_state: 'active' }),
        tenantId: A,
        actor: { type: 'user', id: jwt.sub, membershipId: 'm1' },
        sessionState: 'active',
      };
    },
  },
  handlers: {
    getIdentityWhoami: async (_req: any, ctx: any) => ({ status: 200, body: { ok: true, clientIp: ctx.clientIp } }),
    getIdentityPing: async (_req: any, ctx: any) => ({ status: 200, body: { clientIp: ctx.clientIp } }),
    postIdentityEcho: async (req: any) => ({ status: 200, body: { name: req.body.name } }),
  },
};
