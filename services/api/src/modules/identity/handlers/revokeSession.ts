// POST /v1/identity/sessions/{session_id}/revoke (02-TRD §5; AC-A5.3, AC-A5.4). 204. Needs the caller's current session id (self-revoke guard).
import { bindTenantAccess, param } from './tenant-access.http.js';

export const revokeSession = bindTenantAccess((s, ctx, req) => s.revokeSession(ctx, { sessionId: param(req, 'session_id') }), { currentSession: true });
