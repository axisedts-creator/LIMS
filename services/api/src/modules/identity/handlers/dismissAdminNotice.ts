// POST /v1/identity/notices/{notice_id}/dismiss (02-TRD §5). 204.
import { bindTenantAccess, param } from './tenant-access.http.js';
import { guarded } from './_guard.js';

export const dismissAdminNotice = guarded('identity.user.read', bindTenantAccess((s, ctx, req) => s.dismissAdminNotice(ctx, { noticeId: param(req, 'notice_id') })));
