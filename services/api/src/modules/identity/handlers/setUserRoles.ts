// PUT /users/{membership_id}/roles (02-TRD §5.3; AC-B2.3, AC-B2.4). If-Match required; 200 User + ETag.
import { bindUser, versioned } from './user.http.js';

export const setUserRoles = bindUser((s, ctx, req) => s.setUserRoles(ctx, versioned(req, { role_ids: 'roleIds' })), { etag: true });
