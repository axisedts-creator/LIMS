import { bind, exportIdOf } from './_audit-export.bind.js';

export const downloadAuditExport = bind((s, ctx, req) => s.downloadAuditExport(ctx, exportIdOf(req)));
