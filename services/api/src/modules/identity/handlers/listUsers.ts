// GET /users (02-TRD §5.3). Query filters only; 200 UserPage.
import { bindUser, pick } from './user.http.js';

export const listUsers = bindUser((s, ctx, req) => s.listUsers(ctx, pick(req.query, {
  status: 'status', is_locked: 'isLocked', role_id: 'roleId', centre_id: 'centreId', mfa_enrolled: 'mfaEnrolled', sort: 'sort', cursor: 'cursor', limit: 'limit',
})));
