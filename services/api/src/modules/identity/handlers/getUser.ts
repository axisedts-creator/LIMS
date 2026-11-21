// GET /users/{membership_id} (02-TRD §5.3). 200 User + ETag.
import { bindUser, membershipId } from './user.http.js';
import { guarded } from './_guard.js';

export const getUser = guarded('identity.user.read', bindUser((s, ctx, req) => s.getUser(ctx, { membershipId: membershipId(req) }), { etag: true }));
