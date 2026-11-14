// C16.T-BK1 — E30 listMyBookableItems, E31 listMyBookingCentres, E32 listMyAvailableSlots, E33 createMyBooking (+ reschedule), E34 listMyBookings, E35 getMyBooking, E36 cancelMyBooking (patient).
// (06-PLAN row T-BK1; 02-TRD §4.8 create / cancel / reschedule, §5 E30-E36, §7.1 events, §9.1 handler pattern; 03-APP-FLOW §4.1 B-1 / B-3, §6.1 wizard rules, §6.2 reschedule; 05-SCHEMA bookings, slot_occupancy;
//  01-PRD US-EN-12.1-8, 13.1-2, 14.1-3; 07-SECURITY AB-6 / AB-7 / AB-10, REQ-SEC-024 / 098 / 100, §6.1 cross-tenant probes, §6.3 cross-account probes P-L1 / P-L5.)
// tests (plan): limits; sex restriction; address ownership; reschedule atomicity. Addresses E37-E40 live in myaddresses.handlers.test.ts.
// Fails now: handlers/index.ts maps these seven operationIds to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec fixes behaviour, not names; same convention as orders.handlers.test.ts / booking.handlers.test.ts):
//   handlers[op](req:{params,query,headers,body}, ctx) -> {status, body, headers?}; ctx = world.call(...) (see mybooking.world.ts header: patient actor, REAL core events, per-request transaction with rollback on throw,
//   PAT_ACC row filter on accounts / links / addresses / bookings / items / transitions). IdentityPort.assertRole(ctx,{permission}) runs BEFORE any query; a non-patient actor -> auth.forbidden before any query.
//   The account comes from ctx.claims.membership_id (never from input); profile_id in every DTO / body = the link id, never patient_id; the sex comes from the link `sex_snapshot` (no FrontdeskPort in ctx).
//   Create order (TRD §4.8): body (400, unknown key incl. patient_id = AB-7) -> profile = caller's ACTIVE link (404) -> bookings_enabled -> kind / centre / address -> slot window (422) -> orderables (422) -> limits (429)
//   -> reserve (409) -> booking_no -> rows (account_id + link_id + created_via 'app') -> event. Reschedule = the same call with replaces_booking_id (+ replaces_booking_version): ONE transaction, cancel old then create new.
// NOT pinned (spec silent): cursor format; ETag header on 201; the exact cancel reason code of the replaced booking (any ^[a-z0-9_]{1,64}$); the error code for a replaces_booking_version that is missing (400 or 428);
//   a day-cap boundary at local midnight; 426 app-version guard (needs min-version settings). NOT covered: real Postgres RLS / FORCE-RLS, the core Idempotency-Key replay (core pipeline; the app side is proved in the Flutter tests),
//   booking_confirmation SMS body (T-B5), A.D./B.S. rendering (app), row-lock waits.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { eventValidators } from '../../../../core/events/publish.js';
import { handlers } from '../../handlers/index.js';
import { A, B, BR1, BRH, C1, C2, C12, CB, CH, CI, ID, MON, NOW, O, PERMS, S, SLOT, SLOT_2, SLOT_FULL, SLOT_NEAR, SLOT_ONE, makeBookingWorld, plus, type Row, type WorldOpts } from '../../__tests__/mybooking.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const hdr = (res: any, name: string): unknown => { const k = Object.keys(res?.headers ?? {}).find((h) => h.toLowerCase() === name.toLowerCase()); return k ? res.headers[k] : undefined; };

const X = ID(0x800), X2 = ID(0x801), Y = ID(0x802), P_OTHER = ID(0x8ff); // patients: X and X2 (account A1), Y (account A2)
const OLD = '2026-11-01T04:00:00.000Z';   // created long before NOW: never counts toward the per-day cap
const IDEM = { 'idempotency-key': 'k-bk1-0001' };
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });

interface Fx { w: ReturnType<typeof makeBookingWorld>; a1: Row; a2: Row; lx: Row; lx2: Row; ly: Row; run: (op: string, req?: any, who?: Row, extra?: Record<string, unknown>) => ReturnType<ReturnType<typeof makeBookingWorld>['call']>;
  body: (o?: Row) => Row; create: (o?: Row, who?: Row) => ReturnType<Fx['run']>; mine: (over?: Row, link?: Row, occ?: number | null) => Row }
/** Tenant A: account A1 (profiles X female, X2 sex unknown), account A2 (profile Y). The default booking settings are those of 05-SCHEMA (cap 2 per profile, 3 per account and day, lead 120 min, cutoff 60 min). */
function setup(o: WorldOpts = {}): Fx {
  const w = makeBookingWorld(o);
  const a1 = w.seedAccount(), a2 = w.seedAccount({ phone_e164: '+99001000002' });
  const lx = w.seedLink(a1, X, { sex_snapshot: 'female' }), lx2 = w.seedLink(a1, X2, { relationship: 'child', sex_snapshot: null }), ly = w.seedLink(a2, Y);
  const run: Fx['run'] = (op, req = {}, who = a1, extra = {}) => w.call(handlers as any, op, { account: who, ...extra }, req);
  const body = (b: Row = {}) => Object.fromEntries(Object.entries({ profile_id: lx['id'], booking_kind: 'centre_visit', centre_id: C1, slot_start: SLOT, orderable_ids: [O.CBC], ...b }).filter(([, v]) => v !== undefined));
  const create: Fx['create'] = (b = {}, who = a1) => run('createMyBooking', { body: body(b), headers: IDEM }, who);
  /** A confirmed future booking of A1 for X (or `link`) with its own occupancy row (`occ` booked; null = no row yet is not supported: the FK needs one). Old created_at: not in the day cap. */
  const mine: Fx['mine'] = (over = {}, link = lx, occ = 1) => { const slot = over['slot_start'] ?? S('02:15'); const oc = w.occupancyAt(slot) ?? w.seedOccupancy(slot, occ ?? 1); return w.seedBooking(a1, link, link['patient_id'], { slot_start: slot, slot_end: plus(slot, 15), slot_occupancy_id: oc['id'], created_at: OLD, ...over }); };
  return { w, a1, a2, lx, lx2, ly, run, body, create, mine };
}
const code = (r: { error?: any }) => r.error?.code;
const expectErr = (r: { error?: any; out?: any }, c: string, status?: number) => { expect(r.out, `expected ${c}, got a response`).toBeUndefined(); expect(r.error?.code).toBe(c); if (status) expect(r.error?.statusCode).toBe(status); };
const untouched = (f: Fx, r: { calls: any[] }, before: string) => { expect(f.w.dml(r.calls)).toEqual([]); expect(f.w.snapshot()).toBe(before); };

// ================================================================== contract
describe('contract sanity (the spec is the source of permission, idempotency and error codes)', () => {
  it('floors: E30 / E31 / E34 / E35 engagement.self.read; E32 / E33 engagement.booking.create; E36 engagement.booking.cancel', () => {
    for (const op of ['listMyBookableItems', 'listMyBookingCentres', 'listMyBookings', 'getMyBooking']) expect(opOf(op)['x-permission']).toBe(PERMS.READ);
    for (const op of ['listMyAvailableSlots', 'createMyBooking']) expect(opOf(op)['x-permission']).toBe(PERMS.CREATE);
    expect(opOf('cancelMyBooking')['x-permission']).toBe(PERMS.CANCEL);
  });
  it('E33 and E36 require an Idempotency-Key (the app generates one per review step); reads have none; E33 error codes cover the PRD', () => {
    expect(opOf('createMyBooking')['x-idempotency']).toBe('required'); expect(opOf('cancelMyBooking')['x-idempotency']).toBe('required');
    for (const op of ['listMyBookableItems', 'listMyBookingCentres', 'listMyAvailableSlots', 'listMyBookings', 'getMyBooking']) expect(opOf(op)['x-idempotency']).toBe('none');
    expect(opOf('createMyBooking')['x-error-codes']).toEqual(expect.arrayContaining(['engagement.slot_unavailable', 'engagement.slot_outside_window', 'engagement.orderable_not_bookable', 'engagement.address_required', 'engagement.booking_limit_reached',
      'engagement.booking_not_cancellable', 'common.feature_disabled', 'common.idempotency_key_required']));
  });
  it('E33 body forbids extra fields and has no patient_id (AB-7); the confirmed / cancelled events forbid extra payload fields', () => {
    const props = opOf('createMyBooking').requestBody.content['application/json'].schema;
    expect(props.additionalProperties).toBe(false); expect(Object.keys(props.properties)).not.toContain('patient_id');
    for (const t of ['engagement.booking.confirmed.v1', 'engagement.booking.cancelled.v1']) expect(eventValidators().has(t)).toBe(true);
  });
});

