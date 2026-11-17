// GET /v1/identity/notices (02-TRD §5). No input.
import { bindTenantAccess } from './tenant-access.http.js';

export const listAdminNotices = bindTenantAccess((s, ctx) => s.listAdminNotices(ctx, {}));
