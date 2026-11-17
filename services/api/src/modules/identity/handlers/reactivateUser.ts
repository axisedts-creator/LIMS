// POST /users/{membership_id}/reactivate (02-TRD §5.3; D-T8, D-T13). If-Match required; no body; 200 User + ETag.
import { bindUser, versioned } from './user.http.js';

export const reactivateUser = bindUser((s, ctx, req) => s.reactivateUser(ctx, versioned(req)), { etag: true });
