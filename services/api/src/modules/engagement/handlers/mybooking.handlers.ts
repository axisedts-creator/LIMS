// E30 listMyBookableItems, E31 listMyBookingCentres, E32 listMyAvailableSlots, E33 createMyBooking, E34 listMyBookings, E35 getMyBooking, E36 cancelMyBooking, E37 listMyAddresses, E38 createMyAddress,
// E39 updateMyAddress, E40 deactivateMyAddress (02-TRD §5, §9.1). Order: fail closed without request context -> IdentityPort.assertRole(permission) before ANY query -> service (patient actors only; the service refuses
// staff / display actors with auth.forbidden before its first statement). Floors: E30 / E31 / E34 / E35 / E37 engagement.self.read; E32 / E33 engagement.booking.create; E36 engagement.booking.cancel; E38-E40 engagement.self.manage.
// Answers hold PHI: Cache-Control no-store; a body with a version carries it as the ETag. [CONV] timezone = IdentityPort.getTenantSettings keys ['timezone'] (v1 tenants are Asia/Kathmandu only, also the fallback).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createAddressService, type AddressService } from '../service/address.service.js';
import { createMyBookingService, type BookingCtx, type MyBookingService } from '../service/booking.service.js';
import { createMySlotService, type MySlotService } from '../service/slot.service.js';

type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void>; getTenantSettings?(ctx: unknown, i: { keys: string[] }): Promise<{ timezone?: unknown }> } };
type Svc = { slots: MySlotService; bookings: MyBookingService; addresses: AddressService };
type Out = { status: number; body?: Record<string, unknown> };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(permission: string, run: (svc: Svc, ctx: BookingCtx, req: HandlerRequest, tz: () => Promise<{ tz?: string }>) => Promise<Out>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<BookingCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || typeof c.now !== 'function') throw new LimsError('auth.unauthenticated');
    const identity = c.ports?.IdentityPort;
    if (!identity) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await identity.assertRole(hctx, { permission });
    const tz = async () => { const t = identity.getTenantSettings ? (await identity.getTenantSettings(hctx, { keys: ['timezone'] }))?.timezone : undefined; return typeof t === 'string' && t ? { tz: t } : {}; };
    const out = await run({ slots: createMySlotService(), bookings: createMyBookingService(), addresses: createAddressService() }, c as BookingCtx, req, tz);
    const v = out.body?.['version'];
    return { status: out.status, ...(out.body ? { body: out.body } : {}), headers: { 'cache-control': 'no-store', ...(typeof v === 'number' ? { etag: `"${v}"` } : {}) } };
  };
}

const READ = 'engagement.self.read', MANAGE = 'engagement.self.manage', CREATE = 'engagement.booking.create', CANCEL = 'engagement.booking.cancel';
const ok = (body: Record<string, unknown>): Out => ({ status: 200, body });

export const myBookingHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listMyBookableItems: bind(READ, async (s, ctx, req) => ok(await s.slots.items(ctx, { query: req.query }))),
  listMyBookingCentres: bind(READ, async (s, ctx, req) => ok(await s.slots.centres(ctx, { query: req.query }))),
  listMyAvailableSlots: bind(CREATE, async (s, ctx, req, tz) => ok(await s.slots.slots(ctx, { query: req.query, ...(await tz()) }))),
  createMyBooking: bind(CREATE, async (s, ctx, req, tz) => s.bookings.create(ctx, { body: req.body, ...(await tz()) })),
  listMyBookings: bind(READ, (s, ctx, req) => s.bookings.list(ctx, { query: req.query })),
  getMyBooking: bind(READ, (s, ctx, req) => s.bookings.get(ctx, { id: obj(req.params)['booking_id'] })),
  cancelMyBooking: bind(CANCEL, (s, ctx, req) => s.bookings.cancel(ctx, { id: obj(req.params)['booking_id'], headers: req.headers })),
  listMyAddresses: bind(READ, (s, ctx, req) => s.addresses.list(ctx, { query: req.query })),
  createMyAddress: bind(MANAGE, (s, ctx, req) => s.addresses.create(ctx, { body: req.body })),
  updateMyAddress: bind(MANAGE, (s, ctx, req) => s.addresses.update(ctx, { id: obj(req.params)['address_id'], headers: req.headers, body: req.body })),
  deactivateMyAddress: bind(MANAGE, (s, ctx, req) => s.addresses.deactivate(ctx, { id: obj(req.params)['address_id'], headers: req.headers })),
});
