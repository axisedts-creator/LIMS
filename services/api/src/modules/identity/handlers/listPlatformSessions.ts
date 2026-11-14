// GET /platform/sessions (02-TRD §5.10). No input. 200 SessionSummaryList (platform kind).
import { bindPlatformStaff } from './platform-staff.http.js';

export const listPlatformSessions = bindPlatformStaff((s, ctx) => s.listPlatformSessions(ctx, {}));
