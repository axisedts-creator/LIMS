// #92–#95 instrument code maps handlers (02-TRD §5 rows 92–95). Schema, auth, the x-permission floor and Idempotency-Key are the core pipeline's; these map request -> service.
// All four assert the privileged catalog.instrument_code_map.manage (aal2; listing included) through IdentityPort.assertRole BEFORE any parsing or data access (S-4, AB-23),
// and fail closed without an authenticated request context. Path param of #94: `map_id`.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createInstrumentMapsService } from '../service/instrumentMaps.service.js';
import type { Ctx } from '../service/masters.service.js';
import { ifMatch } from './masters.handlers.js';

type Svc = ReturnType<typeof createInstrumentMapsService>;
type HCtx = Ctx & { events?: Parameters<typeof createInstrumentMapsService>[0]['events']; ports?: { IdentityPort?: { assertRole(ctx: unknown, requirement: { permission: string }): Promise<unknown> } } };
const MANAGE = 'catalog.instrument_code_map.manage';

function bind(run: (svc: Svc, ctx: Ctx, req: HandlerRequest) => Promise<{ status: number; body: unknown }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<HCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.events || !c.ports?.IdentityPort) throw new LimsError('auth.unauthenticated');
    await c.ports.IdentityPort.assertRole(c, { permission: MANAGE });
    return run(createInstrumentMapsService({ events: c.events }), c as Ctx, req);
  };
}
const mapId = (r: HandlerRequest) => (typeof r.params === 'object' && r.params !== null ? (r.params as Record<string, unknown>)['map_id'] : undefined);

export const instrumentMapsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listInstrumentCodeMaps: bind(async (s, c, r) => ({ status: 200, body: await s.listInstrumentCodeMaps(c, r.query) })),
  createInstrumentCodeMap: bind(async (s, c, r) => ({ status: 201, body: await s.createInstrumentCodeMap(c, r.body) })),
  updateInstrumentCodeMap: bind(async (s, c, r) => ({ status: 200, body: await s.updateInstrumentCodeMap(c, { id: mapId(r), expectedVersion: ifMatch(r), patch: r.body }) })),
  upsertInstrumentCodeMaps: bind(async (s, c, r) => ({ status: 200, body: await s.upsertInstrumentCodeMaps(c, r.body) })),
});
