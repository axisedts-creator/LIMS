// S1 listBookings, S2 getBooking, S3 createBookingForPatient, S4 cancelBooking, S5 checkInBooking (02-TRD §4.8 create / cancel / check-in, §4.10 token at check-in, §5 S1-S5, §7.1 events;
// 03-APP-FLOW §4.1 B-1..B-7; 05-SCHEMA bookings; 01-PRD US-EN-12.2-4, 14.1, 14.6, 15.1-3; 07-SECURITY REQ-SEC-017 centre scope, REQ-SEC-080 no echo, REQ-SEC-100 caps, §6 event payload PHI).
// Tenant and actor come from ctx only. The handler asserts IdentityPort.assertRole (floor) before any query; STAFF_C RLS hides other centres' rows, so a foreign booking is "not found" (404 before state / version).
// [CONV] LD-143-style order for S4/S5: If-Match shape (428/400) -> id (400) -> body (400) -> row (404) -> authorizeRow(row centre) -> state (409 booking_invalid_transition) -> version (409) -> write.
// [CONV] Staff cancel is not bound by booking_cancel_cutoff_minutes (patient rule, TRD §4.8). Error details are fixed text: no submitted value is echoed (REQ-SEC-080).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { canTransition, type BookingStatus } from '../domain/booking.state.js';
import { availableSlots, startOfLocalDay, type Blackout, type SlotTemplate } from '../domain/slots.js';
import { publishBookingCancelled, publishBookingConfirmed } from '../events/publish.js';
import * as addressRepo from '../repository/address.repo.js';
import * as defaultRepo from '../repository/booking.repo.js';
import { listCodedSet as defaultListCodedSet } from '../repository/codedsets.repo.js';
import type { Row } from '../repository/booking.repo.js';
import * as myRepo from '../repository/mybooking.repo.js';
import * as slotRepo from '../repository/slot.repo.js';
import * as tokenRepo from '../repository/token.repo.js';
import { createReminderService } from './reminder.service.js';
import { invalid, isUuid, parseIfMatch, patientScope, type SlotCtx } from './slot.service.js';
import { createTokenService, type TokenService } from './token.service.js';

export type BookingRepo = typeof defaultRepo;
export type Authorize = (centreId: string) => Promise<void>;
export interface BookingCtx extends SlotCtx { readonly events: unknown; readonly ports?: { FrontdeskPort?: { getPatientDemographics(ctx: unknown, i: { patientId: string; purpose: string }): Promise<{ sex?: unknown }> } } | any }
type Out = { status: number; body: Record<string, unknown> };

const DAY = 86_400_000;
const DEFAULT_TZ = 'Asia/Kathmandu'; // [CONV] 05-SCHEMA P-15
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const REASON = /^[a-z0-9_]{1,64}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const KINDS = ['centre_visit', 'home_collection'];
const STATUSES = ['confirmed', 'checked_in', 'completed', 'cancelled'];
const CREATE_FIELDS = ['patient_id', 'booking_kind', 'centre_id', 'slot_start', 'orderable_ids', 'home_address'];
const PURPOSE = 'patient_app_link'; // [CONV] DemographicsPurpose value added by CR-C16-007 for the patient sex lookup

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInstant = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
const iso = (v: unknown): string => new Date(v as string).toISOString();
const fe = (path: string, code: string, message: string): FieldError => ({ path, code, message });
/** Strict body keys: an unknown key is refused with a fixed path (the key itself may be hostile and is never echoed). */
const strict = (body: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new LimsError('common.validation_failed', undefined, [fe('/', 'common.unknown_field', 'Unknown field')]);
  return body;
};
const day = (s: unknown): string => (s instanceof Date ? s.toISOString() : String(s)).slice(0, 10);
const hhmm = (s: string): string => (s.length === 5 ? s : s.slice(0, 5));

function scope(ctx: BookingCtx): { tx: any; tenantId: string; userId: string; now: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx || typeof ctx.now !== 'function') throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id, now: iso(ctx.now()) };
}
/** FK / RLS / CHECK refusals mean the target is not visible or not valid for this actor; anything else unexpected fails closed without SQL text. */
function mapDbError(e: unknown): never {
  if (e instanceof LimsError) throw e;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '23503' || code === '42501') throw new LimsError('common.not_found');
  if (code === '23514') return invalid('/', 'common.field_invalid', 'Field invalid');
  throw new LimsError('common.internal');
}

const money = (p: unknown) => (p == null ? {} : { indicative_price: { amount_paisa: Number(p), currency: 'NPR' } });
/** Row (+ items, centre name) -> StaffBooking: contract fields only; null columns are omitted (the schema forbids null). */
function toBody(b: Row, items: Row[], centreName: string): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: b['id'], booking_no: b['booking_no'], booking_kind: b['booking_kind'], centre_id: b['centre_id'], centre_display_name: centreName, slot_start: iso(b['slot_start']), slot_end: iso(b['slot_end']), status: b['status'],
    items: items.map((i) => ({ orderable_id: i['orderable_id'], display_name: i['display_name_snapshot'], ...money(i['indicative_price_paisa']) })),
    created_via: b['created_via'], version: b['version'], patient_id: b['patient_id'], account_present: b['account_id'] != null,
  };
  if (b['home_address_id']) o['home_address_id'] = b['home_address_id'];
  if (b['cancel_reason_code']) o['cancel_reason_code'] = b['cancel_reason_code'];
  if (b['cancelled_by_kind']) o['cancelled_by_kind'] = b['cancelled_by_kind'];
  if (b['order_id']) o['order_id'] = b['order_id'];
  if (b['queue_token_id']) o['queue_token_id'] = b['queue_token_id'];
  if (b['checked_in_at']) o['checked_in_at'] = iso(b['checked_in_at']);
  return o;
}

