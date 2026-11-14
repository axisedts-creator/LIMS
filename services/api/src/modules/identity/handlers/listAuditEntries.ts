import { bind, obj } from './_audit-view.bind.js';

export const listAuditEntries = bind((s, ctx, req) => s.listAuditEntries(ctx, obj(req.query)));
