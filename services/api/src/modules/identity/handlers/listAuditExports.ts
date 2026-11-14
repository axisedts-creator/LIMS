import { bind } from './_audit-export.bind.js';

export const listAuditExports = bind((s, ctx, req) => s.listAuditExports(ctx, req.query));
