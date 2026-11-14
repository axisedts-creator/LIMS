// PATCH /platform/tenants/{tenant_id} (02-TRD §5.10). If-Match required. Only TenantUpdateRequest fields + `code` (so the service can answer 400 /code).
import { ifMatch } from './role.http.js';
import { bindTenant, pick, tenantId } from './tenant.http.js';

export const updateTenant = bindTenant((s, ctx, req) => s.updateTenant(ctx, {
  tenantId: tenantId(req), expectedVersion: ifMatch(req),
  ...pick(req.body, { legal_name: 'legalName', display_name: 'displayName', billing_live_on: 'billingLiveOn', unset: 'unset', code: 'code' }),
}), { etag: true });
