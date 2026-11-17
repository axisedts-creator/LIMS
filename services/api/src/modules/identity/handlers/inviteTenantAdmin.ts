// POST /platform/tenants/{tenant_id}/admin-invitations (02-TRD §5.10; M1). x-idempotency required (D-213). TenantAdminInviteRequest only; 201.
import { bindTenant, pick, tenantId } from './tenant.http.js';

export const inviteTenantAdmin = bindTenant((s, ctx, req) => s.inviteTenantAdmin(ctx, {
  tenantId: tenantId(req), ...pick(req.body, { email: 'email', display_name: 'displayName' }),
}));
