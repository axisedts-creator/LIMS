// POST /platform/support-sessions (02-TRD §5.10; AC-E4.1, AC-E4.4). 201 + ETag. Only the SupportSessionOpenRequest fields are forwarded.
import { obj } from './role.http.js';
import { bindSupport } from './support.http.js';

export const openSupportSession = bindSupport((s, ctx, req) => {
  const b = obj(req.body);
  return s.openSupportSession(ctx, {
    tenantId: b['tenant_id'], scope: b['scope'], reasonText: b['reason_text'], ticketRef: b['ticket_ref'], durationMinutes: b['duration_minutes'],
  });
}, { etag: true });
