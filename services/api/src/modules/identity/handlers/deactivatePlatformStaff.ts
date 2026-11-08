// POST /platform/staff/{platform_staff_id}/deactivate (02-TRD §5.10). If-Match -> expectedVersion. 200 + ETag.
import { ifMatch } from './role.http.js';
import { bindPlatformStaff, platformStaffId } from './platform-staff.http.js';

export const deactivatePlatformStaff = bindPlatformStaff(
  (s, ctx, req) => s.deactivatePlatformStaff(ctx, { platformStaffId: platformStaffId(req), expectedVersion: ifMatch(req) }),
  { etag: true },
);
