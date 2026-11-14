// C16.T-B4 — crons `engagement.reconcile_bookings` (every 10 min) + `engagement.mark_no_shows` (every 15 min), both `centre_visit` only, and the consumer of `homecollection.collection.synced.v1`.
// (06-PLAN row T-B4; 02-TRD §4.8 "Completion / no-show", "Completion of home_collection bookings", §7.1 (cancelled event NOT emitted by reconcile), §7.2 consumer row, §8.2 cron rows, §3.3 worker skeleton;
//  03-APP-FLOW B-6h; 01-PRD US-EN-14.4, 14.5, 14.7; 05-SCHEMA bookings / booking_transitions / slot_occupancy; 08 A19 D-120; 07-SECURITY REQ-SEC-024 tenant guard, REQ-SEC-080 / §6 event payload PHI.)
// done_when: completion/no-show/order-cancelled rules; home bookings complete only from the synced event.
// tests: fake clock + seeded frontdesk.v_pub_order_status rows: registered -> completed; pre_registered past grace -> no-show + event, occupancy unchanged; cancelled order -> cancelled without event;
//        home_collection past grace never auto-no-showed; synced event with booking_id -> completed with order_id, duplicate no-op, without booking_id no-op.
// Fails now: manifest.tasks has no `engagement.reconcile_bookings` / `engagement.mark_no_shows` (no cron rows either) and the `homecollection.collection.synced.v1` subscription is the T-01 fail-closed stub
//            (throws "consumer ... not implemented").
//
// SEAMS (spec fixes behaviour and the task / event ids, not file or function names; same convention as close_queue_day.test.ts / reminders.test.ts):
//   Everything is reached through the WorkerManifest: manifest.tasks['engagement.reconcile_bookings' | 'engagement.mark_no_shows'](payload {tenant_id}, ctx) and
//   manifest.subscriptions['homecollection.collection.synced.v1'](event, ctx). Crontab rows are UTC fields, per_tenant. Logic may live in the API module's booking.service.ts (TRD §3.3); only the manifest is asserted.
//   ctx = worker JobContext of the system actor: tenantId, actor {type:'system', id}, tx (statements through ctx.tx.query; the view frontdesk.v_pub_order_status is answered by the world), now() = fake clock,
//   events = REAL core createEvents({producer:'engagement'}) (so "event published" proves envelope validation + dedup on idempotency_key `<booking_id>:cancelled`), db.tx(fn).
//   DB = fakeSql.ts (no OR / JOIN / arithmetic in SQL: grace and window maths are the implementation's to do in JS or with bound cut-off values). Always-bound tenant_id (REQ-SEC-024).
//   Tenant guard (same as close_queue_day): a task payload whose tenant_id is not the job tenant -> no write (resolving or throwing are both accepted).
//   Reconcile selects confirmed/checked_in centre_visit bookings with slot_start in [now - 7 days, now + 1 day] (inclusive edges not asserted), reads the view with source = 'engagement_booking'
//   and source_ref_id = ANY(booking ids), stores order_id, order registered|in_progress|completed -> booking completed (completed_at, version + 1, transition row actor_type 'system', no event),
//   order cancelled -> booking cancelled (reason lab_unavailable, cancelled_by_kind system, transition row, NO event), order pre_registered -> only order_id stored (status unchanged).
//   mark_no_shows: auto_no_show && slot_end + no_show_grace_minutes < now (strict) && order still pre_registered OR no order seen -> cancelled, reason no_show, by system, transition row, event
//   engagement.booking.cancelled.v1 {reason_code:'no_show', cancelled_by_kind:'system', order_id only when known}; slot_occupancy.booked is NOT decremented.
//   Consumer: payload.booking_id present AND booking is home_collection AND status confirmed|checked_in -> completed (system), order_id = payload.order_id, transition row, no event; everything else a silent no-op.
//   NOT covered (no seam without the real DB / owned elsewhere): rollback after a mid-transaction failure, real RLS policy text, the real view definition (db tests of C4), send_booking_message (T-B5).
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { ID, NOW, TENANT_A, TENANT_B, CB, SYSTEM, bk, makeJobWorld, order, plus, type JobWorldOpts } from '../../../../../api/src/modules/engagement/__tests__/bookingjobs.world.js';
import type { Row } from '../../../../../api/src/modules/engagement/__tests__/fakeSql.js';

