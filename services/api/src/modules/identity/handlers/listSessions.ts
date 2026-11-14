// GET /v1/identity/sessions (02-TRD §5; AC-A5.3). Query membership_id / state / limit / cursor; unknown keys dropped.
import { bindTenantAccess, query } from './tenant-access.http.js';

const MAP = [['membership_id', 'membershipId'], ['state', 'state'], ['limit', 'limit'], ['cursor', 'cursor']] as const;

export const listSessions = bindTenantAccess((s, ctx, req) => {
  const q = query(req);
  return s.listSessions(ctx, Object.fromEntries(MAP.filter(([k]) => q[k] !== undefined).map(([k, v]) => [v, q[k]])));
});
