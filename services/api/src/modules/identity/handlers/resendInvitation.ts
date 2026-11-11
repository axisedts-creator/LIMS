// POST /users/{membership_id}/resend-invitation (02-TRD §5.3). No If-Match; 202 {}.
import { bindUser, membershipId } from './user.http.js';

export const resendInvitation = bindUser((s, ctx, req) => s.resendInvitation(ctx, { membershipId: membershipId(req) }));
