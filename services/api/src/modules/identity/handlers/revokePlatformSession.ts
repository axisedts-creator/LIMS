// POST /platform/sessions/{session_id}/revoke (02-TRD §5.10). Path id only. 204.
import { obj } from './role.http.js';
import { bindPlatformStaff } from './platform-staff.http.js';

export const revokePlatformSession = bindPlatformStaff((s, ctx, req) => s.revokePlatformSession(ctx, { sessionId: obj(req.params)['session_id'] }));