// ================================================================== guards (every operation)
const REQS: Array<[string, string, (f: Fx) => any]> = [
  ['listMyBookableItems', PERMS.READ, () => ({ query: { booking_kind: 'centre_visit' } })], ['listMyBookingCentres', PERMS.READ, () => ({ query: { booking_kind: 'centre_visit' } })],
  ['listMyAvailableSlots', PERMS.CREATE, () => ({ query: { booking_kind: 'centre_visit', centre_id: C1, date_from: MON, date_to: MON } })], ['createMyBooking', PERMS.CREATE, (f) => ({ body: f.body(), headers: IDEM })],
  ['listMyBookings', PERMS.READ, () => ({ query: {} })], ['getMyBooking', PERMS.READ, (f) => ({ params: { booking_id: f.mine()['id'] } })],
  ['cancelMyBooking', PERMS.CANCEL, (f) => { const b = f.mine(); return { params: { booking_id: b['id'] }, headers: { ...IDEM, ...ifm(1) } }; }],
];
describe('guards: permission first, patient actors only, nothing served without the port', () => {
  for (const [op, perm, req] of REQS) {
    it(`${op}: assertRole(${perm}) runs before any query; without the grant -> auth.forbidden and no statement at all`, async () => {
      const f = setup(); const ok = await f.run(op, req(f)); expect(ok.error, `${op} must not fail for a granted patient`).toBeUndefined();
      expect(f.w.identityCalls[0]).toMatchObject({ permission: perm, at: 0 }); // assertRole runs before the first statement of the request
      const g = setup(); const r = await g.run(op, req(g), g.a1, { grants: [] }); expectErr(r, 'auth.forbidden', 403); expect(r.calls).toHaveLength(0);
    });
    it(`${op}: a staff / display actor is refused with auth.forbidden before any query`, async () => {
      const f = setup(); const r = await f.run(op, req(f), f.a1, { actorType: 'user' }); expectErr(r, 'auth.forbidden', 403); expect(r.calls).toHaveLength(0);
    });
  }
});

// ================================================================== E30
describe('E30 listMyBookableItems (US-EN-12.2 catalogue; wizard step 3)', () => {
  it('lists the ACTIVE items bookable for the kind; DTO is schema-valid, carries sex_restriction (the app filters), never ids / versions / tenant B items', async () => {
    const f = setup(); const r = await f.run('listMyBookableItems', { query: { booking_kind: 'centre_visit' } });
    expect(r.out.status).toBe(200); const names = r.out.body.data.map((d: any) => d.orderable_id);
    expect(names).toEqual(expect.arrayContaining([O.CBC, O.GLU, O.WHP, O.PSA])); for (const bad of [O.HOME_ONLY, O.OFF, O.B_ONLY]) expect(names).not.toContain(bad);
    for (const d of r.out.body.data) expect(schemaErrors('BookableItem', d)).toEqual([]);
    expect(r.out.body.data.find((d: any) => d.orderable_id === O.WHP)).toMatchObject({ kind: 'panel', sex_restriction: 'female', indicative_price: { amount_paisa: 250000, currency: 'NPR' } });
    expect(r.out.body.data.find((d: any) => d.orderable_id === O.PSA).indicative_price).toBeUndefined(); // no price -> the app shows "Price at the lab"
    expect(typeof r.out.body.page.limit).toBe('number');expect(String(hdr(r.out, 'cache-control'))).toMatch(/no-store/i);
    expect(JSON.stringify(r.out.body)).not.toMatch(/"version"|"id"|is_active|catalog_revision|synced_at|tenant/);
  });
  it('home_collection lists the home-bookable items (incl. the home-only test); a 41-char query is a 400; the query narrows by name; hostile text is data, never an error', async () => {
    const f = setup(); const home = (await f.run('listMyBookableItems', { query: { booking_kind: 'home_collection' } })).out.body.data.map((d: any) => d.orderable_id); expect(home).toContain(O.HOME_ONLY);
    expectErr(await f.run('listMyBookableItems', { query: { booking_kind: 'centre_visit', query: 'x'.repeat(41) } }), 'common.validation_failed', 400);
    expect((await f.run('listMyBookableItems', { query: { booking_kind: 'centre_visit', query: 'glucose' } })).out.body.data.map((d: any) => d.orderable_id)).toEqual([O.GLU]);
    const evil = await f.run('listMyBookableItems', { query: { booking_kind: 'centre_visit', query: "'; DROP TABLE x; --" } }); expect(evil.error).toBeUndefined(); expect(evil.out.body.data).toEqual([]);
    expectErr(await f.run('listMyBookableItems', { query: { booking_kind: 'teleport' } }), 'common.validation_failed', 400); expectErr(await f.run('listMyBookableItems', { query: {} }), 'common.validation_failed', 400);
  });
  it('limit pages the list (cursor round-trips, no duplicates, limit > 200 is a 400)', async () => {
    const f = setup(); const p1 = (await f.run('listMyBookableItems', { query: { booking_kind: 'centre_visit', limit: 2 } })).out.body; expect(p1.data).toHaveLength(2); expect(typeof p1.page.next_cursor).toBe('string');
    const p2 = (await f.run('listMyBookableItems', { query: { booking_kind: 'centre_visit', limit: 2, cursor: p1.page.next_cursor } })).out.body;
    expect(p2.data.length).toBeGreaterThan(0); expect(p2.data.map((d: any) => d.orderable_id).filter((x: string) => p1.data.some((d: any) => d.orderable_id === x))).toEqual([]);
    expectErr(await f.run('listMyBookableItems', { query: { booking_kind: 'centre_visit', limit: 201 } }), 'common.validation_failed', 400);
  });
  it('bookings switched off -> 403 common.feature_disabled', async () => { const f = setup({ settings: { bookings_enabled: false } }); expectErr(await f.run('listMyBookableItems', { query: { booking_kind: 'centre_visit' } }), 'common.feature_disabled', 403); });
});

