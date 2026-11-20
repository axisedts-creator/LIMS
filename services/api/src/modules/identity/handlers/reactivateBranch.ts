// POST /branches/{branch_id}/reactivate (02-TRD §5.5). 200 + ETag.
import { bindOrg, branchId, ifMatch } from './branchCentre.http.js';
import { guarded } from './_guard.js';

export const reactivateBranch = guarded('identity.centre.manage', bindOrg((s, ctx, req) => s.reactivateBranch(ctx, { branchId: branchId(req), expectedVersion: ifMatch(req) }), { etag: true }));
