// PUT /roles/{role_id} (02-TRD §5.4; AC-B2.1-B2.4). If-Match required; 200 + ETag.
import { bindRole, ifMatch, roleFields, roleId } from './role.http.js';

export const updateRole = bindRole(
  (s, ctx, req) => s.updateRole(ctx, { roleId: roleId(req), expectedVersion: ifMatch(req), ...roleFields(req.body) }),
  { etag: true },
);
