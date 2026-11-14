// POST /platform/tenants/{tenant_id}/terminate (02-TRD §5.10; T5, D-T13). If-Match required; TenantTerminateRequest; 200 + ETag.
import { ifMatch } from './role.http.js';
import { bindTenant, pick, tenantId } from './tenant.http.js';

export const terminateTenant = bindTenant((s, ctx, req) => s.terminateTenant(ctx, {
  tenantId: tenantId(req), expectedVersion: ifMatch(req), ...pick(req.body, { confirm_code: 'confirmCode', reason_text: 'reasonText' }),
}), { etag: true });
