// GET /branches (02-TRD §5.5). 200, no ETag.
import { bindOrg, listQuery } from './branchCentre.http.js';
import { guarded } from './_guard.js';

export const listBranches = guarded('identity.user.read', bindOrg((s, ctx, req) => s.listBranches(ctx, listQuery(req, { is_active: 'isActive' }))));