// ================================================================== E31
describe('E31 listMyBookingCentres (wizard step 4; D-119: only engagement.booking_centres)', () => {
  it('centre_visit: active centres of the tenant with name + address text, kinds include the requested kind; inactive and tenant B centres are absent; no branch / tenant ids leak', async () => {
    const f = setup(); const r = await f.run('listMyBookingCentres', { query: { booking_kind: 'centre_visit' } }); expect(r.out.status).toBe(200);
    const ids = r.out.body.data.map((c: any) => c.centre_id); expect(ids).toEqual(expect.arrayContaining([C1, C2])); for (const bad of [CI, CB]) expect(ids).not.toContain(bad);
    for (const c of r.out.body.data) { expect(schemaErrors('BookingCentre', c)).toEqual([]); expect(c.booking_kinds).toContain('centre_visit'); }
    expect(r.out.body.data.find((c: any) => c.centre_id === C1)).toMatchObject({ display_name: 'Synthetic Centre One', address_text: 'Synthetic Road 1' });
    expect(JSON.stringify(r.out.body)).not.toMatch(/branch|tenant_id|synced_at/); expect(String(hdr(r.out, 'cache-control'))).toMatch(/no-store/i);
  });
  it('home_collection: only centres that offer it (H); a centre-visit-only centre is not listed for it; the request reads booking_centres and no core table', async () => {
    const f = setup(); const r = await f.run('listMyBookingCentres', { query: { booking_kind: 'home_collection' } });
    for (const c of r.out.body.data) expect(c.booking_kinds).toContain('home_collection'); expect(r.out.body.data.map((c: any) => c.centre_id)).not.toContain(C1);
    expect(r.calls.map((c) => c.text).join('\n')).not.toMatch(/\bcore\.(collection_centres|branches)\b/i);
  });
  it('validation and feature gate', async () => {
    const f = setup(); expectErr(await f.run('listMyBookingCentres', { query: {} }), 'common.validation_failed', 400);
    const g = setup({ settings: { bookings_enabled: false } }); expectErr(await g.run('listMyBookingCentres', { query: { booking_kind: 'centre_visit' } }), 'common.feature_disabled', 403);
  });
});

// ================================================================== E32
describe('E32 listMyAvailableSlots (US-EN-12.1; wizard step 5)', () => {
  const slots = (f: Fx, q: Row) => f.run('listMyAvailableSlots', { query: { booking_kind: 'centre_visit', centre_id: C1, date_from: MON, date_to: MON, ...q } });
  it('Mon 16 Nov at C1: the 16 template slots minus the full one; remaining = capacity - booked; DTO schema-valid; start / end are UTC instants', async () => {
    const f = setup(); const r = await slots(f, {}); expect(r.out.status).toBe(200);
    const d = r.out.body.data; expect(d).toHaveLength(15); for (const s of d) { expect(schemaErrors('Slot', s)).toEqual([]); expect(s).toMatchObject({ booking_kind: 'centre_visit', centre_id: C1 }); }
    expect(d.map((s: any) => s.slot_start)).not.toContain(SLOT_FULL); expect(d[0]).toMatchObject({ slot_start: SLOT, slot_end: plus(SLOT, 15), remaining: 3 });
    expect(d.find((s: any) => s.slot_start === SLOT_ONE).remaining).toBe(1); expect(d.map((s: any) => s.slot_start)).toEqual([...d.map((s: any) => s.slot_start)].sort());
    expect(String(hdr(r.out, 'cache-control'))).toMatch(/no-store/i); expect(JSON.stringify(d)).not.toMatch(/capacity|booked|overbooked/); // patients never see the capacity numbers
  });
  it('remaining is capped at 9 (the app prints "9+")', async () => { const f = setup(); const d = (await slots(f, { centre_id: C12 })).out.body.data; expect(d.length).toBeGreaterThan(0); for (const s of d) expect(s.remaining).toBe(9); });
  it('slots inside the lead time, in the past, or inside a blackout are not offered; a day with nothing bookable is an empty list', async () => {
    const f = setup(); expect((await slots(f, { date_from: '2026-11-10', date_to: '2026-11-10' })).out.body.data).toEqual([]); // Tue 10 Nov: every slot is past or < now + 120 min
    const wed = (await slots(f, { date_from: '2026-11-17', date_to: '2026-11-18' })).out.body.data.map((s: any) => s.slot_start);
    expect(wed.some((s: string) => s.startsWith('2026-11-17'))).toBe(true); for (const s of wed.filter((x: string) => x.startsWith('2026-11-18'))) expect(Date.parse(s)).toBeGreaterThanOrEqual(Date.parse('2026-11-18T03:15:00.000Z'));
    expect(wed.map((s: string) => s)).not.toContain('2026-11-18T01:15:00.000Z');
  });
  it('beyond the horizon: nothing offered (empty list or engagement.slot_outside_window); a range longer than 7 days is refused', async () => {
    const f = setup(); const r = await slots(f, { date_from: '2026-12-07', date_to: '2026-12-07' }); if (r.error) expect(code(r)).toBe('engagement.slot_outside_window'); else expect(r.out.body.data).toEqual([]);
    const long = await slots(f, { date_from: MON, date_to: '2026-11-25' }); expect(['common.validation_failed', 'engagement.slot_outside_window']).toContain(code(long)); expect(long.out).toBeUndefined();
  });
  it('home_collection without centre_id uses the home centre H; centre_visit needs centre_id; a foreign-tenant centre yields nothing', async () => {
    const f = setup(); const h = await f.run('listMyAvailableSlots', { query: { booking_kind: 'home_collection', date_from: MON, date_to: MON } });
    expect(h.out.body.data).toHaveLength(5); for (const s of h.out.body.data) expect(s).toMatchObject({ booking_kind: 'home_collection', centre_id: CH });
    expectErr(await f.run('listMyAvailableSlots', { query: { booking_kind: 'centre_visit', date_from: MON, date_to: MON } }), 'common.validation_failed', 400);
    const b = await slots(f, { centre_id: CB }); if (b.error) expect(['common.not_found', 'common.validation_failed']).toContain(code(b)); else expect(b.out.body.data).toEqual([]);
    expectErr(await slots(f, { date_from: 'tomorrow' }), 'common.validation_failed', 400);
  });
  it('home_collection switched off -> 403 common.feature_disabled; a read writes nothing', async () => {
    const f = setup({ settings: { home_collection_enabled: false } }); const before = f.w.snapshot();
    const r = await f.run('listMyAvailableSlots', { query: { booking_kind: 'home_collection', date_from: MON, date_to: MON } }); expectErr(r, 'common.feature_disabled', 403); untouched(f, r, before);
  });
});

