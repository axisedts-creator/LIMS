// GET /permissions (02-TRD §5.4).
import { bindRole } from './role.http.js';
import { guarded } from './_guard.js';

export const listPermissions = guarded('identity.user.read', bindRole((s, ctx) => s.listPermissions(ctx, {})));
