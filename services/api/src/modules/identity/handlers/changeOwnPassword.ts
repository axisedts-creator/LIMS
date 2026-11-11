// POST /v1/identity/me/password (02-TRD §5.2; AC-A6.4; P-42). Only the PasswordChangeRequest fields reach the service (mass assignment).
import { bindSelf, obj } from './self.http.js';

export const changeOwnPassword = bindSelf((s, ctx, req) => {
  const b = obj(req.body);
  return s.changeOwnPassword(ctx, { currentPassword: b['current_password'], newPassword: b['new_password'] });
});
