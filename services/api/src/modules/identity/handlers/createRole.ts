// POST /roles (02-TRD §5.4; AC-B2.1, AC-B2.2). 201 + ETag.
import { bindRole, obj, roleFields } from './role.http.js';

export const createRole = bindRole((s, ctx, req) => s.createRole(ctx, { code: obj(req.body)['code'], ...roleFields(req.body) }), { etag: true });