const manifest = async (): Promise<any> => (await import('../index.js')).manifest;
const RECONCILE = 'engagement.reconcile_bookings', NO_SHOW = 'engagement.mark_no_shows', SYNCED = 'homecollection.collection.synced.v1';
const DAY = 86_400_000;

const B = { PRE: ID(0x701), REG: ID(0x702), CHK: ID(0x703), PROG: ID(0x704), DONE: ID(0x705), CANC_ORD: ID(0x706), NONE: ID(0x707), HOME: ID(0x708), OLD: ID(0x709), FUTURE: ID(0x70a),
  TERM_C: ID(0x70b), TERM_X: ID(0x70c), OTHER: ID(0x70d), FOREIGN: ID(0x70e), HOME_CHK: ID(0x70f), RECENT: ID(0x710), EDGE: ID(0x711), WRONG_SRC: ID(0x712) };
const O = (n: number) => ID(0x800 + n);
const VISIT = ID(0x900);

// slot ends 240 min before NOW => grace (120) long over
const past = (n: number, o: Row = {}) => bk(B.PRE, n, o);

async function run(w: ReturnType<typeof makeJobWorld>, id: string, payload: Row = { tenant_id: TENANT_A }, over: Row = {}) {
  const m = await manifest();
  await m.tasks[id](payload, w.jobCtx(over));
}
async function deliver(w: ReturnType<typeof makeJobWorld>, payload: Row, over: Row = {}, ctxTenant = TENANT_A) {
  const m = await manifest();
  const ev = { event_id: ID(0xe00 + Math.floor(Math.random() * 0xff)), event_type: SYNCED, producer: 'homecollection', tenant_id: ctxTenant, aggregate: { type: 'home_visit', id: VISIT, seq: 1 }, occurred_at: NOW,
    payload: { visit_id: VISIT, order_id: O(1), phlebotomist_membership_id: ID(0xa01), synced_at: NOW, collections: [], payments: [], ...payload }, ...over };
  await m.subscriptions[SYNCED](ev, w.jobCtx({}, ctxTenant));
}
const world = (o: JobWorldOpts = {}) => makeJobWorld(o);

describe('manifest: cron rows + implemented handlers (TRD §8.2, §7.2)', () => {
  it('reconcile_bookings */10 and mark_no_shows */15 are per_tenant cron rows with registered task handlers; manifest still validates', async () => {
    const m = await manifest();
    expect(() => validateManifests([m])).not.toThrow();
    expect(typeof m.tasks[RECONCILE]).toBe('function'); expect(typeof m.tasks[NO_SHOW]).toBe('function');
    expect(m.crontab.find((c: any) => c.identifier === RECONCILE)).toMatchObject({ schedule: '*/10 * * * *', tenantScope: 'per_tenant' });
    expect(m.crontab.find((c: any) => c.identifier === NO_SHOW)).toMatchObject({ schedule: '*/15 * * * *', tenantScope: 'per_tenant' });
  });
  it('the homecollection.collection.synced.v1 subscription is no longer the fail-closed stub (an event without booking_id resolves quietly)', async () => {
    const w = world();
    await expect(deliver(w, {})).resolves.toBeUndefined();
  });
});

describe('test world self-check (independent of the implementation)', () => {
  it('real createEvents accepts the system no-show payload and dedups on <booking_id>:cancelled; the view answers only own-tenant engagement_booking rows', async () => {
    const w = world({ bookings: [bk(B.PRE, 1)], orders: [order(O(1), B.PRE, 'registered'), order(O(2), B.PRE, 'registered', { tenant_id: TENANT_B }), order(O(3), B.PRE, 'registered', { source: 'home_collection' })] });
    const ctx = w.jobCtx(); const input = { aggregate: { type: 'booking', id: B.PRE, seq: 2 }, idempotencyKey: `${B.PRE}:cancelled`,
      payload: { booking_id: B.PRE, patient_id: ID(0x501), booking_kind: 'centre_visit', reason_code: 'no_show', cancelled_by_kind: 'system', slot_start: NOW, cancelled_at: NOW } };
    await ctx.events.publish(ctx, 'engagement.booking.cancelled.v1', input); await ctx.events.publish(ctx, 'engagement.booking.cancelled.v1', input);
    expect(w.events()).toHaveLength(1);
    const { rows } = await ctx.tx.query('SELECT order_id, source_ref_id, status FROM frontdesk.v_pub_order_status WHERE source = $1 AND source_ref_id = ANY($2::uuid[])', ['engagement_booking', [B.PRE]]);
    expect(rows.map((r: Row) => r['order_id'])).toEqual([O(1)]);
  });
});

