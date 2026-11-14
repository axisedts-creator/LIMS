// GET /v1/identity/me/sessions (02-TRD §5.2): own live sessions, keyset paged. Only cursor / limit reach the service.
import { bindSelf, obj } from './self.http.js';

export const listOwnSessions = bindSelf((s, ctx, req) => {
  const q = obj(req.query);
  return s.listOwnSessions(ctx, { ...(q['limit'] === undefined ? {} : { limit: q['limit'] }), ...(q['cursor'] === undefined ? {} : { cursor: q['cursor'] }) });
});