const localYY = (now: string, tz: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(new Date(now)).slice(-2);

function parseCreate(body: unknown) {
  const b = strict(body, CREATE_FIELDS);
  for (const k of ['patient_id', 'booking_kind', 'slot_start', 'orderable_ids']) if (b[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
  if (!isUuid(b['patient_id'])) invalid('/patient_id');
  if (typeof b['booking_kind'] !== 'string' || !KINDS.includes(b['booking_kind'])) invalid('/booking_kind');
  if (b['centre_id'] !== undefined && !isUuid(b['centre_id'])) invalid('/centre_id');
  if (b['booking_kind'] === 'centre_visit' && b['centre_id'] === undefined) invalid('/centre_id', 'common.field_required', 'Field required');
  if (!isInstant(b['slot_start'])) invalid('/slot_start');
  const ids = b['orderable_ids'];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || !ids.every(isUuid) || new Set(ids).size !== ids.length) invalid('/orderable_ids');
  if (b['home_address'] !== undefined && (b['booking_kind'] !== 'home_collection' || !isObj(b['home_address']))) invalid('/home_address');
  return { patientId: b['patient_id'] as string, kind: b['booking_kind'] as string, centreId: b['centre_id'] as string | undefined, slotStart: b['slot_start'] as string, orderableIds: ids as string[], hasAddress: b['home_address'] !== undefined };
}

function parseList(query: unknown) {
  const q = isObj(query) ? query : {};
  if (!isInstant(q['slot_start_from'])) invalid('/slot_start_from', q['slot_start_from'] === undefined ? 'common.field_required' : 'common.field_invalid', q['slot_start_from'] === undefined ? 'Field required' : 'Field invalid');
  if (!isInstant(q['slot_start_to'])) invalid('/slot_start_to', q['slot_start_to'] === undefined ? 'common.field_required' : 'common.field_invalid', q['slot_start_to'] === undefined ? 'Field required' : 'Field invalid');
  const from = q['slot_start_from'] as string, to = q['slot_start_to'] as string;
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0 || span > 31 * DAY) invalid('/slot_start_to', 'common.field_invalid', 'Range must be 1 ms to 31 days');
  if (q['centre_id'] !== undefined && !isUuid(q['centre_id'])) invalid('/centre_id');
  if (q['booking_kind'] !== undefined && !KINDS.includes(q['booking_kind'] as string)) invalid('/booking_kind');
  let statuses: string[] | undefined;
  if (q['status'] !== undefined) {
    statuses = typeof q['status'] === 'string' ? q['status'].split(',') : Array.isArray(q['status']) ? (q['status'] as unknown[]).map(String) : [];
    if (statuses.length < 1 || statuses.length > 4 || !statuses.every((s) => STATUSES.includes(s))) invalid('/status');
  }
  if (q['sort'] !== undefined && q['sort'] !== 'slot_start' && q['sort'] !== '-slot_start') invalid('/sort');
  const limit = q['limit'] === undefined ? 50 : /^[0-9]{1,3}$/.test(String(q['limit'])) ? Number(q['limit']) : 0;
  if (limit < 1 || limit > 200) invalid('/limit');
  let after: { slotStart: string; id: string } | undefined;
  if (q['cursor'] !== undefined) {
    const [s, id] = typeof q['cursor'] === 'string' && CURSOR.test(q['cursor']) ? Buffer.from(q['cursor'], 'base64url').toString('utf8').split('|') : [];
    if (!isInstant(s) || !isUuid(id)) invalid('/cursor');
    after = { slotStart: s as string, id: id as string };
  }
  return { from, to, centreId: q['centre_id'] as string | undefined, kind: q['booking_kind'] as string | undefined, statuses, desc: q['sort'] === '-slot_start', limit, after };
}

type ResolveArgs = { tenantId: string; centreId: string; kind: string; slotStart: string; now: string; tz: string; s: Row };
/** The slot must be generated by the template algorithm and inside the window (lead, horizon, no blackout); fullness is NOT checked here (that is the 409 at reserve). Shared by the staff (S3) and patient (E33) create. */
async function resolveSlotWith(repo: BookingRepo, tx: any, a: ResolveArgs) {
  const [templates, blackouts] = await Promise.all([slotRepo.activeTemplates(tx, { tenantId: a.tenantId, centreId: a.centreId, bookingKind: a.kind }), repo.activeBlackouts(tx, a)]);
  const bo: Blackout[] = blackouts.map((r) => ({ bookingKind: r['booking_kind'] ?? null, startsAt: new Date(r['starts_at']), endsAt: new Date(r['ends_at']) }));
  const t0 = Date.parse(a.slotStart), d = (n: number) => new Date(t0 + n * DAY).toISOString().slice(0, 10);
  for (const t of templates) {
    const st: SlotTemplate = { weekdays: t['weekdays'], startLocal: hhmm(String(t['start_local'])), endLocal: hhmm(String(t['end_local'])), slotMinutes: t['slot_minutes'], capacity: t['capacity'],
      effectiveFrom: day(t['effective_from']), effectiveTo: t['effective_to'] == null ? null : day(t['effective_to']) };
    const hit = availableSlots({ templates: [st], blackouts: bo, occupancy: [], bookingKind: a.kind, now: new Date(a.now), minLeadMinutes: a.s['booking_min_lead_minutes'], horizonDays: a.s['booking_horizon_days'],
      timeZone: a.tz, dateFrom: d(-1), dateTo: d(1) }).find((x) => x.slotStart.getTime() === t0);
    if (hit) return { template: t, slot: hit };
  }
  throw new LimsError('engagement.slot_outside_window');
}

/** T-B5: engagement.send_booking_message (TRD §8.1: key bmsg:<booking_id>:<kind>, max 8). Payload ids only: no PHI (REQ-SEC-100). */
const enqueueBookingMessage = (tx: any, tenantId: string, bookingId: string, kind: 'confirmation' | 'cancelled') =>
  tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)', ['engagement.send_booking_message', JSON.stringify({ tenant_id: tenantId, booking_id: bookingId, kind }), `bmsg:${bookingId}:${kind}`, null, 8]);

