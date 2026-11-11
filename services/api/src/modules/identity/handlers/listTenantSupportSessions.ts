// GET /v1/identity/support-sessions (02-TRD §5; AC-E4.4). Query status only.
import { bindTenantAccess, query } from './tenant-access.http.js';

export const listTenantSupportSessions = bindTenantAccess((s, ctx, req) => {
  const status = query(req)['status'];
  return s.listTenantSupportSessions(ctx, status === undefined ? {} : { status });
});
