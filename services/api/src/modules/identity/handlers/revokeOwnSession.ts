// POST /v1/identity/me/sessions/{session_id}/revoke (02-TRD §5.2; AC-A5.2, AC-A5.4).
import { bindSelf, obj } from './self.http.js';
import { guarded } from './_guard.js';

export const revokeOwnSession = guarded('identity.self.manage', bindSelf((s, ctx, req) => s.revokeOwnSession(ctx, { sessionId: obj(req.params)['session_id'] })));
