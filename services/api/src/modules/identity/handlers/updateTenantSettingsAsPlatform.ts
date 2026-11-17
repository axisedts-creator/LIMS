// PATCH /platform/tenants/{tenant_id}/settings (02-TRD §5.10; D-T21). If-Match required. Body passed verbatim as `patch` (the service whitelists); tenant from the path only.
import { ifMatch } from './role.http.js';
import { bindTenant, tenantId } from './tenant.http.js';

export const updateTenantSettingsAsPlatform = bindTenant(
  (s, ctx, req) => s.updateTenantSettingsAsPlatform(ctx, { tenantId: tenantId(req), expectedVersion: ifMatch(req), patch: req.body }),
  { etag: true },
);
