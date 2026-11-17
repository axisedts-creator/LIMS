import { bind, obj } from './_audit-view.bind.js';

export const listAuthEvents = bind((s, ctx, req) => s.listAuthEvents(ctx, obj(req.query)));
