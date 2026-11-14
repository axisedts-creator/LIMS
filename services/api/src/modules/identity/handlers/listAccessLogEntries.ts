import { bind, obj } from './_audit-view.bind.js';

export const listAccessLogEntries = bind((s, ctx, req) => s.listAccessLogEntries(ctx, obj(req.query)));
