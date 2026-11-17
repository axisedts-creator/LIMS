// POST /users (02-TRD §5.3; AC-B1.1-B1.5). UserInviteRequest fields only (mass assignment); 201 User + ETag.
import { bindUser, pick } from './user.http.js';

export const inviteUser = bindUser((s, ctx, req) => s.inviteUser(ctx, pick(req.body, {
  email: 'email', display_name: 'displayName', phone_e164: 'phoneE164', role_ids: 'roleIds', all_centres: 'allCentres', centre_ids: 'centreIds', branch_ids: 'branchIds',
})), { etag: true });
