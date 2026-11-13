// S6 getSlotAvailability, S7-S10 slot templates, S11 blackouts (02-TRD §4.8, §5; 05-SCHEMA slot_templates / slot_blackouts / slot_occupancy; 01-PRD US-EN-16.1-4; 07-SECURITY §6.4, REQ-SEC-017, REQ-SEC-080).
// Tenant and actor come from ctx only. The handler asserts IdentityPort.assertRole before any query; STAFF_C RLS hides other centres' rows, so a foreign object is "not found" (404 before the version is compared).
// Template times are stored as LOCAL wall-clock 'HH:MM' (never converted to UTC); S6 converts per local date in the tenant timezone via domain/slots.ts.
// Template save (S8/S9/S10) enqueues engagement.sync_booking_centres in the same tx (08 A19 D-119, TRD §8.1). Error details are fixed text (REQ-SEC-080).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { generateSlots } from '../domain/slots.js';
import * as defaultRepo from '../repository/slot.repo.js';
import type { Row, TemplateValues } from '../repository/slot.repo.js';

export interface SlotCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: unknown;
  readonly now: () => string;
}
export type SlotRepo = typeof defaultRepo;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const ISO_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const KINDS = ['centre_visit', 'home_collection'] as const;
const REASONS = ['holiday', 'maintenance', 'other'] as const;
const TEMPLATE_FIELDS = ['centre_id', 'booking_kind', 'weekdays', 'start_local', 'end_local', 'slot_minutes', 'capacity', 'effective_from', 'effective_to'];
const BLACKOUT_FIELDS = ['centre_id', 'booking_kind', 'starts_at', 'ends_at', 'reason_code', 'note'];
const DAY = 86_400_000;
const DEFAULT_TZ = 'Asia/Kathmandu'; // [CONV] 05-SCHEMA P-15: the only v1 tenant timezone

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const fe = (path: string, code: string, message: string): FieldError => ({ path, code, message });
export const invalid = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [fe(path, code, message)]);
};
const isDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v; // rejects 2026-13-01 and 2026-02-30
};
const isInstant = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v));
const isKind = (v: unknown): v is (typeof KINDS)[number] => KINDS.includes(v as never);
const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;
const hhmm = (s: string): string => (s.length === 5 ? s : s.slice(0, 5)); // pg time 'HH:MM:SS' -> 'HH:MM'
const day = (s: unknown): string => (s instanceof Date ? s.toISOString() : String(s)).slice(0, 10); // pg date -> 'YYYY-MM-DD'
const iso = (s: unknown): string => new Date(s as string).toISOString();

function scope(ctx: SlotCtx): { tx: any; tenantId: string; userId: string; now: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id, now: iso(ctx.now()) };
}

/** If-Match arrives as the raw header '"<version>"' (02-CV §4.2): absent -> 428, malformed -> 400. */
export function parseIfMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  const n = m ? Number(m[1]) : 0;
  if (n < 1 || n > 2147483647) return invalid('/If-Match');
  return n;
}

function parseActive(v: unknown): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return invalid('/is_active');
}
function parseCentreFilter(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  return isUuid(v) ? v : invalid('/centre_id');
}

