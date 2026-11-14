// GET /permissions (02-TRD §5.4).
import { bindRole } from './role.http.js';

export const listPermissions = bindRole((s, ctx) => s.listPermissions(ctx, {}));
