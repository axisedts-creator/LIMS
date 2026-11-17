// #52–#56 and #3 handlers (02-TRD §5.2). Schema, auth, x-permission and Idempotency-Key are the core pipeline's (catalog.yaml);
// these map request -> service and fail closed without an authenticated request context (same convention as tests.handlers.ts).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createPanelsService } from '../service/panels.service.js';
import { ifMatch } from './masters.handlers.js';

type Svc = ReturnType<typeof createPanelsService>;
type Ctx = Parameters<Svc['createPanel']>[0] & { events?: Parameters<typeof createPanelsService>[0]['events'] };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(run: (svc: Svc, ctx: Ctx, req: HandlerRequest) => Promise<{ status: number; body: unknown }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<Ctx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.events) throw new LimsError('auth.unauthenticated');
    return run(createPanelsService({ events: c.events }), c as Ctx, req);
  };
}
const ok = (body: unknown) => ({ status: 200, body });
const id = (r: HandlerRequest) => obj(r.params)['panel_id'];

export const panelsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listPanels: bind(async (s, c, r) => ok(await s.listPanels(c, r.query))),
  createPanel: bind(async (s, c, r) => ({ status: 201, body: await s.createPanel(c, r.body) })),
  getPanelDetail: bind(async (s, c, r) => ok(await s.getPanelDetail(c, { id: id(r) }))),
  updatePanel: bind(async (s, c, r) => ok(await s.updatePanel(c, { id: id(r), expectedVersion: ifMatch(r), patch: r.body }))),
  replacePanelMembers: bind(async (s, c, r) => ok(await s.replacePanelMembers(c, { id: id(r), expectedVersion: ifMatch(r), body: r.body }))),
  resolveOrderablesPreview: bind(async (s, c, r) => ok(await s.resolveOrderablesPreview(c, r.body))),
});
