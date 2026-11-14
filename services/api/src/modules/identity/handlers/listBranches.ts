// GET /branches (02-TRD §5.5). 200, no ETag.
import { bindOrg, listQuery } from './branchCentre.http.js';

export const listBranches = bindOrg((s, ctx, req) => s.listBranches(ctx, listQuery(req, { is_active: 'isActive' })));
