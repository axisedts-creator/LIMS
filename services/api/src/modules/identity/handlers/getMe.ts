// GET /v1/identity/me (02-TRD §5.2): the caller's own profile (staff or partner session).
import { bindSelf } from './self.http.js';
import { guarded } from './_guard.js';

export const getMe = guarded('identity.self.manage', bindSelf((s, ctx) => s.getMe(ctx, {})));
