// GET /users/{membership_id} (02-TRD §5.3). 200 User + ETag.
import { bindUser, membershipId } from './user.http.js';

export const getUser = bindUser((s, ctx, req) => s.getUser(ctx, { membershipId: membershipId(req) }), { etag: true });
