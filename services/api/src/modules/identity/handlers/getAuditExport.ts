import { bind, exportIdOf } from './_audit-export.bind.js';

export const getAuditExport = bind((s, ctx, req) => s.getAuditExport(ctx, exportIdOf(req)));
