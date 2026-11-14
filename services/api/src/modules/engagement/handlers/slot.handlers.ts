// S6 getSlotAvailability, S7 listSlotTemplates, S8 createSlotTemplate, S9 updateSlotTemplate, S10 deactivateSlotTemplate, S11 listSlotBlackouts / createSlotBlackout / deactivateSlotBlackout (02-TRD §5).
// Order: fail closed without request context -> IdentityPort.assertRole({permission, centreId?}) (before any query) -> service.
// Floors: S6 engagement.booking.read; S7-S11 engagement.slot.manage (tenant_admin, lab_manager). Centre = query centre_id / body centre_id / the stored row's centre.
// [CONV] timezone = IdentityPort.getTenantSettings keys ['timezone'] (v1 tenants are Asia/Kathmandu only, 05-SCHEMA P-15, also the fallback).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createSlotService, isUuid, type SlotCtx, type SlotService } from '../service/slot.service.js';

type Assert = (r: { permission: string; centreId?: string }) => Promise<void>;
type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<void>; getTenantSettings?(ctx: unknown, i: { keys: string[] }): Promise<{ timezone?: unknown }> } };
const READ = 'engagement.booking.read';
const MANAGE = 'engagement.slot.manage';
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(fn: (svc: SlotService, ctx: SlotCtx, req: HandlerRequest, assertRole: Assert, hctx: HandlerContext) => Promise<{ status: number; body: Record<string, any> }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<SlotCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || typeof c.now !== 'function') throw new LimsError('auth.unauthenticated');
    const identity = c.ports?.IdentityPort;
    if (!identity) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    const out = await fn(createSlotService(), c as SlotCtx, req, (r) => identity.assertRole(hctx, r), hctx);
    const v = out.body['version'];
    return { status: out.status, body: out.body, ...(typeof v === 'number' ? { headers: { etag: `"${v}"` } } : {}) };
  };
}

/** Lists: the centre is asserted when given (a foreign centre -> auth.forbidden, zero queries); a malformed one is a 400 after the permission floor. */
const list = (run: (svc: SlotService, ctx: SlotCtx, q: Record<string, any>) => Promise<Record<string, any>>) => bind(async (svc, ctx, req, assertRole) => {
  const q = obj(req.query);
  await assertRole({ permission: MANAGE, ...(isUuid(q['centre_id']) ? { centreId: q['centre_id'] } : {}) });
  return { status: 200, body: await run(svc, ctx, q) };
});

const create = (run: (svc: SlotService, ctx: SlotCtx, body: unknown) => Promise<Record<string, any>>) => bind(async (svc, ctx, req, assertRole) => {
  const centre = obj(req.body)['centre_id'];
  await assertRole({ permission: MANAGE, ...(isUuid(centre) ? { centreId: centre } : {}) });
  return { status: 201, body: await run(svc, ctx, req.body) };
});

const change = (idParam: string, run: (svc: SlotService, ctx: SlotCtx, i: { id: unknown; headers: unknown; body: unknown; authorizeRow: (centreId: string) => Promise<void> }) => Promise<Record<string, any>>) =>
  bind(async (svc, ctx, req, assertRole) => {
    await assertRole({ permission: MANAGE });
    return { status: 200, body: await run(svc, ctx, { id: obj(req.params)[idParam], headers: req.headers, body: req.body, authorizeRow: (centreId) => assertRole({ permission: MANAGE, centreId }) }) };
  });

export const slotHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  getSlotAvailability: bind(async (svc, ctx, req, assertRole, hctx) => {
    const q = obj(req.query);
    await assertRole({ permission: READ, ...(isUuid(q['centre_id']) ? { centreId: q['centre_id'] } : {}) });
    const tz = (hctx as unknown as { ports?: Ports }).ports?.IdentityPort?.getTenantSettings
      ? (await (hctx as unknown as { ports: Ports }).ports.IdentityPort!.getTenantSettings!(hctx, { keys: ['timezone'] }))?.timezone : undefined;
    return { status: 200, body: await svc.availability(ctx, { query: q, ...(typeof tz === 'string' && tz ? { timeZone: tz } : {}) }) };
  }),
  listSlotTemplates: list((svc, ctx, q) => svc.listTemplates(ctx, { centreId: q['centre_id'], isActive: q['is_active'] })),
  createSlotTemplate: create((svc, ctx, body) => svc.createTemplate(ctx, { body })),
  updateSlotTemplate: change('template_id', (svc, ctx, i) => svc.updateTemplate(ctx, i)),
  deactivateSlotTemplate: change('template_id', (svc, ctx, i) => svc.deactivateTemplate(ctx, i)),
  listSlotBlackouts: list((svc, ctx, q) => svc.listBlackouts(ctx, { centreId: q['centre_id'], isActive: q['is_active'] })),
  createSlotBlackout: create((svc, ctx, body) => svc.createBlackout(ctx, { body })),
  deactivateSlotBlackout: change('blackout_id', (svc, ctx, i) => svc.deactivateBlackout(ctx, i)),
});
