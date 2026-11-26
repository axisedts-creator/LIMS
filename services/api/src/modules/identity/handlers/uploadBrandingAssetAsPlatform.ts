// POST /platform/tenants/{tenant_id}/branding-assets (CR TENANT-LOGO-1). Multipart file + kind only; tenant from the path only; 201 BrandingAsset.
// Platform authz (platform.tenant.manage) is the service's (PlatformAuthz), like every T22 handler.
import { obj } from './role.http.js';
import { bindTenant, tenantId } from './tenant.http.js';

export const uploadBrandingAssetAsPlatform = bindTenant((s, ctx, req) => {
  const b = obj(req.body);
  return s.uploadBrandingAssetAsPlatform(ctx as Parameters<typeof s.uploadBrandingAssetAsPlatform>[0], { tenantId: tenantId(req), file: b['file'], kind: b['kind'] });
});
