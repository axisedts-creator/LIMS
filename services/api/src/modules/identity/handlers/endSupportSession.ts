// POST /platform/support-sessions/{support_session_id}/end (02-TRD §5.10; SP8). No If-Match in the contract; 200 + ETag.
import { bindSupport, supportSessionId } from './support.http.js';

export const endSupportSession = bindSupport(
  (s, ctx, req) => s.endSupportSession(ctx, { supportSessionId: supportSessionId(req) }),
  { etag: true },
);
