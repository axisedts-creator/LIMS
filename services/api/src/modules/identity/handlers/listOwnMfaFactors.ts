// GET /v1/identity/me/mfa-factors (02-TRD §5.2): own non-removed factors.
import { bindSelf } from './self.http.js';

export const listOwnMfaFactors = bindSelf((s, ctx) => s.listOwnMfaFactors(ctx, {}));
