// POST /v1/identity/support-sessions/{support_session_id}/deny (02-TRD §5; AC-E4.4, SP4). Body ReasonTextRequest; no If-Match. 200 + ETag.
import { obj } from './role.http.js';
import { bindTenantAccess, param } from './tenant-access.http.js';

export const denySupportSession = bindTenantAccess(
  (s, ctx, req) => s.denySupportSession(ctx, { supportSessionId: param(req, 'support_session_id'), reasonText: obj(req.body)['reason_text'] }),
  { etag: true },
);
