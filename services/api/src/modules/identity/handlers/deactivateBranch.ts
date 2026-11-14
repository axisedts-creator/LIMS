// POST /branches/{branch_id}/deactivate (02-TRD §5.5). Refused while the branch has active centres; 200 + ETag.
import { bindOrg, branchId, ifMatch } from './branchCentre.http.js';

export const deactivateBranch = bindOrg((s, ctx, req) => s.deactivateBranch(ctx, { branchId: branchId(req), expectedVersion: ifMatch(req) }), { etag: true });
