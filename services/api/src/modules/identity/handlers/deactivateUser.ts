// POST /users/{membership_id}/deactivate (02-TRD §5.3; AC-B4.3, AC-B4.4). If-Match required; 200 User + ETag.
import { REASON, bindUser, versioned } from './user.http.js';

export const deactivateUser = bindUser((s, ctx, req) => s.deactivateUser(ctx, versioned(req, REASON)), { etag: true });
