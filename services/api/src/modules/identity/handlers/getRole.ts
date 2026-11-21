// GET /roles/{role_id} (02-TRD §5.4). 200 + ETag.
import { bindRole, roleId } from './role.http.js';
import { guarded } from './_guard.js';

export const getRole = guarded('identity.user.read', bindRole((s, ctx, req) => s.getRole(ctx, { roleId: roleId(req) }), { etag: true }));