// ================================================================== E33 create
describe('E33 createMyBooking: US-EN-12.2 confirms in one transaction and publishes engagement.booking.confirmed.v1', () => {
  it('201 Booking for the caller\'s profile: occupancy +1, booking (account_id, link_id, created_via app), items with price snapshots, a patient transition, booking_no and the event are all written', async () => {
    const f = setup(); const r = await f.create(); expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201);
    const b = r.out.body; expect(schemaErrors('Booking', b)).toEqual([]);
    expect(b).toMatchObject({ booking_no: 'BK26000001', status: 'confirmed', created_via: 'app', profile_id: f.lx['id'], centre_id: C1, centre_display_name: 'Synthetic Centre One', booking_kind: 'centre_visit', slot_start: SLOT, slot_end: plus(SLOT, 15), version: 1 });
    expect(b.items).toEqual([{ orderable_id: O.CBC, display_name: 'Complete Blood Count', indicative_price: { amount_paisa: 45000, currency: 'NPR' } }]);
    expect(b.cancellable_until).toBe(plus(SLOT, -60)); expect(JSON.stringify(b)).not.toContain(X); expect(String(hdr(r.out, 'cache-control'))).toMatch(/no-store/i);
    expect(f.w.occupancyAt(SLOT)).toMatchObject({ tenant_id: A, centre_id: C1, booking_kind: 'centre_visit', capacity: 3, booked: 1 });
    expect(f.w.row('bookings', b.id)).toMatchObject({ tenant_id: A, booking_no: 'BK26000001', account_id: f.a1['id'], link_id: f.lx['id'], patient_id: X, created_via: 'app', branch_id: BR1, centre_id: C1, status: 'confirmed', confirmed_at: NOW, home_address_id: null, replaces_booking_id: null, version: 1, created_by: f.a1['user_id'] });
    expect(f.w.t['booking_items']!.filter((i) => i['booking_id'] === b.id)).toEqual([expect.objectContaining({ account_id: f.a1['id'], orderable_id: O.CBC, orderable_kind: 'test', display_name_snapshot: 'Complete Blood Count', indicative_price_paisa: 45000 })]);
    expect(f.w.t['booking_transitions']!.filter((t) => t['booking_id'] === b.id)).toEqual([expect.objectContaining({ from_status: null, to_status: 'confirmed', actor_type: 'patient', actor_id: f.a1['user_id'], account_id: f.a1['id'] })]);
    expect(f.w.t['number_counters']).toEqual([expect.objectContaining({ counter_key: 'booking_no:26', last_value: 1 })]);
    const ev = f.w.events(); expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: 'engagement.booking.confirmed.v1', producer: 'engagement', tenant_id: A, idempotency_key: `${b.id}:confirmed`, actor: { type: 'patient', id: f.a1['user_id'] }, aggregate: { type: 'booking', id: b.id, seq: 1 } });
    expect(ev[0].payload).toEqual({ booking_id: b.id, patient_id: X, branch_id: BR1, centre_id: C1, booking_kind: 'centre_visit', slot_start: SLOT, slot_end: plus(SLOT, 15), orderable_ids: [O.CBC], confirmed_at: NOW });
    expect(eventValidators().get('engagement.booking.confirmed.v1')!(ev[0])).toBe(true); expect(JSON.stringify(ev[0])).not.toContain('BK26000001');
    expect(f.w.jobs(r.calls, 'engagement.send_booking_message')).toHaveLength(1); expect(f.w.jobs(r.calls, 'engagement.send_booking_message')[0]!.values[2]).toBe(`bmsg:${b.id}:confirmation`); // US-EN-12.8
  });
  it('the request body is the ONLY source of the profile: a patient_id (AB-7) or any unknown key is a 400 and nothing is written; a missing field is a 400 with a fixed path', async () => {
    const f = setup(); const before = f.w.snapshot();
    for (const extra of [{ patient_id: X }, { account_id: f.a1['id'] }, { created_via: 'staff' }, { status: 'completed' }]) { const r = await f.create(extra); expectErr(r, 'common.validation_failed', 400); untouched(f, r, before); }
    for (const k of ['profile_id', 'booking_kind', 'slot_start', 'orderable_ids']) { const b: Row = f.body(); delete b[k]; expectErr(await f.run('createMyBooking', { body: b, headers: IDEM }), 'common.validation_failed', 400); }
    expect(f.w.observed()).not.toContain(X);
  });
  it('profile ownership (AB-6, P-L1, P-L5): another account\'s profile, a revoked or suspended link, an unknown id and a tenant-B id are all 404 common.not_found with zero writes', async () => {
    const f = setup(); const rev = f.w.seedLink(f.a1, ID(0x8a1), { status: 'revoked' }), sus = f.w.seedLink(f.a1, ID(0x8a2), { status: 'suspended' }); const before = f.w.snapshot();
    for (const pid of [f.ly['id'], rev['id'], sus['id'], ID(0x8fe), X /* a patient id is not a profile id */]) { const r = await f.create({ profile_id: pid }); expectErr(r, 'common.not_found', 404); untouched(f, r, before); }
    expect(f.w.t['bookings']).toHaveLength(0); expect(f.w.events()).toHaveLength(0);
  });
  it('booking_no is BK{yy}{seq:6} and increments per tenant and year; the number is NOT consumed by a refused request', async () => {
    const f = setup(); const one = await f.create(); const two = await f.create({ profile_id: f.lx2['id'], slot_start: SLOT_2 });
    expect([one.out.body.booking_no, two.out.body.booking_no]).toEqual(['BK26000001', 'BK26000002']);
    await f.create({ slot_start: SLOT_FULL }); expect(f.w.t['number_counters']).toEqual([expect.objectContaining({ counter_key: 'booking_no:26', last_value: 2 })]);
  });
  it('two orderables keep their order, price snapshots and sum; the event lists both ids', async () => {
    const f = setup(); const r = await f.create({ orderable_ids: [O.GLU, O.CBC] });
    expect(r.out.body.items.map((i: any) => i.orderable_id)).toEqual([O.GLU, O.CBC]); expect(f.w.events()[0].payload.orderable_ids).toEqual([O.GLU, O.CBC]);
    expect(f.w.t['booking_items']!.filter((i) => i['booking_id'] === r.out.body.id).map((i) => i['indicative_price_paisa']).sort()).toEqual([20000, 45000]);
  });
  it('PHI hygiene: booking number, patient / profile ids, names and phone never reach logs or metrics (REQ-SEC-098)', async () => {
    const f = setup(); const r = await f.create(); expect(r.out.status).toBe(201); const text = f.w.observed();
    for (const v of ['BK26000001', X, 'Synthetic Patient', '+99001000001']) expect(text).not.toContain(v);
  });
});

describe('US-EN-12.7 / 12.3: slot window and capacity', () => {
  const outside: Record<string, string> = {
    'off the 15-minute grid': S('01:22'), 'on a Saturday (template weekdays 1-5)': '2026-11-14T01:15:00.000Z', 'inside the blackout of Wed 18 Nov': '2026-11-18T01:30:00.000Z', 'in the past': '2026-11-09T01:15:00.000Z',
    'earlier than now + lead (120 min)': '2026-11-10T05:00:00.000Z', 'beyond the horizon (14 days)': '2026-11-24T01:15:00.000Z', 'after the template end (11:00 NPT)': S('05:15'),
  };
  for (const [name, slot] of Object.entries(outside)) {
    it(`422 engagement.slot_outside_window for a slot ${name}; nothing is written`, async () => { const f = setup(); const before = f.w.snapshot(); const r = await f.create({ slot_start: slot }); expectErr(r, 'engagement.slot_outside_window', 422); untouched(f, r, before); });
  }
  it('the last place of a slot is bookable; the next attempt gets 409 engagement.slot_unavailable with booked unchanged and no number consumed', async () => {
    const f = setup(); expect((await f.create({ slot_start: SLOT_ONE })).out.status).toBe(201); expect(f.w.occupancyAt(SLOT_ONE)!['booked']).toBe(3);
    const no = f.w.t['number_counters']![0]!['last_value']; const r2 = await f.create({ profile_id: f.ly['id'], slot_start: SLOT_ONE }, f.a2);
    expectErr(r2, 'engagement.slot_unavailable', 409); expect(f.w.occupancyAt(SLOT_ONE)!['booked']).toBe(3); expect(f.w.t['number_counters']![0]!['last_value']).toBe(no); expect(f.w.events()).toHaveLength(1); expect(f.w.t['bookings']).toHaveLength(1);
  });
  it('a full slot (3/3) -> 409 engagement.slot_unavailable and nothing is written', async () => { const f = setup(); const before = f.w.snapshot(); const r = await f.create({ slot_start: SLOT_FULL }); expectErr(r, 'engagement.slot_unavailable', 409); untouched(f, r, before); });
  it('20 concurrent attempts (20 accounts) for the last place: exactly one 201, nineteen 409 engagement.slot_unavailable, booked = capacity, one event, one booking', async () => {
    const f = setup(); const users = Array.from({ length: 20 }, (_, i) => { const a = f.w.seedAccount({ phone_e164: `+990010${String(i).padStart(5, '0')}` }); return { a, l: f.w.seedLink(a, ID(0x1000 + i)) }; });
    const res = await Promise.all(users.map((u) => f.create({ profile_id: u.l['id'], slot_start: SLOT_ONE }, u.a)));
    expect(res.filter((r) => r.out?.status === 201)).toHaveLength(1); expect(res.filter((r) => r.error?.code === 'engagement.slot_unavailable' && r.error?.statusCode === 409)).toHaveLength(19);
    expect(f.w.occupancyAt(SLOT_ONE)!['booked']).toBe(3); expect(f.w.events('engagement.booking.confirmed.v1')).toHaveLength(1); expect(f.w.t['bookings']).toHaveLength(1);
    expect(f.w.t['booking_items']).toHaveLength(1); expect(f.w.t['booking_transitions']).toHaveLength(1);
  });
  it('the same profile double-submitting an empty slot concurrently never holds two places of one slot beyond its caps (<= 2 active) and occupancy matches the bookings', async () => {
    const f = setup(); const res = await Promise.all([1, 2, 3].map(() => f.create({ slot_start: SLOT_2 })));
    const ok = res.filter((r) => r.out?.status === 201).length; expect(ok).toBeLessThanOrEqual(2); expect(f.w.occupancyAt(SLOT_2)!['booked']).toBe(ok); expect(f.w.t['bookings']).toHaveLength(ok);
    for (const r of res.filter((x) => x.error)) expect(['engagement.booking_limit_reached', 'engagement.slot_unavailable']).toContain(code(r));
  });
});

