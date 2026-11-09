// POST /roles/{role_id}/deactivate (02-TRD §5.4; AC-B2.3). If-Match required; 200 + ETag.
import { bindRole, ifMatch, roleId } from './role.http.js';

export const deactivateRole = bindRole((s, ctx, req) => s.deactivateRole(ctx, { roleId: roleId(req), expectedVersion: ifMatch(req) }), { etag: true });
