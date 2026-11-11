// POST /platform/tenants/{tenant_id}/reactivate (02-TRD §5.10; T4). If-Match required; 200 + ETag.
import { ifMatch } from './role.http.js';
import { bindTenant, tenantId } from './tenant.http.js';

export const reactivateTenant = bindTenant((s, ctx, req) => s.reactivateTenant(ctx, { tenantId: tenantId(req), expectedVersion: ifMatch(req) }), { etag: true });