describe('US-EN-12.5: orderables and sex restriction (sex from the profile\'s link sex_snapshot)', () => {
  it('an unknown, inactive, home-only (for a centre visit) or tenant-B orderable -> 422 engagement.orderable_not_bookable; nothing written', async () => {
    const f = setup(); const before = f.w.snapshot();
    for (const id of [O.UNKNOWN, O.OFF, O.HOME_ONLY, O.B_ONLY]) { const r = await f.create({ orderable_ids: [O.CBC, id] }); expectErr(r, 'engagement.orderable_not_bookable', 422); untouched(f, r, before); }
  });
  it('female-only package: a female profile may book it, a male profile may not (422), a profile of unknown sex may (restriction not enforced)', async () => {
    const f = setup(); const male = f.w.seedLink(f.a1, ID(0x8b1), { sex_snapshot: 'male' });
    expect((await f.create({ orderable_ids: [O.WHP] })).out.status).toBe(201);
    const r = await f.create({ profile_id: male['id'], orderable_ids: [O.CBC, O.WHP], slot_start: SLOT_2 }); expectErr(r, 'engagement.orderable_not_bookable', 422);
    expect((await f.create({ profile_id: f.lx2['id'], orderable_ids: [O.WHP], slot_start: SLOT_2 })).out.status).toBe(201);
  });
  it('male-only test: refused for a female profile, accepted for a male one', async () => {
    const f = setup(); const male = f.w.seedLink(f.a1, ID(0x8b2), { sex_snapshot: 'male' });
    expectErr(await f.create({ orderable_ids: [O.PSA] }), 'engagement.orderable_not_bookable', 422); expect((await f.create({ profile_id: male['id'], orderable_ids: [O.PSA] })).out.status).toBe(201);
  });
  it('the sex is read from the link row, not from a port (no FrontdeskPort call is possible: the port is absent from ctx) and an event never carries it', async () => {
    const f = setup(); const r = await f.create({ orderable_ids: [O.WHP] }); expect(r.out.status).toBe(201); expect(JSON.stringify(f.w.events())).not.toMatch(/sex|female|male/i);
  });
  it('max_orderables_per_booking is enforced by the service (3 > 2 -> 422); 0, 51 or duplicate ids are a 400', async () => {
    const f = setup({ settings: { max_orderables_per_booking: 2 } }); expectErr(await f.create({ orderable_ids: [O.CBC, O.GLU, O.WHP] }), 'engagement.orderable_not_bookable', 422);
    const g = setup(); for (const ids of [[], Array.from({ length: 51 }, (_, i) => ID(0x4000 + i)), [O.CBC, O.CBC], ['not-a-uuid']]) expectErr(await g.create({ orderable_ids: ids }), 'common.validation_failed', 400);
  });
});

describe('US-EN-12.6 / AB-10: booking limits (429 engagement.booking_limit_reached)', () => {
  it('a profile with max_active_bookings_per_profile (2) future confirmed bookings cannot book a third', async () => {
    const f = setup(); f.mine({ slot_start: S('03:00') }); f.mine({ slot_start: S('03:15') }); const before = f.w.snapshot(); const r = await f.create({ slot_start: SLOT_2 }); expectErr(r, 'engagement.booking_limit_reached', 429); untouched(f, r, before);
  });
  it('cancelled, completed and past bookings do not count against the active limit', async () => {
    const f = setup(); f.mine({ slot_start: S('03:00') });
    f.mine({ slot_start: S('03:15'), status: 'cancelled', cancelled_at: NOW, cancel_reason_code: 'patient_request', cancelled_by_kind: 'patient' }); f.mine({ slot_start: S('03:30'), status: 'completed', completed_at: NOW });
    f.mine({ slot_start: '2026-11-03T02:15:00.000Z' }); expect((await f.create({ slot_start: SLOT_2 })).out.status).toBe(201);
  });
  it('the limit is per profile: the other profile of the same account is not blocked', async () => {
    const f = setup(); f.mine({ slot_start: S('03:00') }); f.mine({ slot_start: S('03:15') }); expect((await f.create({ profile_id: f.lx2['id'], slot_start: SLOT_2 })).out.status).toBe(201);
  });
  it('staff-entered bookings of the same patient do not hide the limit from the account: the account\'s own count is what the patient policy shows', async () => {
    const f = setup(); const oc = f.w.seedOccupancy(S('03:00'), 1); f.w.seedBooking(null, null, X, { slot_start: S('03:00'), slot_end: S('03:15'), slot_occupancy_id: oc['id'], created_at: OLD }); expect((await f.create({ slot_start: SLOT_2 })).error).toBeUndefined();
  });
  it('max_bookings_created_per_account_day (3): the 4th booking CREATED today by the account is refused, cancelled ones included; bookings created on earlier days and other accounts\' bookings do not count', async () => {
    const f = setup(); const today = { created_at: NOW };
    f.mine({ slot_start: S('03:00'), ...today }); f.mine({ slot_start: S('03:15'), status: 'cancelled', cancelled_at: NOW, cancel_reason_code: 'patient_request', cancelled_by_kind: 'patient', ...today }); f.mine({ slot_start: S('03:30'), ...today }, f.lx2);
    const before = f.w.snapshot(); const r = await f.create({ profile_id: f.lx2['id'], slot_start: SLOT_2 }); expectErr(r, 'engagement.booking_limit_reached', 429); untouched(f, r, before);
    const g = setup(); for (const s of ['03:00', '03:15', '03:30']) g.mine({ slot_start: S(s), status: 'completed', completed_at: NOW, created_at: '2026-11-08T04:00:00.000Z' }); expect((await g.create({ slot_start: SLOT_2 })).out.status).toBe(201);
    const h = setup(); const ob = h.w.seedLink(h.a2, ID(0x8c1)); for (const s of ['03:00', '03:15', '03:30']) { const oc = h.w.seedOccupancy(S(s), 1); h.w.seedBooking(h.a2, ob, ID(0x8c1), { slot_start: S(s), slot_end: plus(S(s), 15), slot_occupancy_id: oc['id'], created_at: NOW }); }
    expect((await h.create({ slot_start: SLOT_2 })).out.status).toBe(201);
  });
  it('the settings values are honoured (max_active_bookings_per_profile = 1)', async () => { const f = setup({ settings: { max_active_bookings_per_profile: 1 } }); f.mine({ slot_start: S('03:00') }); expectErr(await f.create({ slot_start: SLOT_2 }), 'engagement.booking_limit_reached', 429); });
  it('bookings switched off -> 403 common.feature_disabled, nothing written', async () => { const f = setup({ settings: { bookings_enabled: false } }); const before = f.w.snapshot(); const r = await f.create(); expectErr(r, 'common.feature_disabled', 403); untouched(f, r, before); });
});

