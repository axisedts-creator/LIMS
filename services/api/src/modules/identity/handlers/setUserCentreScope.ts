// PUT /users/{membership_id}/centre-scope (02-TRD §5.3; AC-B3.3). If-Match required; 200 User + ETag.
import { bindUser, versioned } from './user.http.js';

export const setUserCentreScope = bindUser(
  (s, ctx, req) => s.setUserCentreScope(ctx, versioned(req, { all_centres: 'allCentres', centre_ids: 'centreIds', branch_ids: 'branchIds' })),
  { etag: true },
);
