// POST /platform/support-sessions/{support_session_id}/activate (02-TRD §5.10; SP6). If-Match required; 200 + ETag.
import { ifMatch } from './role.http.js';
import { bindSupport, supportSessionId } from './support.http.js';

export const activateSupportSession = bindSupport(
  (s, ctx, req) => s.activateSupportSession(ctx, { supportSessionId: supportSessionId(req), expectedVersion: ifMatch(req) }),
  { etag: true },
);