export function createBookingService(deps: { repo?: BookingRepo; tokens?: TokenService; listCodedSet?: typeof defaultListCodedSet } = {}) {
  const repo = deps.repo ?? defaultRepo;
  const listSet = deps.listCodedSet ?? defaultListCodedSet;
  const tokens = deps.tokens ?? createTokenService();
  const reminders = createReminderService();
  const enqueueMessage = enqueueBookingMessage;

  async function respond(tx: any, tenantId: string, b: Row): Promise<Record<string, unknown>> {
    const [items, names] = await Promise.all([repo.itemsOf(tx, { tenantId, bookingIds: [b['id']] }), repo.centreNames(tx, tenantId)]);
    return toBody(b, items, names.find((c) => c['centre_id'] === b['centre_id'])?.['display_name'] ?? '');
  }

  const resolveSlot = (tx: any, a: ResolveArgs) => resolveSlotWith(repo, tx, a);

  return {
    /** S1: filters + keyset page (slot_start, id). The handler has asserted booking.read (for centre_id when given). */
    async list(ctx: BookingCtx, input: { query: unknown }): Promise<Out> {
      const { tx, tenantId } = scope(ctx);
      const p = parseList(input.query);
      try {
        const rows = await repo.listPage(tx, { tenantId, from: p.from, to: p.to, ...(p.centreId ? { centreId: p.centreId } : {}), ...(p.kind ? { kind: p.kind } : {}), ...(p.statuses ? { statuses: p.statuses } : {}), desc: p.desc, limit: p.limit + 1, ...(p.after ? { after: p.after } : {}) });
        const more = rows.length > p.limit, page = rows.slice(0, p.limit);
        const [items, names] = await Promise.all([repo.itemsOf(tx, { tenantId, bookingIds: page.map((r) => r['id']) }), repo.centreNames(tx, tenantId)]);
        const nameOf = new Map(names.map((c) => [c['centre_id'], c['display_name'] as string]));
        const data = page.map((b) => toBody(b, items.filter((i) => i['booking_id'] === b['id']), nameOf.get(b['centre_id']) ?? ''));
        const last = page[page.length - 1];
        return { status: 200, body: { data, page: { limit: p.limit, ...(more && last ? { next_cursor: Buffer.from(`${iso(last['slot_start'])}|${last['id']}`).toString('base64url') } : {}) } } };
      } catch (e) { return mapDbError(e); }
    },

    /** S2: id (400) -> row (404, scope-hidden included) -> authorizeRow. */
    async get(ctx: BookingCtx, input: { id: unknown; authorizeRow: Authorize }): Promise<Out> {
      const { tx, tenantId } = scope(ctx);
      if (!isUuid(input.id)) return invalid('/booking_id');
      try {
        const b = await repo.getBooking(tx, { tenantId, id: input.id });
        if (!b) throw new LimsError('common.not_found');
        await input.authorizeRow(b['centre_id']);
        const [body, trs] = await Promise.all([respond(tx, tenantId, b), repo.transitionsOf(tx, { tenantId, bookingId: b['id'] })]);
        const transitions = trs.map((t) => ({ ...(t['from_status'] ? { from: t['from_status'] } : {}), to: t['to_status'], ...(t['reason_code'] ? { reason_code: t['reason_code'] } : {}), actor_type: t['actor_type'], occurred_at: iso(t['occurred_at']) }));
        return { status: 200, body: { ...body, transitions } };
      } catch (e) { return mapDbError(e); }
    },

    /** S3 (TRD §4.8): body (400) -> centre (400) -> bookings_enabled -> address (422) -> slot window (422) -> orderables (422) -> limit (429) -> reserve (409) -> booking_no -> rows -> event. */
    async create(ctx: BookingCtx, input: { body: unknown; tz?: string }): Promise<Out> {
      const { tx, tenantId, userId, now } = scope(ctx);
      const v = parseCreate(input.body);
      const tz = input.tz ?? DEFAULT_TZ;
      try {
        const s = await repo.settings(tx, tenantId);
        let centre: Row | undefined;
        if (v.kind === 'centre_visit') {
          centre = await repo.bookingCentre(tx, { tenantId, centreId: v.centreId! });
          if (!centre || !centre['is_active']) return invalid('/centre_id', 'common.field_invalid', 'Centre not found'); // D-119: the projection is the only centre source
        }
        if (!s || !s['bookings_enabled']) throw new LimsError('common.feature_disabled');
        if (v.kind === 'home_collection') {
          if (!v.hasAddress) throw new LimsError('engagement.address_required');
          throw new LimsError('common.service_unavailable'); // ponytail: home address rows and the home centre are T-BK1's; the staff home path opens with it
        }
        const { template, slot } = await resolveSlot(tx, { tenantId, centreId: v.centreId!, kind: v.kind, slotStart: v.slotStart, now, tz, s });

        if (v.orderableIds.length > s['max_orderables_per_booking']) throw new LimsError('engagement.orderable_not_bookable');
        const found = new Map((await repo.bookableItems(tx, { tenantId, orderableIds: v.orderableIds })).map((r) => [r['orderable_id'], r]));
        const items = v.orderableIds.map((id) => found.get(id));
        if (items.some((i) => !i || !i['is_active'] || !(i['booking_kinds'] as string[]).includes(v.kind))) throw new LimsError('engagement.orderable_not_bookable');
        if (items.some((i) => i!['sex_restriction'] != null)) { // US-EN-12.5: staff path reads the patient's sex from FrontdeskPort (a NULL / unknown sex is not enforced)
          const sex = (await ctx.ports?.FrontdeskPort?.getPatientDemographics(ctx, { patientId: v.patientId, purpose: PURPOSE }))?.sex;
          if ((sex === 'male' || sex === 'female') && items.some((i) => i!['sex_restriction'] != null && i!['sex_restriction'] !== sex)) throw new LimsError('engagement.orderable_not_bookable');
        }

        if ((await repo.countFutureConfirmed(tx, { tenantId, patientId: v.patientId, now })) >= s['max_active_bookings_per_profile']) throw new LimsError('engagement.booking_limit_reached');

        const slotStart = slot.slotStart.toISOString(), slotEnd = slot.slotEnd.toISOString();
        if (await repo.slotIsFull(tx, { tenantId, centreId: v.centreId!, bookingKind: v.kind, slotStart })) throw new LimsError('engagement.slot_unavailable');
        const occ = await repo.reserve(tx, { tenantId, userId, centreId: v.centreId!, bookingKind: v.kind, slotStart, slotEnd, templateId: template['id'], capacity: slot.capacity });
        if (!occ) throw new LimsError('engagement.slot_unavailable'); // the number is not consumed on this path
        const seq = await repo.nextBookingSeq(tx, { tenantId, userId, yy: localYY(now, tz) });
        const b = await repo.insertBooking(tx, { tenantId, userId, bookingNo: `BK${localYY(now, tz)}${String(seq).padStart(6, '0')}`, patientId: v.patientId, kind: v.kind, branchId: centre!['branch_id'], centreId: v.centreId!,
          occupancyId: occ['id'], slotStart, slotEnd, now });
        for (const [n, i] of items.entries()) {
          await repo.insertItem(tx, { tenantId, userId, bookingId: b['id'], centreId: v.centreId!, orderableId: i!['orderable_id'], kind: i!['orderable_kind'], name: i!['display_name'], pricePaisa: i!['indicative_price_paisa'] ?? null, sortOrder: n });
        }
        await repo.insertTransition(tx, { tenantId, userId, bookingId: b['id'], centreId: v.centreId!, from: null, to: 'confirmed', reason: null, actorType: 'user', now });
        await publishBookingConfirmed(ctx, { bookingId: b['id'], patientId: v.patientId, branchId: centre!['branch_id'], centreId: v.centreId!, bookingKind: v.kind, slotStart, slotEnd, orderableIds: v.orderableIds, confirmedAt: now });
        await reminders.scheduleBookingReminder(ctx, { bookingId: b['id'], patientId: v.patientId, slotStart });   // T-B5 US-EN-25.1: none when the slot is <= H ahead
        await enqueueMessage(tx, tenantId, b['id'], 'confirmation');                                              // T-B5 US-EN-12.8
        return { status: 201, body: toBody(b, items.map((i, n) => ({ ...i!, display_name_snapshot: i!['display_name'], sort_order: n })), centre!['display_name']) };
      } catch (e) { return mapDbError(e); }
    },

    /** S4: shape + row + state + version checks, then conditional UPDATE -> occupancy - 1 -> transition row -> event (idempotent on <booking_id>:cancelled). */
    async cancel(ctx: BookingCtx, input: { id: unknown; headers: unknown; body: unknown; authorizeRow: Authorize }): Promise<Out> {
      const { tx, tenantId, userId, now } = scope(ctx);
      const expected = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/booking_id');
      const body = strict(input.body, ['reason_code']);
      if (typeof body['reason_code'] !== 'string' || !REASON.test(body['reason_code'])) invalid('/reason_code');
      const reason = body['reason_code'] as string;
      try {
        const cur = await repo.getBooking(tx, { tenantId, id: input.id });
        if (!cur) throw new LimsError('common.not_found');
        await input.authorizeRow(cur['centre_id']);
        if (!canTransition(cur['status'] as BookingStatus, 'cancelled')) throw new LimsError('engagement.booking_invalid_transition');
        if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
        // 02-TRD §5 S4: reason_code must be an active code of cs_booking_cancel_reasons (fixed path, no echo — REQ-SEC-080).
        const reasons = await listSet(tx, { tenantId, setName: 'booking_cancel_reasons' });
        if (!reasons.some((r) => r['code'] === reason && r['is_active'] === true)) invalid('/reason_code', 'common.field_invalid', 'Unknown reason');
        const b = await repo.cancel(tx, { tenantId, userId, id: cur['id'], expectedVersion: expected, reason, now });
        if (!b) throw new LimsError('common.version_conflict'); // lost a race between the read and the write
        await repo.release(tx, { tenantId, userId, occupancyId: cur['slot_occupancy_id'] });
        await repo.insertTransition(tx, { tenantId, userId, bookingId: b['id'], centreId: b['centre_id'], from: cur['status'], to: 'cancelled', reason, actorType: 'user', now });
        await publishBookingCancelled(ctx, { bookingId: b['id'], patientId: b['patient_id'], bookingKind: b['booking_kind'], reasonCode: reason, cancelledByKind: 'staff', cancelledAt: now, slotStart: iso(b['slot_start']), orderId: b['order_id'], version: b['version'] });
        await reminders.cancelBookingReminders(ctx, { bookingId: b['id'] });                                      // T-B5 US-EN-25.2
        await enqueueMessage(tx, tenantId, b['id'], 'cancelled');                                                 // T-B5 US-EN-12.8 (cancel SMS, CR-C16-009 / 08 R13)
        return { status: 200, body: await respond(tx, tenantId, b) };
      } catch (e) { return mapDbError(e); }
    },

    /** S5: confirmed -> checked_in only; with issue_token the token is numbered in the same transaction (token.service) and linked both ways. No event. */
    async checkIn(ctx: BookingCtx, input: { id: unknown; headers: unknown; body: unknown; tz?: string; authorizeRow: Authorize }): Promise<Out> {
      const { tx, tenantId, userId, now } = scope(ctx);
      const expected = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/booking_id');
      const body = strict(input.body, ['issue_token', 'queue_id', 'priority']);
      if (typeof body['issue_token'] !== 'boolean') invalid('/issue_token', body['issue_token'] === undefined ? 'common.field_required' : 'common.field_invalid', body['issue_token'] === undefined ? 'Field required' : 'Field invalid');
      if (body['queue_id'] !== undefined && !isUuid(body['queue_id'])) invalid('/queue_id');
      if (body['priority'] !== undefined && body['priority'] !== 'normal' && body['priority'] !== 'priority') invalid('/priority');
      if (body['issue_token'] === true && body['queue_id'] === undefined) invalid('/queue_id', 'common.field_required', 'Field required');
      try {
        const cur = await repo.getBooking(tx, { tenantId, id: input.id });
        if (!cur) throw new LimsError('common.not_found');
        await input.authorizeRow(cur['centre_id']);
        if (!canTransition(cur['status'] as BookingStatus, 'checked_in')) throw new LimsError('engagement.booking_invalid_transition');
        if (cur['version'] !== expected) throw new LimsError('common.version_conflict');
        let token: Record<string, unknown> | undefined;
        if (body['issue_token'] === true) {
          const q = await tokenRepo.getQueue(tx, { tenantId, id: body['queue_id'] as string });
          if (!q) throw new LimsError('common.not_found');
          if (q['centre_id'] !== cur['centre_id']) return invalid('/queue_id', 'common.field_invalid', 'Queue not allowed');
          const out = await tokens.issue(ctx as never, { body: { queue_id: body['queue_id'], booking_id: cur['id'], ...(body['priority'] ? { priority: body['priority'] } : {}) }, now, tz: input.tz ?? DEFAULT_TZ, authorizeRow: input.authorizeRow });
          token = out.body as Record<string, unknown>;
        }
        const b = await repo.checkIn(tx, { tenantId, userId, id: cur['id'], expectedVersion: expected, tokenId: token ? (token['id'] as string) : null, now });
        if (!b) throw new LimsError('common.version_conflict'); // the surrounding transaction rolls the token back
        await repo.insertTransition(tx, { tenantId, userId, bookingId: b['id'], centreId: b['centre_id'], from: 'confirmed', to: 'checked_in', reason: null, actorType: 'user', now });
        return { status: 200, body: { booking: await respond(tx, tenantId, b), ...(token ? { token } : {}) } };
      } catch (e) { return mapDbError(e); }
    },
  };
}
export type BookingService = ReturnType<typeof createBookingService>;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Patient side (T-BK1): E33 createMyBooking (+ reschedule), E34 listMyBookings, E35 getMyBooking, E36 cancelMyBooking (02-TRD §4.8, §5; 03-APP-FLOW §4.1 B-1 / B-3, §6.1, §6.2; 01-PRD US-EN-12.1-8, 13.1-2, 14.1-3;
// 07-SECURITY AB-6 / AB-7 / AB-10, REQ-SEC-024 / 098 / 100). Patient actors only (patientScope); the account comes from the signed membership claim, profile_id = the caller's ACTIVE link id (never patient_id),
// the sex for the item restriction from the link's sex_snapshot (no FrontdeskPort in the patient path). Foreign / staff-entered / other-tenant ids are 404 before state or version (AB-6).
// [CONV] Create order (TRD §4.8): body (400) -> profile (404) -> bookings_enabled (403) -> kind / centre / address -> slot window (422) -> orderables (422) -> [reschedule: old booking] -> limits (429) -> reserve (409) -> booking_no -> rows -> event.
// [CONV] Reschedule = E33 with replaces_booking_id (+ replaces_booking_version, the If-Match of the old booking): ONE transaction, the old booking is cancelled (reason patient_request, by patient) BEFORE the limit checks, so it does
//        not count against them; any later refusal rolls the cancel back with the transaction. No cancel SMS for the old booking (the new confirmation SMS is the message).
// [CONV] The account row is locked FOR UPDATE at create so one account's concurrent creates cannot overshoot the per-profile / per-day caps. The per-day cap counts bookings CREATED since local midnight (cancelled ones included).
// [CONV] Reminders (US-EN-25.1) are not scheduled from the patient path: engagement.reminders is staff-scoped (STAFF_C), a patient session cannot write it. Open point for the orchestrator.
const MY_FIELDS = ['profile_id', 'booking_kind', 'centre_id', 'slot_start', 'orderable_ids', 'home_address_id', 'replaces_booking_id', 'replaces_booking_version'];
const MY_DEFAULT_LIMIT = 50, MY_MAX_LIMIT = 200, DEFAULT_CUTOFF_MIN = 60;

function parseMyCreate(body: unknown) {
  const b = strict(body, MY_FIELDS);
  for (const k of ['profile_id', 'booking_kind', 'slot_start', 'orderable_ids']) if (b[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
  if (!isUuid(b['profile_id'])) invalid('/profile_id');
  if (typeof b['booking_kind'] !== 'string' || !KINDS.includes(b['booking_kind'])) invalid('/booking_kind');
  if (b['centre_id'] !== undefined && !isUuid(b['centre_id'])) invalid('/centre_id');
  if (b['booking_kind'] === 'centre_visit' && b['centre_id'] === undefined) invalid('/centre_id', 'common.field_required', 'Field required');
  if (!isInstant(b['slot_start'])) invalid('/slot_start');
  const ids = b['orderable_ids'];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || !ids.every(isUuid) || new Set(ids).size !== ids.length) invalid('/orderable_ids');
  if (b['home_address_id'] !== undefined && (b['booking_kind'] !== 'home_collection' || !isUuid(b['home_address_id']))) invalid('/home_address_id');
  const rid = b['replaces_booking_id'], rv = b['replaces_booking_version'];
  if (rid !== undefined && !isUuid(rid)) invalid('/replaces_booking_id');
  if (rid !== undefined && rv === undefined) invalid('/replaces_booking_version', 'common.field_required', 'Field required'); // the If-Match of the replaced booking
  if (rv !== undefined && (rid === undefined || typeof rv !== 'number' || !Number.isSafeInteger(rv) || rv < 1 || rv > 2147483647)) invalid('/replaces_booking_version');
  return { profileId: b['profile_id'] as string, kind: b['booking_kind'] as string, centreId: b['centre_id'] as string | undefined, slotStart: b['slot_start'] as string, orderableIds: ids as string[],
    homeAddressId: b['home_address_id'] as string | undefined, replacesId: rid as string | undefined, replacesVersion: rv as number | undefined };
}

export function createMyBookingService(deps: { repo?: BookingRepo } = {}) {
  const repo = deps.repo ?? defaultRepo;

  /** Booking -> Booking schema: contract fields only, NULL columns omitted, profile_id = the link id, never patient_id; cancellable_until only while confirmed. */
  async function respond(tx: any, tenantId: string, b: Row, cutoffMin: number): Promise<Record<string, unknown>> {
    const [items, names] = await Promise.all([repo.itemsOf(tx, { tenantId, bookingIds: [b['id']] }), repo.centreNames(tx, tenantId)]);
    return myBody(b, items, names.find((c) => c['centre_id'] === b['centre_id'])?.['display_name'] ?? '', cutoffMin);
  }
  function myBody(b: Row, items: Row[], centreName: string, cutoffMin: number): Record<string, unknown> {
    const o: Record<string, unknown> = {
      id: b['id'], booking_no: b['booking_no'], profile_id: b['link_id'], booking_kind: b['booking_kind'], centre_id: b['centre_id'], centre_display_name: centreName, slot_start: iso(b['slot_start']), slot_end: iso(b['slot_end']),
      status: b['status'], items: items.map((i) => ({ orderable_id: i['orderable_id'], display_name: i['display_name_snapshot'], ...money(i['indicative_price_paisa']) })), created_via: b['created_via'], version: b['version'],
    };
    if (b['home_address_id']) o['home_address_id'] = b['home_address_id'];
    if (b['status'] === 'confirmed') o['cancellable_until'] = new Date(Date.parse(iso(b['slot_start'])) - cutoffMin * 60_000).toISOString();
    if (b['cancel_reason_code']) o['cancel_reason_code'] = b['cancel_reason_code'];
    return o;
  }
  const cutoffOf = (s: Row | undefined): number => s?.['booking_cancel_cutoff_minutes'] ?? DEFAULT_CUTOFF_MIN;
  const mine = async (tx: any, tenantId: string, membershipId: string, lock = false): Promise<Row> => {
    const acc = await myRepo.account(tx, { tenantId, membershipId, lock });
    if (!acc) throw new LimsError('common.not_found');
    return acc;
  };

  /** state (409 invalid_transition: only `confirmed` can be cancelled by the patient) -> version (409) -> cutoff (409 not_cancellable) -> conditional UPDATE -> occupancy - 1 -> transition -> event. The caller found `cur` among the account's own rows. */
  async function cancelOwn(ctx: BookingCtx, a: { tx: any; tenantId: string; userId: string; now: string; accountId: string; cur: Row; expected: number; cutoffMin: number }): Promise<Row> {
    const { tx, tenantId, userId, now, accountId, cur } = a;
    if (cur['status'] !== 'confirmed') throw new LimsError('engagement.booking_invalid_transition');
    if (cur['version'] !== a.expected) throw new LimsError('common.version_conflict');
    if (Date.parse(now) > Date.parse(iso(cur['slot_start'])) - a.cutoffMin * 60_000) throw new LimsError('engagement.booking_not_cancellable');
    const b = await myRepo.cancelMine(tx, { tenantId, userId, accountId, id: cur['id'], expectedVersion: a.expected, reason: 'patient_request', now });
    if (!b) throw new LimsError('common.version_conflict'); // lost a race between the read and the write
    await repo.release(tx, { tenantId, userId, occupancyId: cur['slot_occupancy_id'] });
    await myRepo.insertTransition(tx, { tenantId, userId, bookingId: b['id'], accountId, centreId: b['centre_id'], from: 'confirmed', to: 'cancelled', reason: 'patient_request', now });
    await publishBookingCancelled(ctx, { bookingId: b['id'], patientId: b['patient_id'], bookingKind: b['booking_kind'], reasonCode: 'patient_request', cancelledByKind: 'patient', cancelledAt: now, slotStart: iso(b['slot_start']), orderId: b['order_id'], version: b['version'] });
    return b;
  }

  return {
    /** E33 (+ reschedule). */
    async create(ctx: BookingCtx, input: { body: unknown; tz?: string }): Promise<Out> {
      const { tx, tenantId, userId, now, membershipId } = patientScope(ctx);
      const v = parseMyCreate(input.body);
      const tz = input.tz ?? DEFAULT_TZ;
      try {
        const acc = await mine(tx, tenantId, membershipId, true);
        const link = (await myRepo.activeLinks(tx, { tenantId, accountId: acc['id'] })).find((l) => l.id === v.profileId);
        if (!link) throw new LimsError('common.not_found'); // another account's profile, a revoked / suspended link, a patient id, an unknown id: all the same 404 (AB-6, P-L5)
        const s = await myRepo.settings(tx, tenantId);
        if (!s || !s['bookings_enabled']) throw new LimsError('common.feature_disabled');
        let centreId = v.centreId as string;
        if (v.kind === 'home_collection') {
          if (!s['home_collection_enabled'] || typeof s['home_collection_centre_id'] !== 'string') throw new LimsError('common.feature_disabled');
          if (v.centreId !== undefined && v.centreId !== s['home_collection_centre_id']) return invalid('/centre_id', 'common.field_invalid', 'Centre not allowed');
          centreId = s['home_collection_centre_id'];
        }
        const centre = await repo.bookingCentre(tx, { tenantId, centreId });
        if (!centre || !centre['is_active']) return invalid('/centre_id', 'common.field_invalid', 'Centre not found'); // D-119: the projection is the only centre source
        if (v.kind === 'home_collection') {
          if (!v.homeAddressId) throw new LimsError('engagement.address_required');
          const ad = await addressRepo.getMine(tx, { tenantId, accountId: acc['id'], id: v.homeAddressId });
          if (!ad || !ad['is_active'] || ad['patient_id'] !== link.patientId) throw new LimsError('common.not_found'); // another account's / staff-entered / other profile's / deactivated address
        }
        const { template, slot } = await resolveSlotWith(repo, tx, { tenantId, centreId, kind: v.kind, slotStart: v.slotStart, now, tz, s });

        if (v.orderableIds.length > s['max_orderables_per_booking']) throw new LimsError('engagement.orderable_not_bookable');
        const found = new Map((await repo.bookableItems(tx, { tenantId, orderableIds: v.orderableIds })).map((r) => [r['orderable_id'], r]));
        const items = v.orderableIds.map((id) => found.get(id));
        if (items.some((i) => !i || !i['is_active'] || !(i['booking_kinds'] as string[]).includes(v.kind))) throw new LimsError('engagement.orderable_not_bookable');
        if ((link.sex === 'male' || link.sex === 'female') && items.some((i) => i!['sex_restriction'] != null && i!['sex_restriction'] !== link.sex)) throw new LimsError('engagement.orderable_not_bookable'); // unknown sex: not enforced (US-EN-12.5)

        if (v.replacesId) { // reschedule: the old booking must be the caller's own, of the same profile, cancellable now, at the version the caller saw
          const old = await myRepo.getMine(tx, { tenantId, accountId: acc['id'], id: v.replacesId });
          if (!old) throw new LimsError('common.not_found');
          if (old['link_id'] !== link.id) return invalid('/replaces_booking_id', 'common.field_invalid', 'Booking belongs to another profile');
          await cancelOwn(ctx, { tx, tenantId, userId, now, accountId: acc['id'], cur: old, expected: v.replacesVersion!, cutoffMin: cutoffOf(s) });
        }

        if ((await myRepo.countActiveOfLink(tx, { tenantId, linkId: link.id, now })) >= s['max_active_bookings_per_profile']) throw new LimsError('engagement.booking_limit_reached');
        if ((await myRepo.countCreatedSince(tx, { tenantId, accountId: acc['id'], since: startOfLocalDay(new Date(now), tz).toISOString() })) >= s['max_bookings_created_per_account_day']) throw new LimsError('engagement.booking_limit_reached');

        const slotStart = slot.slotStart.toISOString(), slotEnd = slot.slotEnd.toISOString();
        if (await repo.slotIsFull(tx, { tenantId, centreId, bookingKind: v.kind, slotStart })) throw new LimsError('engagement.slot_unavailable');
        const occ = await repo.reserve(tx, { tenantId, userId, centreId, bookingKind: v.kind, slotStart, slotEnd, templateId: template['id'], capacity: slot.capacity });
        if (!occ) throw new LimsError('engagement.slot_unavailable'); // the number is not consumed on this path
        const yy = localYY(now, tz);
        const seq = await repo.nextBookingSeq(tx, { tenantId, userId, yy });
        const b = await myRepo.insertBooking(tx, { tenantId, userId, accountId: acc['id'], linkId: link.id, bookingNo: `BK${yy}${String(seq).padStart(6, '0')}`, patientId: link.patientId, kind: v.kind, branchId: centre['branch_id'], centreId,
          occupancyId: occ['id'], slotStart, slotEnd, homeAddressId: v.homeAddressId ?? null, replacesId: v.replacesId ?? null, now });
        for (const [n, i] of items.entries()) {
          await myRepo.insertItem(tx, { tenantId, userId, bookingId: b['id'], accountId: acc['id'], centreId, orderableId: i!['orderable_id'], kind: i!['orderable_kind'], name: i!['display_name'], pricePaisa: i!['indicative_price_paisa'] ?? null, sortOrder: n });
        }
        await myRepo.insertTransition(tx, { tenantId, userId, bookingId: b['id'], accountId: acc['id'], centreId, from: null, to: 'confirmed', reason: null, now });
        await publishBookingConfirmed(ctx, { bookingId: b['id'], patientId: link.patientId, branchId: centre['branch_id'], centreId, bookingKind: v.kind, slotStart, slotEnd, orderableIds: v.orderableIds, confirmedAt: now, homeAddressId: v.homeAddressId ?? null });
        await enqueueBookingMessage(tx, tenantId, b['id'], 'confirmation'); // US-EN-12.8
        return { status: 201, body: myBody(b, items.map((i, n) => ({ ...i!, display_name_snapshot: i!['display_name'], sort_order: n })), centre['display_name'], cutoffOf(s)) };
      } catch (e) { return mapDbError(e); }
    },

    /** E34: the caller's own bookings, newest slot first; `status` narrows; keyset cursor on (slot_start, id). */
    async list(ctx: BookingCtx, input: { query: unknown }): Promise<Out> {
      const { tx, tenantId, membershipId } = patientScope(ctx);
      const q = isObj(input.query) ? input.query : {};
      if (q['status'] !== undefined && (typeof q['status'] !== 'string' || !STATUSES.includes(q['status']))) invalid('/status');
      if (q['sort'] !== undefined && q['sort'] !== '-slot_start') invalid('/sort');
      const limit = q['limit'] === undefined ? MY_DEFAULT_LIMIT : /^[0-9]{1,3}$/.test(String(q['limit'])) ? Number(q['limit']) : 0;
      if (limit < 1 || limit > MY_MAX_LIMIT) invalid('/limit');
      let after: { slotStart: string; id: string } | undefined;
      if (q['cursor'] !== undefined) {
        const [s, id] = typeof q['cursor'] === 'string' && CURSOR.test(q['cursor']) ? Buffer.from(q['cursor'], 'base64url').toString('utf8').split('|') : [];
        if (!isInstant(s) || !isUuid(id)) invalid('/cursor');
        after = { slotStart: s as string, id: id as string };
      }
      try {
        const acc = await mine(tx, tenantId, membershipId);
        const rows = await myRepo.listMine(tx, { tenantId, accountId: acc['id'], ...(q['status'] ? { status: q['status'] as string } : {}), limit: limit + 1, ...(after ? { after } : {}) });
        const more = rows.length > limit, page = rows.slice(0, limit);
        const [items, names, s] = await Promise.all([repo.itemsOf(tx, { tenantId, bookingIds: page.map((r) => r['id']) }), repo.centreNames(tx, tenantId), myRepo.settings(tx, tenantId)]);
        const nameOf = new Map(names.map((c) => [c['centre_id'], c['display_name'] as string]));
        const data = page.map((b) => myBody(b, items.filter((i) => i['booking_id'] === b['id']), nameOf.get(b['centre_id']) ?? '', cutoffOf(s)));
        const last = page[page.length - 1];
        return { status: 200, body: { data, page: { limit, ...(more && last ? { next_cursor: Buffer.from(`${iso(last['slot_start'])}|${last['id']}`).toString('base64url') } : {}) } } };
      } catch (e) { return mapDbError(e); }
    },

    /** E35: id (400) -> own row (404). */
    async get(ctx: BookingCtx, input: { id: unknown }): Promise<Out> {
      const { tx, tenantId, membershipId } = patientScope(ctx);
      if (!isUuid(input.id)) return invalid('/booking_id'); // booking numbers never go in paths (REQ-SEC-098)
      try {
        const acc = await mine(tx, tenantId, membershipId);
        const b = await myRepo.getMine(tx, { tenantId, accountId: acc['id'], id: input.id });
        if (!b) throw new LimsError('common.not_found');
        return { status: 200, body: await respond(tx, tenantId, b, cutoffOf(await myRepo.settings(tx, tenantId))) };
      } catch (e) { return mapDbError(e); }
    },

    /** E36: If-Match (428 / 400, before any DB access) -> id (400) -> own row (404) -> state (409) -> version (409) -> cutoff (409) -> write. */
    async cancel(ctx: BookingCtx, input: { id: unknown; headers: unknown }): Promise<Out> {
      const { tx, tenantId, userId, now, membershipId } = patientScope(ctx);
      const expected = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/booking_id');
      try {
        const acc = await mine(tx, tenantId, membershipId);
        const cur = await myRepo.getMine(tx, { tenantId, accountId: acc['id'], id: input.id });
        if (!cur) throw new LimsError('common.not_found');
        const s = await myRepo.settings(tx, tenantId), cutoffMin = cutoffOf(s);
        const b = await cancelOwn(ctx, { tx, tenantId, userId, now, accountId: acc['id'], cur, expected, cutoffMin });
        await enqueueBookingMessage(tx, tenantId, b['id'], 'cancelled'); // US-EN-12.8 (cancel SMS)
        return { status: 200, body: await respond(tx, tenantId, b, cutoffMin) };
      } catch (e) { return mapDbError(e); }
    },
  };
}
export type MyBookingService = ReturnType<typeof createMyBookingService>;
