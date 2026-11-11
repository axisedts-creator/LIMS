import { bind } from './_audit-export.bind.js';

export const createAuditExport = bind((s, ctx, req) => s.createAuditExport(ctx, req.body));