describe('US-EN-14.5 reconcile_bookings: order registered (or later) -> booking completed', () => {
  it('registered -> completed: order_id stored, completed_at set, version + 1, system transition row, NO event, occupancy unchanged', async () => {
    const w = world({ bookings: [past(1)], orders: [order(O(1), B.PRE, 'registered')] });
    const occ = JSON.stringify(w.occupancy());
    await run(w, RECONCILE);
    expect(w.booking(B.PRE)).toMatchObject({ status: 'completed', order_id: O(1), version: 2, cancelled_at: null, cancel_reason_code: null });
    expect(w.booking(B.PRE)['completed_at']).toBe(NOW);
    expect(w.transitions(B.PRE)).toEqual([expect.objectContaining({ booking_id: B.PRE, from_status: 'confirmed', to_status: 'completed', actor_type: 'system', actor_id: SYSTEM, tenant_id: TENANT_A, centre_id: expect.any(String) })]);
    expect(w.events()).toEqual([]);
    expect(JSON.stringify(w.occupancy())).toBe(occ);
  });
  it('checked_in + in_progress -> completed; confirmed + completed order -> completed (each recorded from its own status)', async () => {
    const w = world({ bookings: [bk(B.CHK, 1, { status: 'checked_in', checked_in_at: plus(NOW, -250), version: 2 }), bk(B.PROG, 2), bk(B.DONE, 3)],
      orders: [order(O(1), B.CHK, 'in_progress'), order(O(2), B.PROG, 'in_progress'), order(O(3), B.DONE, 'completed')] });
    await run(w, RECONCILE);
    for (const [id, order_id] of [[B.CHK, O(1)], [B.PROG, O(2)], [B.DONE, O(3)]] as const) expect(w.booking(id)).toMatchObject({ status: 'completed', order_id });
    expect(w.transitions(B.CHK)[0]).toMatchObject({ from_status: 'checked_in', to_status: 'completed', actor_type: 'system' });
    expect(w.transitions(B.PROG)[0]).toMatchObject({ from_status: 'confirmed', to_status: 'completed' });
    expect(w.events()).toEqual([]);
  });
  it('order still pre_registered: only order_id is stored, status unchanged, no transition, no event', async () => {
    const w = world({ bookings: [bk(B.RECENT, 1, { slot_start: plus(NOW, 60), slot_end: plus(NOW, 75) })], orders: [order(O(1), B.RECENT, 'pre_registered')] });
    await run(w, RECONCILE);
    expect(w.booking(B.RECENT)).toMatchObject({ status: 'confirmed', order_id: O(1) });
    expect(w.transitions()).toEqual([]); expect(w.events()).toEqual([]);
  });
  it('no order seen -> nothing changes (no write at all)', async () => {
    const w = world({ bookings: [bk(B.NONE, 1)], orders: [] });
    const before = w.snapshot(); await run(w, RECONCILE);
    expect(w.snapshot()).toBe(before); expect(w.dml()).toEqual([]);
  });
  it('fake clock: the booking completes on the first tick after the order shows up as registered, not before; a no-show is never applied afterwards', async () => {
    const w = world({ bookings: [bk(B.PRE, 1)], orders: [order(O(1), B.PRE, 'pre_registered')] });
    await run(w, RECONCILE); expect(w.booking(B.PRE)['status']).toBe('confirmed');
    w.orders[0]!['status'] = 'registered'; w.advance(10);
    await run(w, RECONCILE); expect(w.booking(B.PRE)['status']).toBe('completed');
    w.advance(15); await run(w, NO_SHOW);
    expect(w.booking(B.PRE)).toMatchObject({ status: 'completed', order_id: O(1) }); expect(w.events()).toEqual([]);
  });
  it('idempotent: a second tick changes nothing (one transition, version stays)', async () => {
    const w = world({ bookings: [bk(B.REG, 1)], orders: [order(O(1), B.REG, 'registered')] });
    await run(w, RECONCILE); const after = w.snapshot(); w.advance(10); await run(w, RECONCILE);
    expect(w.transitions(B.REG)).toHaveLength(1); expect(w.booking(B.REG)['version']).toBe(2);
    expect(JSON.stringify(w.db.tables['booking_transitions'])).toBe(JSON.stringify(JSON.parse(after)['booking_transitions']));
  });
  it('terminal bookings are never touched: completed / cancelled stay as they are even with a registered order', async () => {
    const w = world({ bookings: [bk(B.TERM_C, 1, { status: 'completed', completed_at: plus(NOW, -100), version: 3 }), bk(B.TERM_X, 2, { status: 'cancelled', cancelled_at: plus(NOW, -100), cancel_reason_code: 'patient_request', cancelled_by_kind: 'patient', version: 2 })],
      orders: [order(O(1), B.TERM_C, 'registered'), order(O(2), B.TERM_X, 'registered')] });
    const before = w.snapshot(); await run(w, RECONCILE);
    expect(w.snapshot()).toBe(before); expect(w.dml()).toEqual([]);
  });
});

