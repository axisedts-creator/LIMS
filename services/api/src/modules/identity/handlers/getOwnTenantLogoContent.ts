// GET /me/tenant-logo/content (CR TENANT-LOGO-1). The logo of the caller's own tenant for the staff shell: no asset id in the request, the
// tenant comes from the session claims only. Bytes and headers come from ctx.download.stream via the service, unchanged.
import { bindSettings } from './settings.http.js';
import { guarded } from './_guard.js';

export const getOwnTenantLogoContent = guarded('identity.self.manage', bindSettings((s, ctx) => s.getOwnTenantLogoContent(ctx)));
