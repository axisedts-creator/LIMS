// POST /v1/identity/me/mfa-factors/{factor_id}/remove (02-TRD §5.2): self-action guard on the last verified factor of an MFA role.
import { bindSelf, obj } from './self.http.js';

export const removeOwnMfaFactor = bindSelf((s, ctx, req) => s.removeOwnMfaFactor(ctx, { factorId: obj(req.params)['factor_id'] }));
