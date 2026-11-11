// GET /v1/identity/me (02-TRD §5.2): the caller's own profile (staff or partner session).
import { bindSelf } from './self.http.js';

export const getMe = bindSelf((s, ctx) => s.getMe(ctx, {}));
