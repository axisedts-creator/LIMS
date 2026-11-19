// POST /users/{membership_id}/lock (02-TRD §5.3; AC-B4.1, AC-B4.3). If-Match required; 200 User + ETag.
import { REASON, bindUser, versioned } from './user.http.js';
import { guarded } from './_guard.js';

export const lockUser = guarded('identity.user.manage', bindUser((s, ctx, req) => s.lockUser(ctx, versioned(req, REASON)), { etag: true }));