describe('US-EN-13.1 / 13.2: home collection and address ownership', () => {
  const home = (f: Fx, addr: string | undefined, o: Row = {}) => f.create({ booking_kind: 'home_collection', centre_id: undefined, slot_start: S('02:15'), ...(addr ? { home_address_id: addr } : {}), ...o });
  it('with the caller\'s own address: 201, centre = the home centre H, home_address_id set, kind home_collection; the event carries the id but NOT the address text', async () => {
    const f = setup(); const d = f.w.seedAddress(f.a1, X, { address_text: 'Hidden Tole 99, Ward 7' }); const r = await home(f, d['id']); expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201);
    expect(schemaErrors('Booking', r.out.body)).toEqual([]); expect(r.out.body).toMatchObject({ booking_kind: 'home_collection', centre_id: CH, home_address_id: d['id'], profile_id: f.lx['id'] }); expect(JSON.stringify(r.out.body)).not.toContain('Hidden Tole');
    expect(f.w.row('bookings', r.out.body.id)).toMatchObject({ booking_kind: 'home_collection', centre_id: CH, branch_id: BRH, home_address_id: d['id'], account_id: f.a1['id'] });
    const e = f.w.events('engagement.booking.confirmed.v1')[0]; expect(e.payload).toMatchObject({ booking_kind: 'home_collection', centre_id: CH, home_address_id: d['id'], patient_id: X }); expect(JSON.stringify(e)).not.toContain('Hidden Tole');
    expect(f.w.occupancyAt(S('02:15'), CH, 'home_collection')).toMatchObject({ booked: 1, capacity: 5 }); expect(f.w.observed()).not.toContain('Hidden Tole');
  });
  it('no address -> 422 engagement.address_required, nothing written', async () => { const f = setup(); const before = f.w.snapshot(); const r = await home(f, undefined); expectErr(r, 'engagement.address_required', 422); untouched(f, r, before); });
  it('another account\'s address, a staff-entered address (account_id NULL), a tenant-unknown id: 404 common.not_found (RLS hides them), nothing written', async () => {
    const f = setup(); const theirs = f.w.seedAddress(f.a2, Y), staff = f.w.seedAddress(null, X); const before = f.w.snapshot();
    for (const id of [theirs['id'], staff['id'], ID(0x8fd)]) { const r = await home(f, id); expectErr(r, 'common.not_found', 404); untouched(f, r, before); }
  });
  it('an address of ANOTHER profile of the same account, or an inactive address, cannot be used for this profile', async () => {
    const f = setup(); const other = f.w.seedAddress(f.a1, X2), gone = f.w.seedAddress(f.a1, X, { is_active: false }); const before = f.w.snapshot();
    for (const id of [other['id'], gone['id']]) { const r = await home(f, id); expect(['common.not_found', 'engagement.address_required']).toContain(code(r)); untouched(f, r, before); }
  });
  it('an address on a centre visit is a 400 (home_address_id only with home_collection); home collection switched off -> 403', async () => {
    const f = setup(); const d = f.w.seedAddress(f.a1, X); expectErr(await f.create({ home_address_id: d['id'] }), 'common.validation_failed', 400);
    const g = setup({ settings: { home_collection_enabled: false } }); const d2 = g.w.seedAddress(g.a1, X); expectErr(await home(g, d2['id']), 'common.feature_disabled', 403);
  });
});

describe('centre probes: the centre comes from the active booking_centres projection only', () => {
  it('an inactive centre, a tenant-B centre and an unknown centre are refused (404 or 400) and nothing is written; a centre_visit without centre_id is a 400', async () => {
    const f = setup(); const before = f.w.snapshot();
    for (const c of [CI, CB, ID(0xc99)]) { const r = await f.create({ centre_id: c }); expect(['common.not_found', 'common.validation_failed']).toContain(code(r)); untouched(f, r, before); }
    expectErr(await f.create({ centre_id: undefined }), 'common.validation_failed', 400);
  });
  it('a booking at centre C2 uses C2\'s branch and name', async () => { const f = setup(); const oc = await f.create({ centre_id: C2 }); expect(oc.out.body).toMatchObject({ centre_id: C2, centre_display_name: 'Synthetic Centre Two' }); expect(f.w.events()[0].payload.branch_id).toBe(ID(0x12)); });
});

