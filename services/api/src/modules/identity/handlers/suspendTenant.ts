// POST /platform/tenants/{tenant_id}/suspend (02-TRD §5.10; T3, US-E2). If-Match required; ReasonTextRequest; 200 + ETag.
import { ifMatch } from './role.http.js';
import { bindTenant, pick, tenantId } from './tenant.http.js';

export const suspendTenant = bindTenant((s, ctx, req) => s.suspendTenant(ctx, {
  tenantId: tenantId(req), expectedVersion: ifMatch(req), ...pick(req.body, { reason_text: 'reasonText' }),
}), { etag: true });