describe('US-EN-14.4 / 14.5 reconcile_bookings: cancelled order -> booking cancelled WITHOUT an event (TRD §4.8, §7.1)', () => {
  it('order cancelled -> booking cancelled (lab_unavailable, by system), transition row, order_id stored, no engagement.booking.cancelled.v1', async () => {
    const w = world({ bookings: [bk(B.CANC_ORD, 1)], orders: [order(O(1), B.CANC_ORD, 'cancelled')] });
    await run(w, RECONCILE);
    expect(w.booking(B.CANC_ORD)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'lab_unavailable', cancelled_by_kind: 'system', version: 2, order_id: O(1) });
    expect(w.booking(B.CANC_ORD)['cancelled_at']).toBe(NOW);
    expect(w.transitions(B.CANC_ORD)).toEqual([expect.objectContaining({ from_status: 'confirmed', to_status: 'cancelled', reason_code: 'lab_unavailable', actor_type: 'system' })]);
    expect(w.events()).toEqual([]); expect(w.events('engagement.booking.cancelled.v1')).toEqual([]);
  });
  it('a later mark_no_shows tick leaves that booking alone (already cancelled; still no event)', async () => {
    const w = world({ bookings: [bk(B.CANC_ORD, 1)], orders: [order(O(1), B.CANC_ORD, 'cancelled')] });
    await run(w, RECONCILE); w.advance(15); await run(w, NO_SHOW);
    expect(w.booking(B.CANC_ORD)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'lab_unavailable' }); expect(w.events()).toEqual([]);
  });
});

describe('D-120 reconcile_bookings acts on centre_visit only, inside its window, from the booking source only', () => {
  it('a home_collection booking is never completed by reconcile (its orders are C17\'s, not in the C4 view)', async () => {
    const w = world({ bookings: [bk(B.HOME, 1, { booking_kind: 'home_collection', home_address_id: ID(0xf01) }), bk(B.HOME_CHK, 2, { booking_kind: 'home_collection', home_address_id: ID(0xf02), status: 'checked_in', version: 2 })],
      orders: [order(O(1), B.HOME, 'registered'), order(O(2), B.HOME_CHK, 'cancelled')] });
    const before = w.snapshot(); await run(w, RECONCILE);
    expect(w.snapshot()).toBe(before); expect(w.dml()).toEqual([]);
  });
  it('window [now - 7 days, now + 1 day]: older and further-out bookings are not selected even when an order is registered', async () => {
    const w = world({ bookings: [bk(B.OLD, 1, { slot_start: new Date(Date.parse(NOW) - 8 * DAY).toISOString(), slot_end: new Date(Date.parse(NOW) - 8 * DAY + 900_000).toISOString() }),
      bk(B.FUTURE, 2, { slot_start: plus(NOW, 26 * 60), slot_end: plus(NOW, 26 * 60 + 15) }), bk(B.REG, 3)],
      orders: [order(O(1), B.OLD, 'registered'), order(O(2), B.FUTURE, 'registered'), order(O(3), B.REG, 'registered')] });
    await run(w, RECONCILE);
    expect(w.booking(B.OLD)['status']).toBe('confirmed'); expect(w.booking(B.FUTURE)['status']).toBe('confirmed'); expect(w.booking(B.REG)['status']).toBe('completed');
  });
  it('only view rows with source = engagement_booking count: another source with the same source_ref_id is ignored, and the statement itself constrains the source', async () => {
    const w = world({ bookings: [bk(B.WRONG_SRC, 1)], orders: [order(O(1), B.WRONG_SRC, 'registered', { source: 'home_collection' })] });
    await run(w, RECONCILE);
    expect(w.booking(B.WRONG_SRC)).toMatchObject({ status: 'confirmed', order_id: null });
    expect(w.viewCalls.length).toBeGreaterThan(0);
    for (const c of w.viewCalls) expect(`${c.text} ${JSON.stringify(c.values)}`).toMatch(/engagement_booking/);
  });
  it('the view is read, never written; every statement binds the tenant (REQ-SEC-024) and no id is concatenated into SQL text', async () => {
    const w = world({ bookings: [bk(B.REG, 1)], orders: [order(O(1), B.REG, 'registered')] });
    await run(w, RECONCILE);
    for (const c of w.db.calls) {
      if (/frontdesk\./i.test(c.text)) expect(c.text).not.toMatch(/^\s*(insert|update|delete)/i);
      else expect(c.values).toContain(TENANT_A);
      expect(c.text).not.toContain(B.REG);
    }
  });
});

