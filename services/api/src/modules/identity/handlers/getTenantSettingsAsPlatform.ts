// GET /platform/tenants/{tenant_id}/settings (02-TRD §5.10; platform.tenant.read). 200 + ETag.
import { bindTenant, tenantId } from './tenant.http.js';

export const getTenantSettingsAsPlatform = bindTenant((s, ctx, req) => s.getTenantSettingsAsPlatform(ctx, { tenantId: tenantId(req) }), { etag: true });
