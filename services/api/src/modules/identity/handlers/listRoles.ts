// GET /roles (02-TRD §5.4). is_active accepts a boolean or its query-string form.
import { bindRole, obj } from './role.http.js';

const bool = (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v);

export const listRoles = bindRole((s, ctx, req) => {
  const a = obj(req.query)['is_active'];
  return s.listRoles(ctx, a === undefined ? {} : { isActive: bool(a) });
});
