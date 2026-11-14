// POST /platform/staff/{platform_staff_id}/reset-mfa (02-TRD §5.10). Path id only. 200 PlatformStaff + ETag.
import { bindPlatformStaff, platformStaffId } from './platform-staff.http.js';

export const resetPlatformStaffMfa = bindPlatformStaff((s, ctx, req) => s.resetPlatformStaffMfa(ctx, { platformStaffId: platformStaffId(req) }), { etag: true });
