// POST /v1/identity/notices/{notice_id}/dismiss (02-TRD §5). 204.
import { bindTenantAccess, param } from './tenant-access.http.js';

export const dismissAdminNotice = bindTenantAccess((s, ctx, req) => s.dismissAdminNotice(ctx, { noticeId: param(req, 'notice_id') }));
