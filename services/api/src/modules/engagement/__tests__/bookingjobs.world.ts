// C16.T-B4 test world (NOT a test file): FakeDb schema + fixtures + worker JobContext for the booking crons and the homecollection.collection.synced.v1 consumer.
// - DB = fakeSql.ts (FakeDb, tenant RLS, CHECK / mutable-column triggers). The cross-schema view frontdesk.v_pub_order_status is outside the FakeDb subset (it only knows engagement.* / core.*),
//   so ctx.tx.query answers it from `orders` here: rows of the SESSION tenant only (security_invoker view + RLS), and only the ids the statement binds (`source_ref_id = ANY($n)` or one bind per id).
// - ctx.events = the REAL core createEvents({producer:'engagement'}): envelope validation against contracts/events/*.schema.json + core.event_log dedup on (tenant, type, idempotency_key).
// - Time = world.clock (fake clock). ctx.now() and tx.startedAt both read it.
import { createEvents } from '../../../core/events/publish.js';
import { FakeDb, type Call, type Row, type TableDef } from './fakeSql.js';

export const TENANT_A = '01a1a98a-ac40-7000-8000-00000000a001';
export const TENANT_B = '01a1a98a-ac40-7000-8000-00000000b001';
export const ID = (n: number) => `01950c16-0000-7000-8000-00000000${n.toString(16).padStart(4, '0')}`;
export const SYSTEM = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const NOW = '2026-11-10T04:15:00.000Z';
export const C1 = ID(0xc01), CB = ID(0xcb1), BR1 = ID(0x11), BRB = ID(0x1b);
export const PATIENT = ID(0x501), PATIENT_B = ID(0x5b1);
export const OCC = ID(0x601), OCC_B = ID(0x606), TPL = ID(0x101), TPL_B = ID(0x1b1);
export const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();

const BOOKING_COLS = ['id', 'tenant_id', 'booking_no', 'account_id', 'patient_id', 'link_id', 'created_via', 'booking_kind', 'branch_id', 'centre_id', 'slot_occupancy_id', 'slot_start', 'slot_end', 'home_address_id', 'status', 'order_id',
  'queue_token_id', 'confirmed_at', 'checked_in_at', 'completed_at', 'cancelled_at', 'cancel_reason_code', 'cancelled_by_kind', 'replaces_booking_id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'];

export const defs = (clock: { iso: string }): Record<string, TableDef> => ({
  settings: { columns: ['id', 'tenant_id', 'bookings_enabled', 'auto_no_show', 'no_show_grace_minutes', 'booking_cancel_cutoff_minutes', 'version'] },
  collection_centres: { columns: ['id', 'tenant_id'] },
  slot_occupancy: {
    columns: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'slot_start', 'slot_end', 'template_id', 'capacity', 'booked', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    notNull: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'slot_start', 'slot_end', 'template_id', 'capacity', 'booked', 'created_by', 'updated_by'], defaults: { booked: 0, version: 1, is_active: true, created_at: clock.iso, updated_at: clock.iso },
    unique: [['tenant_id', 'id'], ['tenant_id', 'centre_id', 'booking_kind', 'slot_start']],
  },
  bookings: {
    columns: BOOKING_COLS, notNull: ['id', 'tenant_id', 'booking_no', 'patient_id', 'created_via', 'booking_kind', 'branch_id', 'centre_id', 'slot_occupancy_id', 'slot_start', 'slot_end', 'status', 'confirmed_at', 'version', 'created_by', 'updated_by'],
    defaults: { status: 'confirmed', version: 1, created_at: clock.iso, updated_at: clock.iso }, unique: [['tenant_id', 'id'], ['tenant_id', 'booking_no']],
    fk: [{ cols: ['tenant_id', 'slot_occupancy_id'], ref: 'slot_occupancy', refCols: ['tenant_id', 'id'] }, { cols: ['tenant_id', 'centre_id'], ref: 'collection_centres', refCols: ['tenant_id', 'id'] }],
    mutable: ['status', 'order_id', 'queue_token_id', 'checked_in_at', 'completed_at', 'cancelled_at', 'cancel_reason_code', 'cancelled_by_kind', 'updated_at', 'updated_by', 'version'], // bookings__mutable_columns trigger
    check: (r) => !['confirmed', 'checked_in', 'completed', 'cancelled'].includes(r['status']) ? 'bookings__status__ck'
      : (r['status'] === 'cancelled') !== (r['cancelled_at'] != null && r['cancel_reason_code'] != null && r['cancelled_by_kind'] != null) ? 'bookings__cancel__ck'
      : r['cancelled_by_kind'] != null && !['patient', 'staff', 'system'].includes(r['cancelled_by_kind']) ? 'bookings__cancel_by__ck'
      : (r['booking_kind'] === 'home_collection') !== (r['home_address_id'] != null) ? 'bookings__address_kind__ck' : undefined,
  },
  booking_transitions: { columns: ['id', 'tenant_id', 'booking_id', 'account_id', 'centre_id', 'from_status', 'to_status', 'reason_code', 'actor_type', 'actor_id', 'occurred_at', 'created_at', 'created_by'],
    notNull: ['id', 'tenant_id', 'booking_id', 'centre_id', 'to_status', 'actor_type', 'actor_id', 'occurred_at', 'created_by'], defaults: { created_at: clock.iso },
    check: (r) => !['user', 'system', 'patient'].includes(r['actor_type']) ? 'booking_transitions__actor__ck' : !['confirmed', 'checked_in', 'completed', 'cancelled'].includes(r['to_status']) ? 'booking_transitions__status__ck' : undefined },
  event_log: { columns: ['tenant_id', 'event_id', 'event_type', 'producer', 'idempotency_key', 'aggregate_type', 'aggregate_id', 'aggregate_seq', 'occurred_at', 'envelope', 'created_by'], unique: [['tenant_id', 'event_type', 'idempotency_key']] },
});

