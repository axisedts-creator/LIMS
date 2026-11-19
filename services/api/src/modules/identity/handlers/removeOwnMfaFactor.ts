// POST /v1/identity/me/mfa-factors/{factor_id}/remove (02-TRD §5.2): self-action guard on the last verified factor of an MFA role.
import { bindSelf, obj } from './self.http.js';
import { guarded } from './_guard.js';

export const removeOwnMfaFactor = guarded('identity.self.manage', bindSelf((s, ctx, req) => s.removeOwnMfaFactor(ctx, { factorId: obj(req.params)['factor_id'] })));