// ================================================================== reschedule
describe('US-EN-14.3: reschedule = E33 with replaces_booking_id, ONE transaction (cancel old, confirm new)', () => {
  const resched = (f: Fx, old: Row, o: Row = {}, who = f.a1) => f.create({ slot_start: SLOT_2, replaces_booking_id: old['id'], replaces_booking_version: old['version'], ...o }, who);
  it('old -> cancelled by patient (version + 1, occupancy - 1, transition, cancelled event), new -> confirmed with replaces_booking_id, two events, both occupancy rows consistent', async () => {
    const f = setup(); const old = f.mine({ slot_start: S('02:15') }); const oldOcc = f.w.row('slot_occupancy', old['slot_occupancy_id'])!; const r = await resched(f, old);
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201); expect(schemaErrors('Booking', r.out.body)).toEqual([]); expect(r.out.body).toMatchObject({ status: 'confirmed', slot_start: SLOT_2, booking_no: 'BK26000001' });
    expect(f.w.row('bookings', old['id'])).toMatchObject({ status: 'cancelled', cancelled_by_kind: 'patient', version: 2 }); expect(f.w.row('bookings', old['id'])!['cancel_reason_code']).toMatch(/^[a-z0-9_]{1,64}$/);
    expect(f.w.row('bookings', r.out.body.id)).toMatchObject({ replaces_booking_id: old['id'], status: 'confirmed', account_id: f.a1['id'], link_id: f.lx['id'] });
    expect(oldOcc['booked']).toBe(0); expect(f.w.occupancyAt(SLOT_2)!['booked']).toBe(1);
    expect(f.w.t['booking_transitions']!.filter((t) => t['booking_id'] === old['id'] && t['to_status'] === 'cancelled')).toEqual([expect.objectContaining({ from_status: 'confirmed', actor_type: 'patient' })]);
    const c = f.w.events('engagement.booking.cancelled.v1'), k = f.w.events('engagement.booking.confirmed.v1'); expect(c).toHaveLength(1); expect(k).toHaveLength(1);
    expect(c[0]).toMatchObject({ idempotency_key: `${old['id']}:cancelled`, payload: { booking_id: old['id'], patient_id: X, cancelled_by_kind: 'patient', slot_start: S('02:15') } }); expect(k[0].payload.booking_id).toBe(r.out.body.id);
    for (const e of [...c, ...k]) expect(eventValidators().get(e.event_type)!(e)).toBe(true);
  });
  it('ATOMIC: when the new slot is full nothing changes - old booking, occupancy rows, counters, items and events are all as before; 409 engagement.slot_unavailable', async () => {
    const f = setup(); const old = f.mine({ slot_start: S('02:15') }); const before = f.w.snapshot(); const r = await resched(f, old, { slot_start: SLOT_FULL });
    expectErr(r, 'engagement.slot_unavailable', 409); expect(f.w.snapshot()).toBe(before); expect(f.w.row('bookings', old['id'])).toMatchObject({ status: 'confirmed', version: 1 }); expect(f.w.events()).toHaveLength(0);
  });
  it('ATOMIC: a new slot outside the window, an orderable that is not bookable, or a refused profile also leave the old booking untouched', async () => {
    const f = setup(); const old = f.mine({ slot_start: S('02:15') }); const before = f.w.snapshot();
    expectErr(await resched(f, old, { slot_start: '2026-11-09T01:15:00.000Z' }), 'engagement.slot_outside_window', 422); expect(f.w.snapshot()).toBe(before);
    expectErr(await resched(f, old, { orderable_ids: [O.OFF] }), 'engagement.orderable_not_bookable', 422); expect(f.w.snapshot()).toBe(before);
    expectErr(await resched(f, old, { profile_id: f.ly['id'] }), 'common.not_found', 404); expect(f.w.snapshot()).toBe(before);
  });
  it('the replaced booking does not count against the active limit: a profile at the cap (2) can reschedule one of them', async () => {
    const f = setup(); const old = f.mine({ slot_start: S('02:15') }); f.mine({ slot_start: S('03:00') }); const r = await resched(f, old); expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201);
    expect(f.w.t['bookings']!.filter((b) => b['status'] === 'confirmed' && b['link_id'] === f.lx['id'])).toHaveLength(2);
  });
  it('a stale replaces_booking_version -> 409 common.version_conflict; a missing one is refused (400 / 428); nothing changes either way', async () => {
    const f = setup(); const old = f.mine({ slot_start: S('02:15') }); const before = f.w.snapshot();
    const stale = await resched(f, old, { replaces_booking_version: 7 }); expectErr(stale, 'common.version_conflict', 409); expect(f.w.snapshot()).toBe(before);
    const none = await f.create({ slot_start: SLOT_2, replaces_booking_id: old['id'] }); expect(['common.validation_failed', 'common.precondition_required']).toContain(code(none)); expect(f.w.snapshot()).toBe(before);
  });
  it('within the cancel cutoff (booking in 30 min) -> 409 engagement.booking_not_cancellable, nothing changes', async () => {
    const f = setup(); const old = f.mine({ slot_start: SLOT_NEAR }); const before = f.w.snapshot(); const r = await resched(f, old); expectErr(r, 'engagement.booking_not_cancellable', 409); expect(f.w.snapshot()).toBe(before);
  });
  it('an old booking that is already cancelled, checked in or completed cannot be rescheduled (409); another account\'s booking, a staff booking and an unknown id are 404', async () => {
    const f = setup(); const before = (): string => f.w.snapshot();
    for (const st of [{ status: 'cancelled', cancelled_at: NOW, cancel_reason_code: 'patient_request', cancelled_by_kind: 'patient' }, { status: 'checked_in', checked_in_at: NOW }, { status: 'completed', completed_at: NOW }]) {
      const old = f.mine({ slot_start: S('03:30'), ...st }); const snap = before(); const r = await resched(f, old); expect(['engagement.booking_not_cancellable', 'engagement.booking_invalid_transition']).toContain(code(r)); expect(r.error?.statusCode).toBe(409); expect(f.w.snapshot()).toBe(snap);
    }
    const theirOcc = f.w.seedOccupancy(S('03:45'), 1); const theirs = f.w.seedBooking(f.a2, f.ly, Y, { slot_start: S('03:45'), slot_end: S('04:00'), slot_occupancy_id: theirOcc['id'], created_at: OLD });
    const staffOcc = f.w.seedOccupancy(S('04:00'), 1); const staff = f.w.seedBooking(null, null, X, { slot_start: S('04:00'), slot_end: S('04:15'), slot_occupancy_id: staffOcc['id'], created_at: OLD });
    for (const id of [theirs['id'], staff['id'], ID(0x8fc)]) { const snap = before(); const r = await f.create({ slot_start: SLOT_2, replaces_booking_id: id, replaces_booking_version: 1 }); expectErr(r, 'common.not_found', 404); expect(f.w.snapshot()).toBe(snap); }
  });
  it('replaying the SAME reschedule after it succeeded never cancels twice and never creates a third booking (the old one is no longer cancellable)', async () => {
    const f = setup(); const old = f.mine({ slot_start: S('02:15') }); expect((await resched(f, old)).out.status).toBe(201);
    const again = await f.create({ slot_start: SLOT_2, replaces_booking_id: old['id'], replaces_booking_version: 1 }); expect(again.out).toBeUndefined(); expect(f.w.events('engagement.booking.cancelled.v1')).toHaveLength(1); expect(f.w.t['bookings']).toHaveLength(2);
  });
});

// ================================================================== E34 / E35
describe('E34 listMyBookings / E35 getMyBooking (own account only; PAT_ACC, AB-6)', () => {
  it('E34 lists only the caller\'s bookings, newest slot first; DTO schema-valid with profile_id = link id and no patient_id; staff, other-account and tenant-B bookings are invisible', async () => {
    const f = setup(); const b1 = f.mine({ slot_start: S('02:15') }), b2 = f.mine({ slot_start: S('03:00') }, f.lx2), b3 = f.mine({ slot_start: S('04:00'), status: 'cancelled', cancelled_at: NOW, cancel_reason_code: 'patient_request', cancelled_by_kind: 'patient' });
    const so = f.w.seedOccupancy(S('04:30'), 1); f.w.seedBooking(null, null, X, { slot_start: S('04:30'), slot_end: S('04:45'), slot_occupancy_id: so['id'] }); const to = f.w.seedOccupancy(S('04:45'), 1); f.w.seedBooking(f.a2, f.ly, Y, { slot_start: S('04:45'), slot_end: S('05:00'), slot_occupancy_id: to['id'] });
    const r = await f.run('listMyBookings', {}); expect(r.out.status).toBe(200); expect(r.out.body.data.map((d: any) => d.id)).toEqual([b3['id'], b2['id'], b1['id']]);
    for (const d of r.out.body.data) { expect(schemaErrors('Booking', d)).toEqual([]); expect(d).not.toHaveProperty('patient_id'); } expect(r.out.body.data[1].profile_id).toBe(f.lx2['id']); expect(String(hdr(r.out, 'cache-control'))).toMatch(/no-store/i);
    expect((await f.run('listMyBookings', {}, f.a2)).out.body.data).toHaveLength(1);
  });
  it('status filter, limit and cursor page the list; invalid status / limit are 400', async () => {
    const f = setup(); for (const s of ['02:15', '03:00', '03:15']) f.mine({ slot_start: S(s) }); f.mine({ slot_start: S('03:30'), status: 'cancelled', cancelled_at: NOW, cancel_reason_code: 'patient_request', cancelled_by_kind: 'patient' });
    expect((await f.run('listMyBookings', { query: { status: 'cancelled' } })).out.body.data).toHaveLength(1);
    const p1 = (await f.run('listMyBookings', { query: { limit: 3 } })).out.body; expect(p1.data).toHaveLength(3); const p2 = (await f.run('listMyBookings', { query: { limit: 3, cursor: p1.page.next_cursor } })).out.body;
    expect(p2.data).toHaveLength(1); expect(p1.data.map((d: any) => d.id)).not.toContain(p2.data[0].id);
    expectErr(await f.run('listMyBookings', { query: { status: 'teleported' } }), 'common.validation_failed', 400); expectErr(await f.run('listMyBookings', { query: { limit: 0 } }), 'common.validation_failed', 400);
  });
  it('E35 returns own booking with cancellable_until = slot_start - cutoff for a confirmed one and none for cancelled / completed; foreign, staff, tenant-B and unknown ids are 404; a non-uuid is 400', async () => {
    const f = setup(); const b = f.mine({ slot_start: S('02:15') }); const c = f.mine({ slot_start: S('03:00'), status: 'cancelled', cancelled_at: NOW, cancel_reason_code: 'patient_request', cancelled_by_kind: 'patient' });
    const r = await f.run('getMyBooking', { params: { booking_id: b['id'] } }); expect(r.out.status).toBe(200); expect(schemaErrors('Booking', r.out.body)).toEqual([]); expect(r.out.body).toMatchObject({ id: b['id'], profile_id: f.lx['id'], cancellable_until: plus(S('02:15'), -60), version: 1 });
    const rc = await f.run('getMyBooking', { params: { booking_id: c['id'] } }); expect(rc.out.body).toMatchObject({ status: 'cancelled', cancel_reason_code: 'patient_request' }); expect(rc.out.body.cancellable_until).toBeUndefined();
    const so = f.w.seedOccupancy(S('04:30'), 1); const staff = f.w.seedBooking(null, null, X, { slot_start: S('04:30'), slot_end: S('04:45'), slot_occupancy_id: so['id'] });
    const bo = f.w.seedOccupancy(S('04:45'), 1); const tb = f.w.seedBooking(f.a2, f.ly, Y, { slot_start: S('04:45'), slot_end: S('05:00'), slot_occupancy_id: bo['id'] });
    for (const id of [tb['id'], staff['id'], ID(0x8fb)]) expectErr(await f.run('getMyBooking', { params: { booking_id: id } }), 'common.not_found', 404);
    expectErr(await f.run('getMyBooking', { params: { booking_id: 'BK26000901' } }), 'common.validation_failed', 400); // booking numbers never go in paths (REQ-SEC-098)
  });
  it('another tenant\'s booking is 404 and never listed', async () => {
    const f = setup(); const ob = f.w.seedOccupancy(S('04:45'), 1); const x = f.w.seedBooking(f.a1, f.lx, X, { tenant_id: B, slot_start: S('04:45'), slot_end: S('05:00'), slot_occupancy_id: ob['id'] });
    expectErr(await f.run('getMyBooking', { params: { booking_id: x['id'] } }), 'common.not_found', 404); expect((await f.run('listMyBookings', {})).out.body.data).toEqual([]);
  });
});

