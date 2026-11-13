// S1 listBookings, S2 getBooking, S3 createBookingForPatient, S4 cancelBooking, S5 checkInBooking (02-TRD §5).
// Order: fail closed without request context -> IdentityPort.assertRole({permission, centreId?}) (before any query) -> service.
// Floors: S1/S2 engagement.booking.read, S3/S5 engagement.booking.manage, S4 engagement.booking.cancel. Centre = query / body centre_id, or the stored row's centre (authorizeRow).
// [CONV] timezone = IdentityPort.getTenantSettings keys ['timezone'] (v1 tenants are Asia/Kathmandu only, 05-SCHEMA P-15, also the fallback).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createBookingService, type BookingCtx, type BookingService } from '../service/booking.service.js';
import { isUuid } from '../service/slot.service.js';

type Role = { permission: string; centreId?: string };
type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: Role): Promise<void>; getTenantSettings?(ctx: unknown, i: { keys: string[] }): Promise<{ timezone?: unknown }> } };
const READ = 'engagement.booking.read', MANAGE = 'engagement.booking.manage', CANCEL = 'engagement.booking.cancel';
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

type Run = (svc: BookingService, ctx: BookingCtx, req: HandlerRequest, a: { assertRole: (r: Role) => Promise<void>; tz: () => Promise<string | undefined> }) => Promise<{ status: number; body: Record<string, any> }>;

function bind(run: Run): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<BookingCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || typeof c.now !== 'function') throw new LimsError('auth.unauthenticated');
    const identity = c.ports?.IdentityPort;
    if (!identity) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    const tz = async () => { const t = identity.getTenantSettings ? (await identity.getTenantSettings(hctx, { keys: ['timezone'] }))?.timezone : undefined; return typeof t === 'string' && t ? t : undefined; };
    const out = await run(createBookingService(), c as BookingCtx, req, { assertRole: (r) => identity.assertRole(hctx, r), tz });
    const v = out.body['version'] ?? out.body['booking']?.['version'];
    return { status: out.status, body: out.body, ...(typeof v === 'number' ? { headers: { etag: `"${v}"` } } : {}) };
  };
}

export const bookingHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listBookings: bind(async (svc, ctx, req, { assertRole }) => {
    const q = obj(req.query);
    await assertRole({ permission: READ, ...(isUuid(q['centre_id']) ? { centreId: q['centre_id'] } : {}) });
    return svc.list(ctx, { query: q });
  }),
  getBooking: bind(async (svc, ctx, req, { assertRole }) => {
    await assertRole({ permission: READ });
    return svc.get(ctx, { id: obj(req.params)['booking_id'], authorizeRow: (centreId) => assertRole({ permission: READ, centreId }) });
  }),
  createBookingForPatient: bind(async (svc, ctx, req, { assertRole, tz }) => {
    const centre = obj(req.body)['centre_id'];
    await assertRole({ permission: MANAGE, ...(isUuid(centre) ? { centreId: centre } : {}) });
    return svc.create(ctx, { body: req.body, ...(await tz().then((t) => (t ? { tz: t } : {}))) });
  }),
  cancelBooking: bind(async (svc, ctx, req, { assertRole }) => {
    await assertRole({ permission: CANCEL });
    return svc.cancel(ctx, { id: obj(req.params)['booking_id'], headers: req.headers, body: req.body, authorizeRow: (centreId) => assertRole({ permission: CANCEL, centreId }) });
  }),
  checkInBooking: bind(async (svc, ctx, req, { assertRole, tz }) => {
    await assertRole({ permission: MANAGE });
    return svc.checkIn(ctx, { id: obj(req.params)['booking_id'], headers: req.headers, body: req.body, ...(await tz().then((t) => (t ? { tz: t } : {}))), authorizeRow: (centreId) => assertRole({ permission: MANAGE, centreId }) });
  }),
});
