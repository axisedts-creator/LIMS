// GET /platform/staff (02-TRD §5.10). No input. 200 PlatformStaffList.
import { bindPlatformStaff } from './platform-staff.http.js';

export const listPlatformStaff = bindPlatformStaff((s, ctx) => s.listPlatformStaff(ctx, {}));
