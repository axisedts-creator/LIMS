// GET /platform/tenants (02-TRD §5.10; platform.tenant.read). Query snake -> camel; unknown keys dropped; no ETag.
import { obj } from './role.http.js';
import { bindTenant } from './tenant.http.js';

export const listTenants = bindTenant((s, ctx, req) => {
  const q = obj(req.query);
  const limit = typeof q['limit'] === 'string' && /^[0-9]{1,4}$/.test(q['limit']) ? Number(q['limit']) : q['limit'];
  const f = { status: q['status'], sort: q['sort'], cursor: q['cursor'], limit };
  return s.listTenants(ctx, Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)));
});
