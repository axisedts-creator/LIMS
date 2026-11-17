// C16.T-B5 — wiring at the booking handlers: createBookingForPatient enqueues the confirmation message and schedules the booking reminder; cancelBooking enqueues the cancel message and cancels pending reminders.
// (06-PLAN row T-B5; 02-TRD §4.8 create step 7 "Enqueue engagement.send_booking_message {booking_id, kind:'confirmation'}; schedule the booking reminder row (§4.11)", cancel "cancel pending booking reminders", §8.1 row send_booking_message
//  job_key bmsg:<booking_id>:<kind>; 03-APP-FLOW B-1/B-2; PRD US-EN-12.8, US-EN-25.1-2; REQ-SEC-100 payload carries no PHI.)
// Fails now: booking.service.ts create()/cancel() neither enqueue a job nor touch engagement.reminders (T-B3 left both out: see booking.handlers.test.ts "NOT covered").
//
// SEAMS (same convention as booking.handlers.test.ts, whose harness this file condenses; the task writer must keep the T-B3 tests green, i.e. any SQL added to the booking service stays inside the fakeSql subset
// or is the one statement answered below):
//   Enqueue = `SELECT app.enqueue_job($1 identifier, $2 payload-json, $3 job_key, ...)` through ctx.tx.query (like auth.service / slot.service), answered here by a de-duplicating job list (identifier + job_key, as the real queue).
//   Job: identifier engagement.send_booking_message, job_key bmsg:<booking_id>:<kind>, payload EXACTLY {tenant_id, booking_id, kind}; kind 'confirmation' (TRD) | 'cancelled' (ASSUMED: mirrors engagement.booking_cancelled).
//   Reminder row: engagement.reminders INSERT {kind 'booking', source 'booking', source_ref_id = booking id, patient_id, due_at = slot_start - settings.booking_reminder_hours_before h} only when slot_start - now > H.
//   Cancel: UPDATE engagement.reminders SET status = 'cancelled' ... for kind 'booking' + that booking, still scheduled. Failed create / failed cancel: no job, no reminder change.
import { describe, expect, it } from 'vitest';
import { TENANTS } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../../core/errors.js';
import { createEvents } from '../../../../core/events/publish.js';
import { handlers } from '../../handlers/index.js';
import { FakeDb, queueSchemaDefs, type Row, type TableDef } from '../../__tests__/fakeSql.js';

const A: string = TENANTS.A;
const ID = (n: number) => `01950c16-0000-7000-8000-00000000${n.toString(16).padStart(4, '0')}`;
const C1 = '01950c16-0000-7000-8000-0000000c0001', BR1 = ID(0x11), T1 = ID(0x101);
const NOW = '2026-11-10T04:15:00.000Z';        // Tue 10:00 NPT
const SLOT = '2026-11-16T01:15:00.000Z';       // Mon 07:00 NPT: 5 d 21 h after NOW
const SLOT_FULL = '2026-11-16T01:30:00.000Z';  // occupancy 3/3
const SUN_NOW = '2026-11-15T04:15:00.000Z';    // Sun 10:00 NPT: SLOT is 21 h ahead (< 24 h)
const HOUR = 3_600_000;
const plus = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();
const O_CBC = ID(0x301), P_F = ID(0x501), OCC_FULL = ID(0x602);
const BK_CONF = ID(0x701), BK_OTHER = ID(0x702), BK_DONE = ID(0x703), REM_OTHER = ID(0xa02), REM_CUSTOM = ID(0xa03);
const READ = 'engagement.booking.read', MANAGE = 'engagement.booking.manage', CANCEL = 'engagement.booking.cancel';
const WHO = { grants: [READ, MANAGE, CANCEL], centres: [C1] };

