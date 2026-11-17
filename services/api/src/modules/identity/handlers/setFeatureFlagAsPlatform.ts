// PUT /platform/tenants/{tenant_id}/feature-flags/{flag_code} (02-TRD §5.10; AC-C5.3). PlatformFeatureFlagSetRequest only; 200 + ETag.
import { obj } from './role.http.js';
import { bindTenant, pick, tenantId } from './tenant.http.js';

export const setFeatureFlagAsPlatform = bindTenant((s, ctx, req) => s.setFeatureFlagAsPlatform(ctx, {
  tenantId: tenantId(req), flagCode: obj(req.params)['flag_code'], ...pick(req.body, { is_enabled: 'isEnabled', approval_ref: 'approvalRef' }),
}), { etag: true });