describe('US-EN-14.4 mark_no_shows: pre_registered past grace -> cancelled no_show + event, occupancy unchanged', () => {
  it('slot_end + grace over, order pre_registered -> cancelled (reason no_show, by system), transition row, one engagement.booking.cancelled.v1, booked unchanged', async () => {
    const w = world({ bookings: [past(1)], orders: [order(O(1), B.PRE, 'pre_registered')] });
    const occ = JSON.stringify(w.occupancy());
    await run(w, NO_SHOW);
    expect(w.booking(B.PRE)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'no_show', cancelled_by_kind: 'system', version: 2 });
    expect(w.booking(B.PRE)['cancelled_at']).toBe(NOW);
    expect(w.transitions(B.PRE)).toEqual([expect.objectContaining({ from_status: 'confirmed', to_status: 'cancelled', reason_code: 'no_show', actor_type: 'system', actor_id: SYSTEM })]);
    const evs = w.events('engagement.booking.cancelled.v1') as any[];
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ event_type: 'engagement.booking.cancelled.v1', producer: 'engagement', tenant_id: TENANT_A, aggregate: { type: 'booking', id: B.PRE, seq: 2 },
      payload: { booking_id: B.PRE, patient_id: expect.any(String), booking_kind: 'centre_visit', reason_code: 'no_show', cancelled_by_kind: 'system', cancelled_at: NOW, slot_start: expect.any(String) } });
    expect(w.db.tables['event_log']![0]!['idempotency_key']).toBe(`${B.PRE}:cancelled`);
    expect(JSON.stringify(w.occupancy())).toBe(occ);                       // TRD §4.8: no-show does not decrement occupancy (the slot is past)
    expect(w.events('engagement.booking.confirmed.v1')).toEqual([]);
  });
  it('the event payload carries ids and instants only: no booking_no, no name, no phone (07-SECURITY §6)', async () => {
    const w = world({ bookings: [past(1)] });
    await run(w, NO_SHOW);
    const p = (w.events('engagement.booking.cancelled.v1') as any[])[0].payload;
    expect(Object.keys(p).sort()).toEqual(expect.arrayContaining(['booking_id', 'cancelled_at', 'cancelled_by_kind', 'patient_id', 'reason_code', 'slot_start']));
    expect(JSON.stringify(p)).not.toMatch(/BK26|phone|name/i);
  });
  it('no order seen at all counts as still pre_registered: confirmed past grace -> no-show; the order id stays absent from the event', async () => {
    const w = world({ bookings: [bk(B.NONE, 1)], orders: [] });
    await run(w, NO_SHOW);
    expect(w.booking(B.NONE)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'no_show', order_id: null });
    expect((w.events('engagement.booking.cancelled.v1') as any[])[0].payload).not.toHaveProperty('order_id');
  });
  it('fake clock: the strict boundary slot_end + grace < now (not <=); one millisecond later it applies', async () => {
    const w = world({ bookings: [bk(B.EDGE, 1, { slot_start: plus(NOW, -135), slot_end: plus(NOW, -120) })], orders: [order(O(1), B.EDGE, 'pre_registered')] });
    await run(w, NO_SHOW); expect(w.booking(B.EDGE)['status']).toBe('confirmed'); expect(w.events()).toEqual([]);
    w.setNow(new Date(Date.parse(NOW) + 1).toISOString()); await run(w, NO_SHOW);
    expect(w.booking(B.EDGE)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'no_show' }); expect(w.events('engagement.booking.cancelled.v1')).toHaveLength(1);
  });
  it('inside the grace period nothing happens; the tenant setting no_show_grace_minutes is honoured (30 min makes the same booking late)', async () => {
    const mk = (settings: Row) => world({ settings, bookings: [bk(B.RECENT, 1, { slot_start: plus(NOW, -75), slot_end: plus(NOW, -60) })], orders: [order(O(1), B.RECENT, 'pre_registered')] });
    const a = mk({ no_show_grace_minutes: 120 }); await run(a, NO_SHOW); expect(a.booking(B.RECENT)['status']).toBe('confirmed'); expect(a.events()).toEqual([]);
    const b = mk({ no_show_grace_minutes: 30 }); await run(b, NO_SHOW); expect(b.booking(B.RECENT)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'no_show' });
  });
  it('auto_no_show = false (or no settings row) -> nothing is cancelled, nothing published', async () => {
    for (const settings of [{ auto_no_show: false }, null] as const) {
      const w = world({ settings, bookings: [past(1)], orders: [order(O(1), B.PRE, 'pre_registered')] });
      const before = w.snapshot(); await run(w, NO_SHOW);
      expect(w.snapshot()).toBe(before); expect(w.events()).toEqual([]);
    }
  });
  it('order registered / in_progress / completed -> never a no-show, even before reconcile has run (only pre_registered or no order qualifies)', async () => {
    const w = world({ bookings: [bk(B.REG, 1), bk(B.PROG, 2), bk(B.DONE, 3)], orders: [order(O(1), B.REG, 'registered'), order(O(2), B.PROG, 'in_progress'), order(O(3), B.DONE, 'completed')] });
    await run(w, NO_SHOW);
    for (const id of [B.REG, B.PROG, B.DONE]) expect(w.booking(id)['status']).toBe('confirmed');
    expect(w.events()).toEqual([]);
  });
  it('order cancelled by C4 -> not a no-show (reconcile owns that case: cancelled without event)', async () => {
    const w = world({ bookings: [bk(B.CANC_ORD, 1)], orders: [order(O(1), B.CANC_ORD, 'cancelled')] });
    await run(w, NO_SHOW);
    expect(w.booking(B.CANC_ORD)['status']).toBe('confirmed'); expect(w.events()).toEqual([]);
  });
  it('replay: a second tick (or a re-delivered job) leaves ONE event and ONE transition; completed / cancelled bookings are never re-cancelled', async () => {
    const w = world({ bookings: [past(1), bk(B.TERM_C, 2, { status: 'completed', completed_at: plus(NOW, -100), version: 3 }), bk(B.TERM_X, 3, { status: 'cancelled', cancelled_at: plus(NOW, -100), cancel_reason_code: 'patient_request', cancelled_by_kind: 'patient', version: 2 })] });
    await run(w, NO_SHOW); w.advance(15); await run(w, NO_SHOW);
    expect(w.events('engagement.booking.cancelled.v1')).toHaveLength(1); expect(w.transitions(B.PRE)).toHaveLength(1);
    expect(w.booking(B.TERM_C)).toMatchObject({ status: 'completed', version: 3 }); expect(w.booking(B.TERM_X)).toMatchObject({ cancel_reason_code: 'patient_request', cancelled_by_kind: 'patient', version: 2 });
  });
});