const bk = (id: string, n: number, o: Row = {}): Row => ({ id, tenant_id: A, booking_no: `BK26${String(900 + n).padStart(6, '0')}`, account_id: null, patient_id: P_F, link_id: null, created_via: 'staff', booking_kind: 'centre_visit', branch_id: BR1,
  centre_id: C1, slot_occupancy_id: ID(0x601), slot_start: '2026-11-16T02:15:00.000Z', slot_end: '2026-11-16T02:30:00.000Z', home_address_id: null, status: 'confirmed', order_id: null, queue_token_id: null, confirmed_at: NOW,
  checked_in_at: null, completed_at: null, cancelled_at: null, cancel_reason_code: null, cancelled_by_kind: null, replaces_booking_id: null, version: 1, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...o });
const rem = (id: string, o: Row = {}): Row => ({ id, tenant_id: A, patient_id: P_F, kind: 'booking', reason_code: null, source: 'booking', source_ref_id: BK_CONF, source_ref_seq: 0, due_at: '2026-11-15T02:15:00.000Z', status: 'scheduled', sent_at: null,
  delivery_id: null, failure_code: null, version: 1, is_active: true, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...o });
const seed = (settings: Row = {}): Record<string, Row[]> => ({
  collection_centres: [{ id: C1, tenant_id: A }],
  booking_centres: [{ id: ID(0x2001), tenant_id: A, centre_id: C1, branch_id: BR1, display_name: 'Synthetic Centre One', address_text: 'Synthetic Road 1', is_active: true, synced_at: NOW, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A }],
  settings: [{ id: ID(0xe001), tenant_id: A, bookings_enabled: true, home_collection_enabled: false, home_collection_centre_id: null, queue_enabled: true, auto_no_show: true, booking_horizon_days: 14, booking_min_lead_minutes: 120,
    booking_cancel_cutoff_minutes: 60, no_show_grace_minutes: 120, max_active_bookings_per_profile: 5, max_bookings_created_per_account_day: 3, max_orderables_per_booking: 20, booking_reminder_hours_before: 24, version: 1, ...settings }],
  slot_templates: [{ id: T1, tenant_id: A, centre_id: C1, booking_kind: 'centre_visit', weekdays: [1, 2, 3, 4, 5], start_local: '07:00:00', end_local: '11:00:00', slot_minutes: 15, capacity: 3, effective_from: '2026-01-01', effective_to: null,
    version: 5, is_active: true, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A }],
  slot_blackouts: [],
  slot_occupancy: [{ id: OCC_FULL, tenant_id: A, centre_id: C1, booking_kind: 'centre_visit', slot_start: SLOT_FULL, slot_end: plus(SLOT_FULL, 15), template_id: T1, capacity: 3, booked: 3, version: 2, is_active: true, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A },
    { id: ID(0x601), tenant_id: A, centre_id: C1, booking_kind: 'centre_visit', slot_start: '2026-11-16T02:15:00.000Z', slot_end: '2026-11-16T02:30:00.000Z', template_id: T1, capacity: 3, booked: 2, version: 2, is_active: true, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A }],
  bookable_items: [{ id: ID(0xd001), tenant_id: A, orderable_id: O_CBC, orderable_kind: 'test', code: 'CBC', display_name: 'Complete Blood Count', indicative_price_paisa: 45000, price_list_id: null, price_list_version: null, sex_restriction: null,
    booking_kinds: ['centre_visit', 'home_collection'], sort_order: 1, catalog_revision: 1, synced_at: NOW, version: 1, is_active: true, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A }],
  bookings: [bk(BK_CONF, 1), bk(BK_OTHER, 2, { slot_start: '2026-11-17T02:15:00.000Z', slot_end: '2026-11-17T02:30:00.000Z' }), bk(BK_DONE, 3, { status: 'cancelled', cancelled_at: NOW, cancel_reason_code: 'patient_request', cancelled_by_kind: 'patient', version: 2 })],
  booking_items: [], booking_transitions: [], number_counters: [], event_log: [],
  reminders: [rem(ID(0xa01)), rem(REM_OTHER, { source_ref_id: BK_OTHER }), rem(REM_CUSTOM, { kind: 'custom', source: 'staff', source_ref_id: null, reason_code: 'follow_up_test' })],
});
const COLS = {
  settings: ['id', 'tenant_id', 'bookings_enabled', 'home_collection_enabled', 'home_collection_centre_id', 'queue_enabled', 'auto_no_show', 'booking_horizon_days', 'booking_min_lead_minutes', 'booking_cancel_cutoff_minutes', 'no_show_grace_minutes',
    'max_active_bookings_per_profile', 'max_bookings_created_per_account_day', 'max_orderables_per_booking', 'booking_reminder_hours_before', 'version'],
  bookings: ['id', 'tenant_id', 'booking_no', 'account_id', 'patient_id', 'link_id', 'created_via', 'booking_kind', 'branch_id', 'centre_id', 'slot_occupancy_id', 'slot_start', 'slot_end', 'home_address_id', 'status', 'order_id', 'queue_token_id', 'confirmed_at',
    'checked_in_at', 'completed_at', 'cancelled_at', 'cancel_reason_code', 'cancelled_by_kind', 'replaces_booking_id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'],
};
const defs = (clock: { iso: string }): Record<string, TableDef> => ({
  ...queueSchemaDefs(clock),
  settings: { columns: COLS.settings },
  booking_centres: { columns: ['id', 'tenant_id', 'centre_id', 'branch_id', 'display_name', 'address_text', 'is_active', 'synced_at', 'created_at', 'created_by', 'updated_at', 'updated_by'] },
  slot_templates: { columns: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'weekdays', 'start_local', 'end_local', 'slot_minutes', 'capacity', 'effective_from', 'effective_to', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'] },
  slot_blackouts: { columns: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'starts_at', 'ends_at', 'reason_code', 'note', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'] },
  slot_occupancy: { columns: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'slot_start', 'slot_end', 'template_id', 'capacity', 'booked', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    notNull: ['id', 'tenant_id', 'centre_id', 'booking_kind', 'slot_start', 'slot_end', 'template_id', 'capacity', 'booked', 'created_by', 'updated_by'], defaults: { booked: 0, version: 1, is_active: true, created_at: clock.iso, updated_at: clock.iso },
    unique: [['tenant_id', 'id'], ['tenant_id', 'centre_id', 'booking_kind', 'slot_start']] },
  bookable_items: { columns: ['id', 'tenant_id', 'orderable_id', 'orderable_kind', 'code', 'display_name', 'indicative_price_paisa', 'price_list_id', 'price_list_version', 'sex_restriction', 'booking_kinds', 'sort_order', 'catalog_revision', 'synced_at', 'version',
    'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'] },
  bookings: { columns: COLS.bookings, notNull: ['id', 'tenant_id', 'booking_no', 'patient_id', 'created_via', 'booking_kind', 'branch_id', 'centre_id', 'slot_occupancy_id', 'slot_start', 'slot_end', 'status', 'confirmed_at', 'version', 'created_by', 'updated_by'],
    defaults: { status: 'confirmed', version: 1, created_at: clock.iso, updated_at: clock.iso }, unique: [['tenant_id', 'id'], ['tenant_id', 'booking_no']] },
  booking_items: { columns: ['id', 'tenant_id', 'booking_id', 'account_id', 'centre_id', 'orderable_id', 'orderable_kind', 'display_name_snapshot', 'indicative_price_paisa', 'sort_order', 'created_at', 'created_by'], defaults: { created_at: clock.iso } },
  booking_transitions: { columns: ['id', 'tenant_id', 'booking_id', 'account_id', 'centre_id', 'from_status', 'to_status', 'reason_code', 'actor_type', 'actor_id', 'occurred_at', 'created_at', 'created_by'], defaults: { created_at: clock.iso } },
  number_counters: { columns: ['tenant_id', 'counter_key', 'last_value', 'expires_at', 'created_at', 'created_by', 'updated_at'], defaults: { last_value: 0, created_at: clock.iso, updated_at: clock.iso }, unique: [['tenant_id', 'counter_key']] },
  event_log: { columns: ['tenant_id', 'event_id', 'event_type', 'producer', 'idempotency_key', 'aggregate_type', 'aggregate_id', 'aggregate_seq', 'occurred_at', 'envelope', 'created_by'], unique: [['tenant_id', 'event_type', 'idempotency_key']] },
  // 05-SCHEMA reminders; partial unique index (tenant, kind, source_ref_id, source_ref_seq) WHERE source_ref_id IS NOT NULL is emulated by the plain unique (seed rows all differ in kind or source_ref_id)
  reminders: { columns: ['id', 'tenant_id', 'patient_id', 'kind', 'reason_code', 'source', 'source_ref_id', 'source_ref_seq', 'due_at', 'status', 'sent_at', 'delivery_id', 'failure_code', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    notNull: ['id', 'tenant_id', 'patient_id', 'kind', 'source', 'source_ref_seq', 'due_at', 'status', 'version', 'created_by', 'updated_by'], defaults: { status: 'scheduled', source_ref_seq: 0, version: 1, is_active: true, created_at: clock.iso, updated_at: clock.iso },
    unique: [['tenant_id', 'kind', 'source_ref_id', 'source_ref_seq']],
    check: (r) => (!['custom', 'follow_up', 'booking'].includes(r['kind']) ? 'reminders__kind__ck' : r['kind'] !== 'booking' && r['reason_code'] == null ? 'reminders__reason__ck' : (r['status'] === 'sent') !== (r['sent_at'] != null) ? 'reminders__sent__ck' : undefined) },
});

// ---------------------------------------------------------------- harness
const CANCEL_REASONS = [{ code: 'patient_request', display: 'Patient request', sort_order: 1, is_active: true }, { code: 'duplicate', display: 'Duplicate booking', sort_order: 2, is_active: true }];
const ctxFor = makeCtxFor();
interface Job { identifier: unknown; payload: any; jobKey: unknown }
function world(o: { now?: string; settings?: Row } = {}) {
  const now = o.now ?? NOW; const clock = { iso: now }; const db = new FakeDb(seed(o.settings), defs(clock), clock); const jobs: Job[] = [];
  const s = db.session(A, { all: false, centres: [C1] }, A); const dbErrors: string[] = [];
  const query = async (text: string, values: unknown[] = []) => {
    if (/engagement\.g_cs_booking_cancel_reasons/i.test(text)) { db.calls.push({ text, values }); return Promise.resolve({ rows: CANCEL_REASONS.map((x) => ({ ...x })), rowCount: CANCEL_REASONS.length }); }
    if (/app\.enqueue_job/i.test(text) && /^engagement\./.test(String(values[0]))) {   // the event fan-out statement (core) also mentions enqueue_job: only task identifiers are answered here
      db.calls.push({ text, values }); const j: Job = { identifier: values[0], payload: typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1], jobKey: values[2] };
      if (!jobs.some((x) => x.identifier === j.identifier && x.jobKey === j.jobKey)) jobs.push(j); return Promise.resolve({ rows: [{ enqueue_job: 1 }], rowCount: 1 });
    }
    try { return await s.tx.query(text, values); } catch (e) { dbErrors.push(`${(e as Error).message} :: ${text.replace(/\s+/g, ' ').slice(0, 160)}`); throw e; }   // the service maps unexpected DB errors to common.internal: keep the cause visible
  };
  const id = { async assertRole(_c: unknown, r: { permission: string; centreId?: string }) { if (!WHO.grants.includes(r?.permission)) throw new LimsError('auth.forbidden'); if (r.centreId && !WHO.centres.includes(r.centreId)) throw new LimsError('auth.forbidden'); },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
    async getActor() { return { actor: { type: 'user', id: A }, permissions: [...WHO.grants], roles: [], centreScope: { all: false, centreIds: WHO.centres }, mfa: { enrolled: true, level: 'aal2' } }; } };
  const log = { info() {}, warn() {}, error: (...a: unknown[]) => { dbErrors.push(`log.error ${JSON.stringify(a).slice(0, 200)}`); } };
  const ctx = { operationId: 'x', clientIp: '203.0.113.9', log, events: createEvents({ producer: 'engagement', log: log as never }),
    ...ctxFor('A', { tx: { query, startedAt: new Date(now) } as never, now: () => now, ports: { IdentityPort: id, FrontdeskPort: { async getPatientDemographics() { return { sex: 'female' }; } } } as never }) } as never;
  const call = (op: string, req: object) => (async () => { try { return { out: await (handlers as any)[op]({ params: {}, query: {}, headers: {}, body: undefined, ...req }, ctx), error: undefined as any }; } catch (e) { return { out: undefined as any, error: e as any }; } })();
  const create = (body: Row = {}) => call('createBookingForPatient', { headers: { 'idempotency-key': 'k-b5-0001' }, body: { patient_id: P_F, booking_kind: 'centre_visit', centre_id: C1, slot_start: SLOT, orderable_ids: [O_CBC], ...body } });
  const cancel = (bookingId: string, headers: Row = { 'if-match': '"1"' }, body: Row = { reason_code: 'patient_request' }) => call('cancelBooking', { params: { booking_id: bookingId }, headers: { 'idempotency-key': 'k-b5-0002', ...headers }, body });
  const reminders = () => db.tables['reminders']!; const forBooking = (bid: string) => reminders().filter((r) => r['kind'] === 'booking' && r['source_ref_id'] === bid);
  return { db, jobs, dbErrors, create, cancel, reminders, forBooking, msgJobs: () => jobs.filter((j) => j.identifier === 'engagement.send_booking_message') };
}

describe('US-EN-12.8: a successful create enqueues the confirmation message (and only that)', () => {
  it('one job engagement.send_booking_message, job_key bmsg:<booking_id>:confirmation, payload EXACTLY {tenant_id, booking_id, kind: confirmation}', async () => {
    const w = world(); const r = await w.create(); expect(w.dbErrors).toEqual([]); expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201);
    const id = r.out.body.id; expect(w.msgJobs()).toHaveLength(1);
    expect(w.msgJobs()[0]).toEqual({ identifier: 'engagement.send_booking_message', jobKey: `bmsg:${id}:confirmation`, payload: { tenant_id: A, booking_id: id, kind: 'confirmation' } });
    expect(w.jobs).toHaveLength(1);                                                                                  // the reminder is a row for the dispatcher, not a job
  });
  it('the payload and job_key carry no PHI: no booking_no, patient id, phone, item names', async () => {
    const w = world(); const r = await w.create(); const j = JSON.stringify(w.msgJobs()[0]);
    expect(j).not.toContain(r.out.body.booking_no); expect(j).not.toContain(P_F); expect(j).not.toMatch(/Complete Blood Count|\+977/);
  });
  it('failed creates enqueue nothing and schedule nothing: full slot 409, outside window 422, unknown orderable 422, bad body 400', async () => {
    for (const body of [{ slot_start: SLOT_FULL }, { slot_start: '2026-11-16T01:16:00.000Z' }, { orderable_ids: [ID(0x3ff)] }, { patient_id: 'nope' }]) {
      const w = world(); const before = w.reminders().length; const r = await w.create(body); expect(r.error, JSON.stringify(body)).toBeInstanceOf(LimsError);
      expect(w.jobs).toEqual([]); expect(w.reminders()).toHaveLength(before);
    }
  });
});

describe('US-EN-25.1: booking reminder row at create (only when slot_start - now > booking_reminder_hours_before)', () => {
  it('slot 5 d ahead, H = 24: one scheduled reminder for the new booking due at slot_start - 24 h, for the booking\'s patient', async () => {
    const w = world(); const r = await w.create(); const rows = w.forBooking(r.out.body.id); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: A, patient_id: P_F, kind: 'booking', source: 'booking', reason_code: null, status: 'scheduled', version: 1 });
    expect(Date.parse(rows[0]!['due_at'])).toBe(Date.parse(SLOT) - 24 * HOUR);
  });
  it('H = 12 (settings) -> due at slot_start - 12 h', async () => {
    const w = world({ settings: { booking_reminder_hours_before: 12 } }); const r = await w.create(); expect(Date.parse(w.forBooking(r.out.body.id)[0]!['due_at'])).toBe(Date.parse(SLOT) - 12 * HOUR);
  });
  it('booking made < 24 h ahead (slot 21 h away): confirmed and the confirmation job is queued, but NO reminder row', async () => {
    const w = world({ now: SUN_NOW }); const before = w.reminders().length; const r = await w.create();
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201); expect(w.forBooking(r.out.body.id)).toEqual([]); expect(w.reminders()).toHaveLength(before); expect(w.msgJobs()).toHaveLength(1);
  });
  it('the create never sends anything itself: the only enqueue is the message job (no SMS port exists on the create ctx)', async () => {
    const w = world(); await w.create(); expect(w.jobs.map((j) => j.identifier)).toEqual(['engagement.send_booking_message']);
  });
});

