// GET /v1/identity/me/mfa-factors (02-TRD §5.2): own non-removed factors.
import { bindSelf } from './self.http.js';
import { guarded } from './_guard.js';

export const listOwnMfaFactors = guarded('identity.self.manage', bindSelf((s, ctx) => s.listOwnMfaFactors(ctx, {})));