describe('US-EN-14.7 / D-120: a home_collection booking is never auto-no-showed', () => {
  it('home_collection past grace (confirmed and checked_in), auto_no_show on, no order in the view -> untouched, no event, no write', async () => {
    const w = world({ bookings: [bk(B.HOME, 1, { booking_kind: 'home_collection', home_address_id: ID(0xf01) }), bk(B.HOME_CHK, 2, { booking_kind: 'home_collection', home_address_id: ID(0xf02), status: 'checked_in', version: 2 })] });
    const before = w.snapshot(); await run(w, NO_SHOW); w.advance(24 * 60); await run(w, NO_SHOW); await run(w, RECONCILE);
    expect(w.snapshot()).toBe(before); expect(w.events()).toEqual([]); expect(w.dml()).toEqual([]);
  });
});

describe('US-EN-14.7 consumer homecollection.collection.synced.v1 (D-120)', () => {
  const home = (id = B.HOME, o: Row = {}) => bk(id, 1, { booking_kind: 'home_collection', home_address_id: ID(0xf01), slot_start: plus(NOW, -60), slot_end: plus(NOW, -30), ...o });

  it('event with booking_id -> the home_collection booking is completed (system) with the event order_id; transition row; NO event; occupancy unchanged', async () => {
    const w = world({ bookings: [home()] }); const occ = JSON.stringify(w.occupancy());
    await deliver(w, { booking_id: B.HOME, order_id: O(7) });
    expect(w.booking(B.HOME)).toMatchObject({ status: 'completed', order_id: O(7), version: 2, cancelled_at: null });
    expect(w.booking(B.HOME)['completed_at']).toBe(NOW);
    expect(w.transitions(B.HOME)).toEqual([expect.objectContaining({ from_status: 'confirmed', to_status: 'completed', actor_type: 'system', actor_id: SYSTEM, tenant_id: TENANT_A })]);
    expect(w.events()).toEqual([]); expect(JSON.stringify(w.occupancy())).toBe(occ);
  });
  it('a checked_in home booking completes the same way', async () => {
    const w = world({ bookings: [home(B.HOME_CHK, { status: 'checked_in', checked_in_at: plus(NOW, -70), version: 2 })] });
    await deliver(w, { booking_id: B.HOME_CHK, order_id: O(8) });
    expect(w.booking(B.HOME_CHK)).toMatchObject({ status: 'completed', order_id: O(8), version: 3 });
    expect(w.transitions(B.HOME_CHK)[0]).toMatchObject({ from_status: 'checked_in', to_status: 'completed', actor_type: 'system' });
  });
  it('duplicate delivery is a no-op; a later synced event for the same booking (other order_id) changes nothing', async () => {
    const w = world({ bookings: [home()] });
    await deliver(w, { booking_id: B.HOME, order_id: O(7) }); const after = w.snapshot();
    await deliver(w, { booking_id: B.HOME, order_id: O(7) }); await deliver(w, { booking_id: B.HOME, order_id: O(9) });
    expect(w.snapshot()).toBe(after); expect(w.booking(B.HOME)).toMatchObject({ order_id: O(7), version: 2 }); expect(w.transitions(B.HOME)).toHaveLength(1);
  });
  it('event WITHOUT booking_id -> no-op: no write, no failure (visits of kind other than booking)', async () => {
    const w = world({ bookings: [home()] }); const before = w.snapshot();
    await deliver(w, {});
    expect(w.snapshot()).toBe(before); expect(w.dml()).toEqual([]); expect(w.events()).toEqual([]);
  });
  it('already completed / cancelled home bookings and an unknown booking_id are silent no-ops', async () => {
    const w = world({ bookings: [home(B.TERM_C, { status: 'completed', completed_at: plus(NOW, -10), order_id: O(5), version: 3 }),
      home(B.TERM_X, { status: 'cancelled', cancelled_at: plus(NOW, -10), cancel_reason_code: 'duplicate', cancelled_by_kind: 'staff', version: 2 })] });
    const before = w.snapshot();
    await deliver(w, { booking_id: B.TERM_C, order_id: O(6) }); await deliver(w, { booking_id: B.TERM_X, order_id: O(6) }); await deliver(w, { booking_id: ID(0x7ff), order_id: O(6) });
    expect(w.snapshot()).toBe(before); expect(w.dml()).toEqual([]);
  });
  it('only home_collection bookings complete from this event: a centre_visit booking carrying the id is left to reconcile', async () => {
    const w = world({ bookings: [bk(B.PRE, 1)] }); const before = w.snapshot();
    await deliver(w, { booking_id: B.PRE, order_id: O(7) });
    expect(w.snapshot()).toBe(before);
  });
  it('home bookings complete only from the event: reconcile and no-show ticks leave them confirmed, the event completes them afterwards', async () => {
    const w = world({ bookings: [home()], orders: [order(O(7), B.HOME, 'registered')] });
    await run(w, RECONCILE); await run(w, NO_SHOW); expect(w.booking(B.HOME)['status']).toBe('confirmed');
    await deliver(w, { booking_id: B.HOME, order_id: O(7) }); expect(w.booking(B.HOME)['status']).toBe('completed');
  });
  it('tenant isolation (REQ-SEC-024): an event of tenant A naming a tenant-B booking completes nothing; an event whose tenant is not the job tenant writes nothing', async () => {
    const other = bk(B.FOREIGN, 5, { tenant_id: TENANT_B, centre_id: CB, slot_occupancy_id: ID(0x606), booking_kind: 'home_collection', home_address_id: ID(0xf09) });
    const w = world({ bookings: [home(), other] }); const before = w.snapshot();
    await deliver(w, { booking_id: B.FOREIGN, order_id: O(7) });
    expect(w.snapshot()).toBe(before);
    await deliver(w, { booking_id: B.HOME, order_id: O(7) }, { tenant_id: TENANT_B }).catch(() => undefined);   // payload tenant is not the job tenant: resolve or throw, but never write
    expect(w.booking(B.HOME)['status']).toBe('confirmed');
  });
  it('hostile booking_id never reaches SQL text and never writes (statements stay parameterised)', async () => {
    const w = world({ bookings: [home()] }); const before = w.snapshot(); const evil = `${B.HOME}'; UPDATE engagement.bookings SET status='completed'--`;
    await deliver(w, { booking_id: evil, order_id: O(7) }).catch(() => undefined);
    expect(w.snapshot()).toBe(before); for (const c of w.db.calls) expect(c.text).not.toContain('UPDATE engagement.bookings SET status=\'completed\'--');
  });
});

