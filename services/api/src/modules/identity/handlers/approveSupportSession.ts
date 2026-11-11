// POST /v1/identity/support-sessions/{support_session_id}/approve (02-TRD §5; AC-E4.4, SP3). If-Match -> expectedVersion. 200 + ETag.
import { ifMatch } from './role.http.js';
import { bindTenantAccess, param } from './tenant-access.http.js';

export const approveSupportSession = bindTenantAccess(
  (s, ctx, req) => s.approveSupportSession(ctx, { supportSessionId: param(req, 'support_session_id'), expectedVersion: ifMatch(req) }),
  { etag: true },
);
