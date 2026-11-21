// GET /v1/identity/support-sessions (02-TRD §5; AC-E4.4). Query status only.
import { bindTenantAccess, query } from './tenant-access.http.js';
import { guarded } from './_guard.js';

export const listTenantSupportSessions = guarded('audit.log.read', bindTenantAccess((s, ctx, req) => {
  const status = query(req)['status'];
  return s.listTenantSupportSessions(ctx, status === undefined ? {} : { status });
}));
