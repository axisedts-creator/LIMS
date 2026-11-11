// POST /branches/{branch_id}/reactivate (02-TRD §5.5). 200 + ETag.
import { bindOrg, branchId, ifMatch } from './branchCentre.http.js';

export const reactivateBranch = bindOrg((s, ctx, req) => s.reactivateBranch(ctx, { branchId: branchId(req), expectedVersion: ifMatch(req) }), { etag: true });