describe('cross-cutting: tenant guard, no cross-tenant effects, no extra events', () => {
  it('payload tenant_id other than the job tenant -> no write (REQ-SEC-024, same guard as close_queue_day)', async () => {
    for (const id of [RECONCILE, NO_SHOW]) {
      const w = world({ bookings: [past(1)], orders: [order(O(1), B.PRE, 'registered')] }); const before = w.snapshot();
      await run(w, id, { tenant_id: TENANT_B }).catch(() => undefined);
      expect(w.snapshot()).toBe(before); expect(w.dml()).toEqual([]);
    }
  });
  it('bookings and orders of another tenant are not touched by either cron', async () => {
    const foreign = bk(B.FOREIGN, 9, { tenant_id: TENANT_B, centre_id: CB, slot_occupancy_id: ID(0x606) });
    const w = world({ bookings: [foreign, bk(B.REG, 1), past(2, { id: B.PRE })], orders: [order(O(1), B.REG, 'registered'), order(O(2), B.FOREIGN, 'registered', { tenant_id: TENANT_B, centre_id: CB })] });
    await run(w, RECONCILE); await run(w, NO_SHOW);
    expect(w.booking(B.FOREIGN)).toMatchObject({ status: 'confirmed', order_id: null, version: 1 });
    expect(w.booking(B.REG)['status']).toBe('completed');
    expect(w.events().every((e: any) => e.tenant_id === TENANT_A)).toBe(true);
    expect(w.booking(B.PRE)['status']).toBe('cancelled');
  });
  it('the only event any of the three handlers can emit is engagement.booking.cancelled.v1 from a no-show', async () => {
    const w = world({ bookings: [bk(B.REG, 1), bk(B.CANC_ORD, 2), past(3, { id: B.PRE }), home(B.HOME)], orders: [order(O(1), B.REG, 'registered'), order(O(2), B.CANC_ORD, 'cancelled')] });
    await run(w, RECONCILE); await run(w, NO_SHOW); await deliver(w, { booking_id: B.HOME, order_id: O(7) });
    expect((w.events() as any[]).map((e) => `${e.event_type}:${e.payload.booking_id}`)).toEqual([`engagement.booking.cancelled.v1:${B.PRE}`]);
  });
});

function home(id: string, o: Row = {}) { return bk(id, 1, { booking_kind: 'home_collection', home_address_id: ID(0xf01), slot_start: plus(NOW, -60), slot_end: plus(NOW, -30), ...o }); }
