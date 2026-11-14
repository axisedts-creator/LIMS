// POST /platform/tenants/{tenant_id}/activate (02-TRD §5.10; T2, AC-E1.3). If-Match required; 200 + ETag.
import { ifMatch } from './role.http.js';
import { bindTenant, tenantId } from './tenant.http.js';

export const activateTenant = bindTenant((s, ctx, req) => s.activateTenant(ctx, { tenantId: tenantId(req), expectedVersion: ifMatch(req) }), { etag: true });
