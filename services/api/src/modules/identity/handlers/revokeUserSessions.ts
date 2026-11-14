// POST /users/{membership_id}/revoke-sessions (02-TRD §5.3). No If-Match; 200 RevokedCount.
import { bindUser, membershipId } from './user.http.js';

export const revokeUserSessions = bindUser((s, ctx, req) => s.revokeUserSessions(ctx, { membershipId: membershipId(req) }));
