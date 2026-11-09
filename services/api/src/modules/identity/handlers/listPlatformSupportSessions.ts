// GET /platform/support-sessions (02-TRD §5.10; platform.tenant.read). Query snake -> camel; unknown keys dropped; no ETag.
import { obj } from './role.http.js';
import { bindSupport } from './support.http.js';

export const listPlatformSupportSessions = bindSupport((s, ctx, req) => {
  const q = obj(req.query);
  const limit = typeof q['limit'] === 'string' && /^[0-9]{1,4}$/.test(q['limit']) ? Number(q['limit']) : q['limit'];
  const f = { tenantId: q['tenant_id'], status: q['status'], platformStaffId: q['platform_staff_id'], cursor: q['cursor'], limit };
  return s.listPlatformSupportSessions(ctx, Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)));
});
