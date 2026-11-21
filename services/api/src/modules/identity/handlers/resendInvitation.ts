// POST /users/{membership_id}/resend-invitation (02-TRD §5.3). No If-Match; 202 {}.
import { bindUser, membershipId } from './user.http.js';
import { guarded } from './_guard.js';

export const resendInvitation = guarded('identity.user.manage', bindUser((s, ctx, req) => s.resendInvitation(ctx, { membershipId: membershipId(req) })));
