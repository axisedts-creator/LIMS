// PATCH /branches/{branch_id} (02-TRD §5.5). If-Match required; code immutable; 200 + ETag.
import { BRANCH_PATCH, bindOrg, branchId, ifMatch, pick } from './branchCentre.http.js';

export const updateBranch = bindOrg(
  (s, ctx, req) => s.updateBranch(ctx, { branchId: branchId(req), expectedVersion: ifMatch(req), ...pick(req.body, BRANCH_PATCH) }),
  { etag: true },
);
