// POST /platform/staff (02-TRD §5.10; Idempotency-Key required, core). Body -> { email, displayName, roleCode, allowedCidrs }. 201 PlatformStaff.
import { obj } from './role.http.js';
import { bindPlatformStaff } from './platform-staff.http.js';

export const invitePlatformStaff = bindPlatformStaff((s, ctx, req) => {
  const b = obj(req.body);
  return s.invitePlatformStaff(ctx, { email: b['email'], displayName: b['display_name'], roleCode: b['role_code'], allowedCidrs: b['allowed_cidrs'] });
}, { etag: true });
