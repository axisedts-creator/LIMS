// POST /users/{membership_id}/unlock (02-TRD §5.3; AC-B4.2). If-Match required; no body; 200 User + ETag.
import { bindUser, versioned } from './user.http.js';
import { guarded } from './_guard.js';

export const unlockUser = guarded('identity.user.manage', bindUser((s, ctx, req) => s.unlockUser(ctx, versioned(req)), { etag: true }));
