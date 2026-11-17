// GET /roles/{role_id} (02-TRD §5.4). 200 + ETag.
import { bindRole, roleId } from './role.http.js';

export const getRole = bindRole((s, ctx, req) => s.getRole(ctx, { roleId: roleId(req) }), { etag: true });