describe('US-EN-25.2 / 14: cancel enqueues the cancellation message and cancels the pending reminders', () => {
  it('job bmsg:<id>:cancelled with payload {tenant_id, booking_id, kind: cancelled}; that booking\'s scheduled reminder -> cancelled; others untouched', async () => {
    const w = world(); const r = await w.cancel(BK_CONF); expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200);
    expect(w.msgJobs()).toEqual([{ identifier: 'engagement.send_booking_message', jobKey: `bmsg:${BK_CONF}:cancelled`, payload: { tenant_id: A, booking_id: BK_CONF, kind: 'cancelled' } }]);
    expect(w.forBooking(BK_CONF).map((x) => x['status'])).toEqual(['cancelled']); expect(w.forBooking(BK_CONF)[0]!['version']).toBe(2);
    expect(w.reminders().find((x) => x['id'] === REM_OTHER)!['status']).toBe('scheduled'); expect(w.reminders().find((x) => x['id'] === REM_CUSTOM)!['status']).toBe('scheduled');
  });
  it('a booking without a reminder (made < 24 h ahead) cancels cleanly: message job only, no error', async () => {
    const w = world(); w.reminders().length = 0; const r = await w.cancel(BK_CONF); expect(r.out.status).toBe(200); expect(w.msgJobs()).toHaveLength(1);
  });
  it('failed cancels change nothing: stale If-Match 409, already cancelled 409, unknown booking 404, bad reason 400, no If-Match 428', async () => {
    const cases: Array<[string, string, Row | undefined]> = [[BK_CONF, 'common.version_conflict', { 'if-match': '"9"' }], [BK_DONE, 'engagement.booking_invalid_transition', { 'if-match': '"2"' }], [ID(0x7ff), 'common.not_found', undefined],
      [BK_CONF, 'common.validation_failed', undefined], [BK_CONF, 'common.precondition_required', {}]];
    for (const [bid, code, headers] of cases) {
      const w = world(); const before = JSON.stringify(w.reminders());
      const r = code === 'common.validation_failed' ? await w.cancel(bid, { 'if-match': '"1"' }, { reason_code: 'not_a_reason' }) : await w.cancel(bid, headers ?? { 'if-match': '"1"' });
      expect(r.error?.code, code).toBe(code); expect(w.jobs, code).toEqual([]); expect(JSON.stringify(w.reminders()), code).toBe(before);
    }
  });
  it('replaying the cancel of an already cancelled booking cannot enqueue a second message (409 before any enqueue; job_key would collapse anyway)', async () => {
    const w = world(); await w.cancel(BK_CONF); const r = await w.cancel(BK_CONF, { 'if-match': '"2"' });
    expect(r.error?.code).toBe('engagement.booking_invalid_transition'); expect(w.msgJobs()).toHaveLength(1);
  });
});
