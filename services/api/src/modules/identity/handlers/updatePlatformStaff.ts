// PATCH /platform/staff/{platform_staff_id} (02-TRD §5.10). If-Match -> expectedVersion; only present body keys forwarded. 200 + ETag.
import { ifMatch } from './role.http.js';
import { bindPlatformStaff, platformStaffId, staffFields } from './platform-staff.http.js';

export const updatePlatformStaff = bindPlatformStaff(
  (s, ctx, req) => s.updatePlatformStaff(ctx, { platformStaffId: platformStaffId(req), expectedVersion: ifMatch(req), ...staffFields(req.body) }),
  { etag: true },
);
