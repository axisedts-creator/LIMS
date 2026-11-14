import { bind, obj } from './_audit-view.bind.js';

export const getAuditEntry = bind((s, ctx, req) => s.getAuditEntry(ctx, { auditId: obj(req.params)['audit_id'] }));
