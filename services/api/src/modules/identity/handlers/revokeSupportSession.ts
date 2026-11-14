// POST /v1/identity/support-sessions/{support_session_id}/revoke (02-TRD §5; SP10). No body, no If-Match. 200 + ETag.
import { bindTenantAccess, param } from './tenant-access.http.js';

export const revokeSupportSession = bindTenantAccess((s, ctx, req) => s.revokeSupportSession(ctx, { supportSessionId: param(req, 'support_session_id') }), { etag: true });
