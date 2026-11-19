// POST /branches (02-TRD §5.5; AC-C1.3). 201 + ETag.
import { BRANCH_FIELDS, bindOrg, pick } from './branchCentre.http.js';
import { guarded } from './_guard.js';

export const createBranch = guarded('identity.centre.manage', bindOrg((s, ctx, req) => s.createBranch(ctx, pick(req.body, BRANCH_FIELDS)), { etag: true }));