/** Template body (strict: unknown fields such as tenant_id / version / id / is_active are refused; PUT = full replacement; effective_to optional). */
function parseTemplate(body: unknown): { centreId: string; v: TemplateValues } {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (!TEMPLATE_FIELDS.includes(k)) invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
  for (const k of TEMPLATE_FIELDS) if (k !== 'effective_to' && body[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
  const w = body['weekdays'];
  if (!isUuid(body['centre_id'])) invalid('/centre_id');
  if (!isKind(body['booking_kind'])) invalid('/booking_kind');
  if (!Array.isArray(w) || w.length < 1 || w.length > 7 || !w.every((d) => int(d, 1, 7)) || new Set(w).size !== w.length) invalid('/weekdays');
  if (typeof body['start_local'] !== 'string' || !HHMM.test(body['start_local'])) invalid('/start_local');
  if (typeof body['end_local'] !== 'string' || !HHMM.test(body['end_local'])) invalid('/end_local');
  if ((body['end_local'] as string) <= (body['start_local'] as string)) invalid('/end_local', 'common.field_invalid', 'End must be after start');
  const sm = body['slot_minutes'];
  if (!int(sm, 5, 240) || sm % 5 !== 0) invalid('/slot_minutes');
  if (!int(body['capacity'], 1, 100)) invalid('/capacity');
  if (!isDate(body['effective_from'])) invalid('/effective_from');
  const to = body['effective_to'];
  if (to !== undefined && !isDate(to)) invalid('/effective_to');
  if (typeof to === 'string' && to < (body['effective_from'] as string)) invalid('/effective_to', 'common.field_invalid', 'Must not be before effective_from');
  return {
    centreId: body['centre_id'] as string,
    v: {
      bookingKind: body['booking_kind'] as string, weekdays: [...(w as number[])].sort((a, b) => a - b), startLocal: body['start_local'] as string, endLocal: body['end_local'] as string,
      slotMinutes: sm as number, capacity: body['capacity'] as number, effectiveFrom: body['effective_from'] as string, effectiveTo: typeof to === 'string' ? to : null,
    },
  };
}

function parseBlackout(body: unknown) {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (!BLACKOUT_FIELDS.includes(k)) invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
  for (const k of ['centre_id', 'starts_at', 'ends_at', 'reason_code']) if (body[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
  const kind = body['booking_kind'];
  if (!isUuid(body['centre_id'])) invalid('/centre_id');
  if (kind !== undefined && !isKind(kind)) invalid('/booking_kind');
  if (!isInstant(body['starts_at'])) invalid('/starts_at');
  if (!isInstant(body['ends_at'])) invalid('/ends_at');
  const a = Date.parse(body['starts_at'] as string), b = Date.parse(body['ends_at'] as string);
  if (b <= a || b - a > 31 * DAY) invalid('/ends_at', 'common.field_invalid', 'Range must be 1 ms to 31 days');
  if (!REASONS.includes(body['reason_code'] as never)) invalid('/reason_code');
  const note = body['note'];
  if (note !== undefined && (typeof note !== 'string' || note.length > 200)) invalid('/note');
  return { centreId: body['centre_id'] as string, bookingKind: (kind as string | undefined) ?? null, startsAt: body['starts_at'] as string, endsAt: body['ends_at'] as string, reasonCode: body['reason_code'] as string, note: (note as string | undefined) ?? null };
}

function templateBody(r: Row): Record<string, unknown> {
  return {
    id: r['id'], centre_id: r['centre_id'], booking_kind: r['booking_kind'], weekdays: r['weekdays'], start_local: hhmm(String(r['start_local'])), end_local: hhmm(String(r['end_local'])),
    slot_minutes: r['slot_minutes'], capacity: r['capacity'], effective_from: day(r['effective_from']),
    ...(r['effective_to'] == null ? {} : { effective_to: day(r['effective_to']) }), is_active: r['is_active'], version: r['version'],
  };
}
function blackoutBody(r: Row): Record<string, unknown> {
  return {
    id: r['id'], centre_id: r['centre_id'], ...(r['booking_kind'] == null ? {} : { booking_kind: r['booking_kind'] }), starts_at: iso(r['starts_at']), ends_at: iso(r['ends_at']),
    reason_code: r['reason_code'], ...(r['note'] == null ? {} : { note: r['note'] }), is_active: r['is_active'], version: r['version'],
  };
}

/** Overlap rule (TRD §4.8): same tenant + centre + kind (the candidates), both active, shared weekday, time ranges overlap (edges exclusive), effective ranges overlap (inclusive, NULL = open). */
function overlaps(v: TemplateValues, o: Row): boolean {
  if (!(o['weekdays'] as number[]).some((d) => v.weekdays.includes(d))) return false;
  if (!(v.startLocal < hhmm(String(o['end_local'])) && hhmm(String(o['start_local'])) < v.endLocal)) return false;
  const oFrom = day(o['effective_from']), oTo = o['effective_to'] == null ? null : day(o['effective_to']);
  return (oTo === null || v.effectiveFrom <= oTo) && (v.effectiveTo === null || oFrom <= v.effectiveTo);
}

/** Unexpected DB errors fail closed without SQL text; RLS / FK refusals mean the target is not visible to this actor. */
function mapDbError(e: unknown, op: 'create' | 'update'): never {
  if (e instanceof LimsError) throw e;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '42501' || code === '23503') {
    if (op === 'create') return invalid('/centre_id', 'common.field_invalid', 'Centre not found');
    throw new LimsError('common.not_found');
  }
  if (code === '23514') return invalid('/', 'common.field_invalid', 'Field invalid');
  throw new LimsError('common.internal');
}

export function createSlotService(deps: { repo?: SlotRepo } = {}) {
  const repo = deps.repo ?? defaultRepo;

  async function checkOverlap(tx: any, tenantId: string, centreId: string, v: TemplateValues, selfId?: string) {
    await repo.lockScope(tx, { tenantId, centreId, bookingKind: v.bookingKind });
    const others = await repo.activeTemplates(tx, { tenantId, centreId, bookingKind: v.bookingKind });
    if (others.some((o) => o['id'] !== selfId && overlaps(v, o))) invalid('/start_local', 'common.field_invalid', 'Overlaps an active template of this centre and kind');
  }
  /** Future slots of the template whose booked count exceeds its CURRENT capacity. */
  async function overbookedSlots(tx: any, tenantId: string, templateId: string, capacity: number, now: string): Promise<number> {
    return (await repo.futureOccupancyOfTemplate(tx, { tenantId, templateId, now })).filter((r) => r['booked'] > capacity).length;
  }

  return {
    /** S6. Handler has asserted booking.read for the centre. remaining is clamped to the contract maximum 9. No blackout exclusion for staff (spec silent). */
    async availability(ctx: SlotCtx, input: { query: unknown; timeZone?: string }) {
      const { tx, tenantId } = scope(ctx);
      const q = isObj(input.query) ? input.query : {};
      if (!isUuid(q['centre_id'])) invalid('/centre_id');
      if (!isKind(q['booking_kind'])) invalid('/booking_kind');
      if (!isDate(q['date_from'])) invalid('/date_from');
      if (!isDate(q['date_to'])) invalid('/date_to');
      const from = q['date_from'] as string, to = q['date_to'] as string, kind = q['booking_kind'] as string, centreId = q['centre_id'] as string;
      const days = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY + 1;
      if (days < 1 || days > 14) invalid('/date_to', 'common.field_invalid', 'Range must be 1 to 14 days');
      const tz = input.timeZone ?? DEFAULT_TZ;
      const templates = (await repo.activeTemplates(tx, { tenantId, centreId, bookingKind: kind })).map((t) => ({
        weekdays: t['weekdays'] as number[], startLocal: hhmm(String(t['start_local'])), endLocal: hhmm(String(t['end_local'])), slotMinutes: t['slot_minutes'] as number,
        capacity: t['capacity'] as number, effectiveFrom: day(t['effective_from']), effectiveTo: t['effective_to'] == null ? null : day(t['effective_to']),
      }));
      const slots: Array<{ start: number; end: number; capacity: number }> = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(Date.parse(`${from}T00:00:00.000Z`) + i * DAY).toISOString().slice(0, 10);
        for (const t of templates) for (const s of generateSlots({ template: t, localDate: d, timeZone: tz })) slots.push({ start: s.slotStart.getTime(), end: s.slotEnd.getTime(), capacity: t.capacity });
      }
      slots.sort((a, b) => a.start - b.start);
      const occ = new Map<number, { capacity: number; booked: number }>();
      if (slots.length) {
        const lo = new Date(slots[0]!.start).toISOString(), hi = new Date(slots[slots.length - 1]!.start + 1).toISOString();
        for (const o of await repo.occupancyInRange(tx, { tenantId, centreId, bookingKind: kind, from: lo, to: hi })) occ.set(Date.parse(iso(o['slot_start'])), { capacity: Number(o['capacity']), booked: Number(o['booked']) });
      }
      const data = slots.slice(0, 2000).map((s) => { // contract maxItems 2000
        const o = occ.get(s.start), b = o?.booked ?? 0, cap = o?.capacity ?? s.capacity; // TRD §4.8: occupancy row's capacity; absent row = template capacity
        return { slot_start: new Date(s.start).toISOString(), slot_end: new Date(s.end).toISOString(), remaining: Math.min(9, Math.max(0, cap - b)), booking_kind: kind, centre_id: centreId, capacity: cap, booked: b, overbooked: b > cap };
      });
      return { data };
    },

    async listTemplates(ctx: SlotCtx, input: { centreId: unknown; isActive: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const centreId = parseCentreFilter(input.centreId), isActive = parseActive(input.isActive);
      const rows = await repo.listTemplates(tx, { tenantId, ...(centreId === undefined ? {} : { centreId }), ...(isActive === undefined ? {} : { isActive }) });
      return { data: rows.map(templateBody) };
    },

    /** The handler has asserted slot.manage for the body's centre. Order: body (400) -> centre visible (400 /centre_id) -> overlap (400 /start_local) -> INSERT -> enqueue. */
    async createTemplate(ctx: SlotCtx, input: { body: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const { centreId, v } = parseTemplate(input.body);
      try {
        if (!(await repo.centreExists(tx, { tenantId, centreId }))) return invalid('/centre_id', 'common.field_invalid', 'Centre not found');
        await checkOverlap(tx, tenantId, centreId, v);
        const row = await repo.insertTemplate(tx, { tenantId, userId, centreId, v });
        if (!row) throw new LimsError('common.internal');
        await repo.enqueueCentreSync(tx, { tenantId });
        return templateBody(row);
      } catch (e) { return mapDbError(e, 'create'); }
    },

    /** Order: If-Match (428/400) -> id (400) -> body (400) -> row (404, scope-hidden included) -> authorizeRow -> centre unchanged -> version (409) -> overlap (400) -> UPDATE -> affected -> enqueue. */
    async updateTemplate(ctx: SlotCtx, input: { id: unknown; headers: unknown; body: unknown; authorizeRow: (centreId: string) => Promise<void> }) {
      const { tx, tenantId, userId, now } = scope(ctx);
      const expectedVersion = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/id');
      const { centreId, v } = parseTemplate(input.body);
      try {
        const current = await repo.getTemplate(tx, { tenantId, id: input.id });
        if (!current) throw new LimsError('common.not_found');
        await input.authorizeRow(current['centre_id']);
        if (centreId !== current['centre_id']) return invalid('/centre_id', 'common.field_invalid', 'Centre cannot be changed');
        if (current['version'] !== expectedVersion) throw new LimsError('common.version_conflict');
        if (current['is_active']) await checkOverlap(tx, tenantId, centreId, v, input.id);
        const row = await repo.updateTemplate(tx, { tenantId, userId, id: input.id, expectedVersion, v });
        if (!row) throw new LimsError('common.version_conflict'); // lost a race between the read and the write
        await repo.syncOccupancyCapacity(tx, { tenantId, userId, templateId: input.id, capacity: v.capacity, now }); // review T-B2 #1
        const overbooked = await overbookedSlots(tx, tenantId, input.id, v.capacity, now);
        await repo.enqueueCentreSync(tx, { tenantId });
        return { ...templateBody(row), affected: { overbooked_slots: overbooked } };
      } catch (e) { return mapDbError(e, 'update'); }
    },

    async deactivateTemplate(ctx: SlotCtx, input: { id: unknown; headers: unknown; authorizeRow: (centreId: string) => Promise<void> }) {
      const { tx, tenantId, userId, now } = scope(ctx);
      const expectedVersion = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/id');
      try {
        const current = await repo.getTemplate(tx, { tenantId, id: input.id });
        if (!current) throw new LimsError('common.not_found');
        await input.authorizeRow(current['centre_id']);
        if (current['version'] !== expectedVersion) throw new LimsError('common.version_conflict');
        const occupancy = await repo.futureOccupancyOfTemplate(tx, { tenantId, templateId: input.id, now });
        const row = await repo.deactivateTemplate(tx, { tenantId, userId, id: input.id, expectedVersion });
        if (!row) throw new LimsError('common.version_conflict');
        const futureBookings = await repo.countConfirmedOnOccupancy(tx, { tenantId, occupancyIds: occupancy.map((o) => o['id']), now });
        await repo.enqueueCentreSync(tx, { tenantId });
        return { ...templateBody(row), affected: { future_bookings: futureBookings } };
      } catch (e) { return mapDbError(e, 'update'); }
    },

    async listBlackouts(ctx: SlotCtx, input: { centreId: unknown; isActive: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const centreId = parseCentreFilter(input.centreId), isActive = parseActive(input.isActive);
      const rows = await repo.listBlackouts(tx, { tenantId, ...(centreId === undefined ? {} : { centreId }), ...(isActive === undefined ? {} : { isActive }) });
      return { data: rows.map(blackoutBody) };
    },

    /** US-EN-16.4: existing bookings stay confirmed; the response only counts them. No centre-sync enqueue (TRD names S8/S9/S10 only). */
    async createBlackout(ctx: SlotCtx, input: { body: unknown }) {
      const { tx, tenantId, userId, now } = scope(ctx);
      const b = parseBlackout(input.body);
      try {
        if (!(await repo.centreExists(tx, { tenantId, centreId: b.centreId }))) return invalid('/centre_id', 'common.field_invalid', 'Centre not found');
        const row = await repo.insertBlackout(tx, { tenantId, userId, ...b });
        if (!row) throw new LimsError('common.internal');
        const futureBookings = await repo.countConfirmedInRange(tx, { tenantId, centreId: b.centreId, bookingKind: b.bookingKind, startsAt: b.startsAt, endsAt: b.endsAt, now });
        return { ...blackoutBody(row), affected: { future_bookings: futureBookings } };
      } catch (e) { return mapDbError(e, 'create'); }
    },

    async deactivateBlackout(ctx: SlotCtx, input: { id: unknown; headers: unknown; authorizeRow: (centreId: string) => Promise<void> }) {
      const { tx, tenantId, userId, now } = scope(ctx);
      const expectedVersion = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/id');
      try {
        const current = await repo.getBlackout(tx, { tenantId, id: input.id });
        if (!current) throw new LimsError('common.not_found');
        await input.authorizeRow(current['centre_id']);
        if (current['version'] !== expectedVersion) throw new LimsError('common.version_conflict');
        const row = await repo.deactivateBlackout(tx, { tenantId, userId, id: input.id, expectedVersion });
        if (!row) throw new LimsError('common.version_conflict');
        const futureBookings = await repo.countConfirmedInRange(tx, { tenantId, centreId: row['centre_id'], bookingKind: row['booking_kind'] ?? null, startsAt: iso(row['starts_at']), endsAt: iso(row['ends_at']), now });
        return { ...blackoutBody(row), affected: { future_bookings: futureBookings } };
      } catch (e) { return mapDbError(e, 'update'); }
    },
  };
}
export type SlotService = ReturnType<typeof createSlotService>;