// ================================================================== E36 cancel
describe('E36 cancelMyBooking (US-EN-14.1 / 14.2; B-3)', () => {
  const cancel = (f: Fx, id: string, headers: object = ifm(1), who = f.a1) => f.run('cancelMyBooking', { params: { booking_id: id }, headers: { ...IDEM, ...headers } }, who);
  it('more than the cutoff before start: 200 Booking cancelled (reason patient_request, by patient), version + 1, occupancy - 1, transition, cancelled event, cancel SMS job', async () => {
    const f = setup(); const b = f.mine({ slot_start: S('02:15') }); const oc = f.w.row('slot_occupancy', b['slot_occupancy_id'])!; const r = await cancel(f, b['id']);
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200); expect(schemaErrors('Booking', r.out.body)).toEqual([]); expect(r.out.body).toMatchObject({ status: 'cancelled', cancel_reason_code: 'patient_request', version: 2 }); expect(r.out.body.cancellable_until).toBeUndefined();
    expect(f.w.row('bookings', b['id'])).toMatchObject({ status: 'cancelled', cancelled_by_kind: 'patient', cancel_reason_code: 'patient_request', version: 2, updated_by: f.a1['user_id'] }); expect(oc['booked']).toBe(0);
    expect(f.w.t['booking_transitions']!.filter((t) => t['booking_id'] === b['id'] && t['to_status'] === 'cancelled')).toEqual([expect.objectContaining({ from_status: 'confirmed', reason_code: 'patient_request', actor_type: 'patient', actor_id: f.a1['user_id'] })]);
    const ev = f.w.events('engagement.booking.cancelled.v1'); expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ idempotency_key: `${b['id']}:cancelled`, actor: { type: 'patient' }, aggregate: { type: 'booking', id: b['id'], seq: 2 } });
    expect(ev[0].payload).toEqual({ booking_id: b['id'], patient_id: X, booking_kind: 'centre_visit', reason_code: 'patient_request', cancelled_by_kind: 'patient', slot_start: S('02:15'), cancelled_at: NOW });
    expect(eventValidators().get('engagement.booking.cancelled.v1')!(ev[0])).toBe(true); expect(f.w.jobs(r.calls, 'engagement.send_booking_message')[0]!.values[2]).toBe(`bmsg:${b['id']}:cancelled`);
  });
  it('less than the cutoff (slot in 30 min) -> 409 engagement.booking_not_cancellable and nothing changes', async () => {
    const f = setup(); const b = f.mine({ slot_start: SLOT_NEAR }); const before = f.w.snapshot(); const r = await cancel(f, b['id']); expectErr(r, 'engagement.booking_not_cancellable', 409); untouched(f, r, before);
  });
  it('If-Match is required (absent -> 428 before ANY DB access; malformed -> 400), a stale version -> 409 common.version_conflict, nothing written', async () => {
    const f = setup(); const b = f.mine({ slot_start: S('02:15') }); const before = f.w.snapshot();
    const none = await f.run('cancelMyBooking', { params: { booking_id: b['id'] }, headers: IDEM }); expectErr(none, 'common.precondition_required', 428); expect(none.calls).toHaveLength(0);
    expectErr(await cancel(f, b['id'], ifm('banana')), 'common.validation_failed', 400); const stale = await cancel(f, b['id'], ifm(9)); expectErr(stale, 'common.version_conflict', 409); untouched(f, stale, before);
  });
  it('forbidden transitions: checked_in (patient cannot cancel), completed and cancelled -> 409 engagement.booking_invalid_transition, no event', async () => {
    const f = setup(); for (const st of [{ status: 'checked_in', checked_in_at: NOW }, { status: 'completed', completed_at: NOW }, { status: 'cancelled', cancelled_at: NOW, cancel_reason_code: 'patient_request', cancelled_by_kind: 'staff' }]) {
      const b = f.mine({ slot_start: S('03:00'), ...st }); const before = f.w.snapshot(); const r = await cancel(f, b['id']); expectErr(r, 'engagement.booking_invalid_transition', 409); untouched(f, r, before);
    }
    expect(f.w.events()).toHaveLength(0);
  });
  it('probes (AB-6 / P-L1): another account\'s booking, a staff booking of the same patient, a tenant-B booking and an unknown id are 404 BEFORE state or version; nothing changes', async () => {
    const f = setup(); const to = f.w.seedOccupancy(S('04:45'), 1); const theirs = f.w.seedBooking(f.a2, f.ly, Y, { slot_start: S('04:45'), slot_end: S('05:00'), slot_occupancy_id: to['id'] });
    const so = f.w.seedOccupancy(S('04:30'), 1); const staff = f.w.seedBooking(null, null, X, { slot_start: S('04:30'), slot_end: S('04:45'), slot_occupancy_id: so['id'] }); const before = f.w.snapshot();
    for (const id of [theirs['id'], staff['id'], ID(0x8fa)]) { const r = await cancel(f, id, ifm(99)); expectErr(r, 'common.not_found', 404); untouched(f, r, before); }
    expectErr(await cancel(f, 'not-a-uuid'), 'common.validation_failed', 400);
  });
  it('a second cancel of the same booking -> 409 engagement.booking_invalid_transition and ONE event overall; occupancy is released exactly once', async () => {
    const f = setup(); const b = f.mine({ slot_start: S('02:15'), }, f.lx, 2); expect((await cancel(f, b['id'])).out.status).toBe(200); expectErr(await cancel(f, b['id'], ifm(2)), 'engagement.booking_invalid_transition', 409);
    expect(f.w.events('engagement.booking.cancelled.v1')).toHaveLength(1); expect(f.w.row('slot_occupancy', b['slot_occupancy_id'])!['booked']).toBe(1);
  });
  it('after the cancel the place is bookable again (US-EN-14.1 occupancy - 1)', async () => {
    const f = setup(); const full = f.w.row('slot_occupancy', ID(0x602))!; full['booked'] = 3;
    const mine = f.w.seedBooking(f.a1, f.lx, X, { slot_start: SLOT_ONE, slot_end: plus(SLOT_ONE, 15), slot_occupancy_id: ID(0x602), created_at: OLD, version: 1 }); expect((await cancel(f, mine['id'])).out.status).toBe(200); expect(full['booked']).toBe(2);
    expect((await f.create({ profile_id: f.ly['id'], slot_start: SLOT_ONE }, f.a2)).out.status).toBe(201);
  });
});
