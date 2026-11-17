// GET /platform/tenants/{tenant_id} (02-TRD §5.10; platform.tenant.read). 200 + ETag; query/body ignored.
import { bindTenant, tenantId } from './tenant.http.js';

export const getTenant = bindTenant((s, ctx, req) => s.getTenant(ctx, { tenantId: tenantId(req) }), { etag: true });
