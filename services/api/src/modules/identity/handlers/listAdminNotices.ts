// GET /v1/identity/notices (02-TRD §5). No input.
import { bindTenantAccess } from './tenant-access.http.js';
import { guarded } from './_guard.js';

export const listAdminNotices = guarded('identity.user.read', bindTenantAccess((s, ctx) => s.listAdminNotices(ctx, {})));
