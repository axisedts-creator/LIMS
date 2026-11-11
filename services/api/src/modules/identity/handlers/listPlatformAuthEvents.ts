// GET /platform/auth-events (02-TRD §5.10). The raw snake_case query goes to the service, which validates it (as listAuthEvents).
import { obj } from './role.http.js';
import { bindPlatformStaff } from './platform-staff.http.js';

export const listPlatformAuthEvents = bindPlatformStaff((s, ctx, req) => s.listPlatformAuthEvents(ctx, { ...obj(req.query) }));
