// SEC-HDR-1 fixture (synthetic data): module `identity` over fixtures/hdr1/contracts/openapi/identity.yaml.
import { LimsError } from '../../../../../errors.js';

const A = '0190a000-0000-7000-8000-00000000aaaa';

export const manifest = {
  name: 'identity',
  openapi: 'contracts/openapi/identity.yaml',
  produces: [],
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
    getIdentityProbe: async () => ({ status: 200, body: { ok: true } }),
    getIdentityWhoami: async () => ({ status: 200, body: { ok: true } }),
    getIdentityCached: async () => ({ status: 200, body: { ok: true }, headers: { 'cache-control': 'private, max-age=60' } }),
    deleteIdentityGone: async () => ({ status: 204 }),
    getIdentityMissing: async () => { throw new LimsError('common.not_found', 'Specimen not found'); },
  },
};