export const bk = (id: string, n: number, o: Row = {}): Row => ({
  id, tenant_id: TENANT_A, booking_no: `BK26${String(900 + n).padStart(6, '0')}`, account_id: null, patient_id: PATIENT, link_id: null, created_via: 'staff', booking_kind: 'centre_visit', branch_id: BR1, centre_id: C1,
  slot_occupancy_id: OCC, slot_start: plus(NOW, -255), slot_end: plus(NOW, -240), home_address_id: null, status: 'confirmed', order_id: null, queue_token_id: null, confirmed_at: plus(NOW, -9000), checked_in_at: null,
  completed_at: null, cancelled_at: null, cancel_reason_code: null, cancelled_by_kind: null, replaces_booking_id: null, version: 1, created_at: plus(NOW, -9000), created_by: SYSTEM, updated_at: plus(NOW, -9000), updated_by: SYSTEM, ...o });
export const order = (id: string, bookingId: string | null, status: string, o: Row = {}): Row => ({
  tenant_id: TENANT_A, order_id: id, patient_id: PATIENT, centre_id: C1, branch_id: BR1, source: 'engagement_booking', source_ref_id: bookingId, partner_id: null, status, registered_at: status === 'pre_registered' ? null : plus(NOW, -60), updated_at: NOW, ...o });
const occ = (id: string, tenant: string, centre: string, tpl: string, booked: number): Row => ({ id, tenant_id: tenant, centre_id: centre, booking_kind: 'centre_visit', slot_start: plus(NOW, -255), slot_end: plus(NOW, -240), template_id: tpl,
  capacity: 10, booked, version: 4, is_active: true, created_at: NOW, created_by: SYSTEM, updated_at: NOW, updated_by: SYSTEM });
export const settings = (o: Row = {}): Row => ({ id: ID(0xe01), tenant_id: TENANT_A, bookings_enabled: true, auto_no_show: true, no_show_grace_minutes: 120, booking_cancel_cutoff_minutes: 60, version: 1, ...o });

export interface JobWorldOpts { bookings?: Row[]; orders?: Row[]; settings?: Row | null; extraSettings?: Row[] }
export function makeJobWorld(opts: JobWorldOpts = {}) {
  const clock = { iso: NOW };
  const orders: Row[] = [...(opts.orders ?? [])];
  const tables: Record<string, Row[]> = {
    collection_centres: [{ id: C1, tenant_id: TENANT_A }, { id: CB, tenant_id: TENANT_B }],
    settings: [...(opts.settings === null ? [] : [settings(opts.settings ?? {})]), ...(opts.extraSettings ?? [])],
    slot_occupancy: [occ(OCC, TENANT_A, C1, TPL, 5), occ(OCC_B, TENANT_B, CB, TPL_B, 5)],
    bookings: [...(opts.bookings ?? [])], booking_transitions: [], event_log: [],
  };
  const db = new FakeDb(tables, defs(clock), clock);
  const logs: unknown[] = [];
  const log = { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a) };
  const viewCalls: Call[] = [];

  function jobCtx(over: Row = {}, tenant: string = TENANT_A): any {
    const s = db.session(tenant, { all: true, centres: [] }, SYSTEM);
    const query = (text: string, values: unknown[] = []) => {
      if (/frontdesk\.v_pub_order_status/i.test(text)) {
        db.calls.push({ text, values }); viewCalls.push({ text, values });
        const bound = new Set<unknown>(values.flat());
        const rows = orders.filter((r) => r['tenant_id'] === tenant && r['source'] === 'engagement_booking' && bound.has(r['source_ref_id'])).map((r) => ({ ...r }));
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      return s.tx.query(text, values);
    };
    const tx = { query, get startedAt() { return new Date(clock.iso); } };
    const ctx: any = { tenantId: tenant, actor: { type: 'system', id: SYSTEM }, requestId: ID(0xe1), jobId: '1', attempt: 1, maxAttempts: 3, tx, now: () => clock.iso, log,
      events: createEvents({ producer: 'engagement', log: log as never }), audit: { access: async () => {}, event: async () => {} }, core: {}, ports: {}, isNewer: () => true, ...over };
    ctx.db = { tx: async (fn: any) => fn(ctx) };
    return ctx;
  }

  const dml = (from = 0) => db.calls.slice(from).filter((c) => ['insert', 'update', 'delete'].includes(/^\s*(\w+)/.exec(c.text)?.[1]?.toLowerCase() ?? ''));
  return {
    db, clock, orders, logs, viewCalls, jobCtx, dml, log,
    advance: (min: number) => { clock.iso = plus(clock.iso, min); },
    setNow: (iso: string) => { clock.iso = iso; },
    booking: (id: string) => db.tables['bookings']!.find((r) => r['id'] === id)!,
    transitions: (id?: string) => db.tables['booking_transitions']!.filter((t) => !id || t['booking_id'] === id),
    events: (type?: string) => db.tables['event_log']!.filter((e) => !type || e['event_type'] === type).map((e) => e['envelope']),
    occupancy: (id = OCC) => db.tables['slot_occupancy']!.find((r) => r['id'] === id)!,
    snapshot: () => JSON.stringify(db.tables),
  };
}
export type JobWorld = ReturnType<typeof makeJobWorld>;
