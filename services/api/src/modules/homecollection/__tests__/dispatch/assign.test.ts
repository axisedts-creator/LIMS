// HC-T09 / H3 assignHomeVisit (02-TRD §5.1 H3, §4.1; PRD US-03-1, -3 … -10; 08 A19 D-131, P-44; security 07 §4/§5). Runs the handler over a real PG17 tx with a FrontdeskPort fake (see helpers.ts).
// Fails now: H3 is the HC-T01 stub (`LIMS_CORE_ENV` stub -> 501 / common.internal), so every call below rejects or returns no 200 body.
// Dates: this file owns 2027-04-01 .. 2027-06-30 (routes are unique per centre + phlebotomist + date; files run in parallel on one DB).
import { beforeAll, describe, expect, it } from 'vitest';
import { DISPATCHER, DISPATCHER_B, HC_CENTRE, MEMBER, MEMBER2, NOBODY, NOT_ELIGIBLE, OTHER_CENTRE, P, PHLEBO, T, TENANT_B, addActiveVisits, assign, assignedVisit, assignmentsOf, bookingVisit, cancel, day, dop,
  failure, frontDeskVisit, hasPointer, key, newOrder, q, req, responseErrors, routeFor, routeRow, routesOf, sameInstant, schedule, seedWorld, staffName, superTx, transitionsOf, uid,
  unassign, viaPipeline, visitRow, winOf, worldOf, type DFx } from './helpers.js';
import { listPhlebos } from '../visits/helpers.js';

const BASE = '2027-04-01';
let n = 0;
const D = (): string => day(BASE, n++);
let W: Awaited<ReturnType<typeof worldOf>>;
beforeAll(async () => { W = await worldOf('a'); }, T);

const body = (member: string, date: string, seq?: number) => ({ phlebotomist_membership_id: member, route_date: date, ...(seq === undefined ? {} : { route_sequence: seq }) });
/** a complete (window + address) unassigned booking visit + the order the port will create for it */
async function ready(date: string, o: Record<string, unknown> = {}) { const v = await bookingVisit(o, 'a', date); const order = await newOrder(); return { v, order, fx: { orderId: order.id } as DFx }; }
const unchanged = async (v: any, route?: any) => {
  const row = await visitRow(v.id);
  expect(row).toMatchObject({ status: 'unassigned', version: v.version, order_id: v.order_id ?? null, route_id: null, assigned_membership_id: null });
  expect(await assignmentsOf(v.id)).toEqual([]);
  if (route) expect((await routeRow(route.id)).version).toBe(route.version ?? 1);
};

describe('US-03-3 assign a scheduled booking visit: ONE transaction = order via FrontdeskPort + order_id + status + assignment row + route + version bump', () => {
  it('calls createOrderFromBooking once with the exact BookingOrderInput and stores what C4 returned', { timeout: T }, async () => {
    const date = D(); const route = await routeFor(MEMBER.a, date); const { v, order, fx } = await ready(date);
    const before = (await routeRow(route.id)).version;
    const r = await assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx });
    expect(r.status).toBe(200);
    expect(responseErrors('assignHomeVisit', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: v.id, status: 'assigned', order_id: order.id, route_id: route.id, route_date: date, route_sequence: 1,
      phlebotomist: { membership_id: MEMBER.a, display_name: staffName(MEMBER.a) } });
    expect(r.body.version).toBeGreaterThan(v.version);
    expect(r.probe.createOrder).toHaveLength(1);
    const { input, sameTx } = r.probe.createOrder[0]!;
    expect(sameTx, 'the port must be called with the request transaction (atomic with the visit write)').toBe(true);
    expect(input).toMatchObject({ source: 'home_collection', sourceRefId: v.id, patient: { patientId: v.patient_id }, orderableIds: v.orderable_ids, branchId: v.branch_id, centreId: v.centre_id,
      priority: 'routine', confirmImmediately: true, idempotencyKey: `${v.id}:order` });
    expect(sameInstant(input.scheduledAt, v.window_start), 'scheduledAt = window_start').toBe(true);
    expect(input.referrerId, 'no referrer on this visit -> no referrerId key').toBeUndefined();
    expect(input.idempotencyKey).toMatch(/^[A-Za-z0-9_.:-]{1,200}$/);                           // 08 A19 P-40 port-key grammar
    const row = await visitRow(v.id);
    expect(row).toMatchObject({ status: 'assigned', order_id: order.id, route_id: route.id, route_date: date, route_sequence: 1, assigned_membership_id: MEMBER.a, version: r.body.version });
    expect(await assignmentsOf(v.id)).toEqual([expect.objectContaining({ action: 'assign', membership_id: MEMBER.a, route_id: route.id, route_date: date })]);
    expect((await transitionsOf(v.id)).some((t) => t.to_status === 'assigned' && t.cause === 'dispatcher')).toBe(true);
    expect((await routeRow(route.id)).version, 'route version +1 in the same transaction (TRD §4.1)').toBe(before + 1);
  });

  it('creates the route (centre, phlebotomist, date) when it does not exist yet', { timeout: T }, async () => {
    const date = D(); const { v, fx } = await ready(date);
    expect(await routesOf(MEMBER.a, date)).toEqual([]);
    const r = await assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx });
    expect(r.status).toBe(200);
    const routes = await routesOf(MEMBER.a, date);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ centre_id: v.centre_id, route_date: date });
    expect(r.body.route_id).toBe(routes[0].id);
    expect((await visitRow(v.id)).route_id).toBe(routes[0].id);
  });

  it('an assigned visit takes the next sequence on its route (1, 2, 3) unless route_sequence is given', { timeout: T }, async () => {
    const date = D(); const route = await routeFor(MEMBER.a, date);
    for (const expected of [1, 2, 3]) {
      const { v, fx } = await ready(date);
      const r = await assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx });
      expect(r.body.route_sequence).toBe(expected);
    }
    expect((await routeRow(route.id)).version).toBe(1 + 3);
  });

  it('a front-desk visit already has its order: the port is NOT called, order_id stays, the rest is identical', { timeout: T }, async () => {
    const date = D(); const route = await routeFor(MEMBER.a, date); const v = await frontDeskVisit({}, 'a', date);
    const r = await assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date) });
    expect(r.status).toBe(200);
    expect(r.probe.createOrder).toHaveLength(0);
    expect(r.body).toMatchObject({ status: 'assigned', order_id: v.order_id, route_id: route.id });
    expect((await visitRow(v.id)).order_id).toBe(v.order_id);
  });
});

describe('US-03-1 incomplete visit: no address or no window -> 422 homecollection.visit_incomplete, nothing written, no order created', () => {
  it.each([
    ['no window', { window_start: null, window_end: null }],
    ['no address', { address_text: null }],
    ['neither', { window_start: null, window_end: null, address_text: null }],
  ])('%s', { timeout: T }, async (_n, o) => {
    const date = D(); const { v, fx } = await ready(date, o);
    const e = await failure(assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx }));
    expect(e.code).toBe('homecollection.visit_incomplete');
    expect(e.statusCode).toBe(422);
    expect(e.probe.createOrder).toHaveLength(0);
    await unchanged(v);
    expect(await routesOf(MEMBER.a, date)).toEqual([]);
  });
  it('a front-desk visit without a window is incomplete too (the board has to schedule it first)', { timeout: T }, async () => {
    const date = D(); const v = await frontDeskVisit({ window_start: null, window_end: null }, 'a', date);
    const e = await failure(assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date) }));
    expect(e.code).toBe('homecollection.visit_incomplete');
  });
});

describe('US-03-4 a port error fails the assign with that error and NOTHING is written', () => {
  it.each(['catalog.test_inactive', 'catalog.no_price', 'frontdesk.consent_required', 'auth.forbidden', 'frontdesk.booking_already_converted', 'frontdesk.patient_duplicate_suspected'])('%s', { timeout: T }, async (code) => {
    const date = D(); const { v } = await ready(date);
    const e = await failure(assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx: { orderError: code } }));
    expect(e.code).toBe(code);
    expect(e.probe.createOrder).toHaveLength(1);
    await unchanged(v);
    expect(await routesOf(MEMBER.a, date), 'a route created for a failed assign must roll back too').toEqual([]);
    expect((await transitionsOf(v.id)).some((t) => t.to_status === 'assigned')).toBe(false);
  });
});

describe('US-03-5 retry and replay: one order, the same order_id', () => {
  it('C4 answers replayed:true -> the same order_id is stored, the assign succeeds', { timeout: T }, async () => {
    const date = D(); const { v, order } = await ready(date);
    const r = await assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx: { orderId: order.id, replayed: true } });
    expect(r.status).toBe(200);
    expect(r.body.order_id).toBe(order.id);
    expect((await visitRow(v.id)).order_id).toBe(order.id);
    expect(r.probe.createOrder[0]!.input.idempotencyKey).toBe(`${v.id}:order`);                   // the same key on every attempt = C4 replays instead of creating a second order
  });
  it('same Idempotency-Key through the pipeline: the stored response is replayed (Idempotent-Replayed: true) and the port is not called again', { timeout: T }, async () => {
    const date = D(); const { v, order, fx } = await ready(date); const idem = key();
    const a = { visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx, idem, routeTemplate: '/v1/homecollection/visits/{visit_id}/assign' };
    const first = await viaPipeline('assignHomeVisit', a);
    expect(first).toMatchObject({ replay: false, status: 200 });
    expect(first.probe!.createOrder).toHaveLength(1);
    const second = await viaPipeline('assignHomeVisit', a);
    expect(second).toMatchObject({ replay: true, status: 200 });
    expect((second as any).headers['Idempotent-Replayed']).toBe('true');
    expect(second.body).toEqual(JSON.parse(JSON.stringify(first.body)));
    expect(await assignmentsOf(v.id)).toHaveLength(1);
    expect((await visitRow(v.id)).order_id).toBe(order.id);
  });
  it('the same request WITHOUT the pipeline (stale If-Match) is a 409 common.version_conflict before any side effect: never a second order, never a second assignment', { timeout: T }, async () => {
    const date = D(); const { v, fx } = await ready(date);
    await assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx });
    const e = await failure(assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx }));
    expect(e.code).toBe('common.version_conflict');
    expect(e.probe.createOrder).toHaveLength(0);
    expect(await assignmentsOf(v.id)).toHaveLength(1);
  });
});

// 03-APP-FLOW V5, 02-TRD §8 line 484 + §9 job row: assign enqueues homecollection.refresh_visit_specimens (job_key refresh:<visit_id>) in the same tx; a rolled-back assign leaves no job.
const refreshJobs = (visitId: string) => q("SELECT task_identifier, key FROM graphile_worker.jobs WHERE task_identifier = 'homecollection.refresh_visit_specimens' AND key = $1", [`refresh:${visitId}`]);
describe('V5 assign enqueues the specimen refresh job (same transaction as the assign)', () => {
  it('a successful assign (new order): exactly one job with job_key refresh:<visit_id>', { timeout: T }, async () => {
    const date = D(); const { v, fx } = await ready(date);
    expect(await refreshJobs(v.id)).toEqual([]);
    const r = await assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx });
    expect(r.status).toBe(200);
    expect(await refreshJobs(v.id)).toEqual([{ task_identifier: 'homecollection.refresh_visit_specimens', key: `refresh:${v.id}` }]);
  });
  it('a front-desk visit (existing order) and a reassign enqueue it too; the job_key keeps it to one row per visit', { timeout: T }, async () => {
    const date = D(); await routeFor(MEMBER.a, date); const v = await frontDeskVisit({}, 'a', date);
    expect((await assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date) })).status).toBe(200);
    expect(await refreshJobs(v.id)).toHaveLength(1);
    const cur = await visitRow(v.id);
    expect((await assign({ visitId: v.id, version: cur.version, body: body(MEMBER2.a, date) })).status).toBe(200);
    expect(await refreshJobs(v.id)).toHaveLength(1);
  });
  it('a failed assign (port throws) leaves no job', { timeout: T }, async () => {
    const date = D(); const { v } = await ready(date);
    const e = await failure(assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx: { orderError: 'catalog.no_price' } }));
    expect(e.code).toBe('catalog.no_price');
    expect(await refreshJobs(v.id)).toEqual([]);
  });
});

describe('US-03-6 eligibility: inactive, not in the visit centre, or no phlebotomist role -> 422 homecollection.phlebotomist_not_eligible', () => {
  it.each([
    ['inactive membership', NOT_ELIGIBLE.inactive],
    ['no role phlebotomist (front desk)', NOT_ELIGIBLE.noRole],
    ['membership of another centre only', NOT_ELIGIBLE.otherCentre],
    ['unknown membership id', uid()],
    ['the dispatcher themself (no phlebotomist role)', DISPATCHER.membershipId],
  ])('%s', { timeout: T }, async (_n, member) => {
    const date = D(); const { v, fx } = await ready(date);
    const e = await failure(assign({ visitId: v.id, version: v.version, body: body(member as string, date), fx }));
    expect(e.code).toBe('homecollection.phlebotomist_not_eligible');
    expect(e.statusCode).toBe(422);
    expect(e.probe.createOrder, 'eligibility is checked before the order is created').toHaveLength(0);
    await unchanged(v);
    expect(await routesOf(member as string, date)).toEqual([]);
  });
});

describe('US-03-7 reassign: new assignment row, BOTH routes bump, order unchanged, no second port call', () => {
  it('another phlebotomist, same date', { timeout: T }, async () => {
    const date = D(); const { visit, route } = await assignedVisit({ member: MEMBER.a, date }); const route2 = await routeFor(MEMBER2.a, date);
    const [b1, b2] = [(await routeRow(route.id)).version, (await routeRow(route2.id)).version];
    const r = await assign({ visitId: visit.id, version: visit.version, body: body(MEMBER2.a, date) });
    expect(r.status).toBe(200);
    expect(r.probe.createOrder).toHaveLength(0);
    expect(r.body).toMatchObject({ status: 'assigned', order_id: visit.order_id, route_id: route2.id, phlebotomist: { membership_id: MEMBER2.a } });
    const rows = await assignmentsOf(visit.id);
    expect(rows.at(-1)).toMatchObject({ action: 'reassign', membership_id: MEMBER2.a, route_id: route2.id, route_date: date });
    expect((await routeRow(route.id)).version).toBe(b1 + 1);
    expect((await routeRow(route2.id)).version).toBe(b2 + 1);
    expect((await visitRow(visit.id)).order_id).toBe(visit.order_id);
  });
  it('same phlebotomist, another date', { timeout: T }, async () => {
    const d1 = D(), d2 = D(); const { visit, route } = await assignedVisit({ member: MEMBER.a, date: d1 }); const route2 = await routeFor(MEMBER.a, d2);
    const [b1, b2] = [(await routeRow(route.id)).version, (await routeRow(route2.id)).version];
    const r = await assign({ visitId: visit.id, version: visit.version, body: body(MEMBER.a, d2) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ route_id: route2.id, route_date: d2 });
    expect((await assignmentsOf(visit.id)).at(-1)).toMatchObject({ action: 'reassign', route_id: route2.id, route_date: d2 });
    expect((await routeRow(route.id)).version).toBe(b1 + 1);
    expect((await routeRow(route2.id)).version).toBe(b2 + 1);
  });
  it('an ineligible target leaves the visit on its old route (no bump, no new row)', { timeout: T }, async () => {
    const date = D(); const { visit, route } = await assignedVisit({ member: MEMBER.a, date });
    const e = await failure(assign({ visitId: visit.id, version: visit.version, body: body(NOT_ELIGIBLE.noRole, date) }));
    expect(e.code).toBe('homecollection.phlebotomist_not_eligible');
    expect(await assignmentsOf(visit.id)).toEqual([]);                                       // seeded straight into `assigned`: no history row was written by the failed call
    expect(await visitRow(visit.id)).toMatchObject({ route_id: route.id, assigned_membership_id: MEMBER.a, version: visit.version });
    expect((await routeRow(route.id)).version).toBe(1);
  });
});

describe('US-03-8 route cap max_visits_per_route (default 40): 400 common.validation_failed, pointer /phlebotomist_membership_id', () => {
  it('39 active (+1 completed, which does not count) accepts the 40th; the 41st is refused with nothing written', { timeout: 120_000 }, async () => {
    const date = D(); const route = await routeFor(MEMBER.a, date);
    await assignedVisit({ member: MEMBER.a, date, route, seq: 40, status: 'completed' });
    await addActiveVisits('a', W, { n: 39, member: MEMBER.a, routeId: route.id, centreId: HC_CENTRE.a, date });
    const ok = await ready(date);
    expect((await assign({ visitId: ok.v.id, version: ok.v.version, body: body(MEMBER.a, date), fx: ok.fx })).status).toBe(200);
    const over = await ready(date); const before = (await routeRow(route.id)).version;
    const e = await failure(assign({ visitId: over.v.id, version: over.v.version, body: body(MEMBER.a, date), fx: over.fx }));
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect(hasPointer(e, '/phlebotomist_membership_id'), JSON.stringify(e.errors)).toBe(true);
    expect(e.probe.createOrder).toHaveLength(0);
    await unchanged(over.v);
    expect((await routeRow(route.id)).version).toBe(before);
  });
  it('two racing assigns of different visits at 39 active: at most the cap is reached (one 200, one 400), never 41', { timeout: 120_000 }, async () => {
    const date = D(); const route = await routeFor(MEMBER.a, date);
    await addActiveVisits('a', W, { n: 39, member: MEMBER.a, routeId: route.id, centreId: HC_CENTRE.a, date });
    const [x, y] = [await ready(date), await ready(date)];
    const res = await Promise.allSettled([x, y].map((z) => assign({ visitId: z.v.id, version: z.v.version, body: body(MEMBER.a, date), fx: z.fx })));
    expect(res.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('common.validation_failed');
    expect((await q("SELECT count(*)::int AS c FROM homecollection.visits WHERE route_id = $1 AND status IN ('assigned','in_progress')", [route.id]))[0].c).toBe(40);
  });
});

describe('US-03-10 / D-131 daily cap: 60 active visits of one phlebotomist on one route_date across ALL routes', () => {
  it('59 -> the 60th is accepted; 60 -> any further assign (any of their routes) is a 400 with pointer /phlebotomist_membership_id, and H12 shows route_full: true', { timeout: 180_000 }, async () => {
    const date = D(); const rHc = await routeFor(MEMBER2.a, date); const rOther = await routeFor(MEMBER2.a, date, OTHER_CENTRE.a);
    await addActiveVisits('a', W, { n: 30, member: MEMBER2.a, routeId: rHc.id, centreId: HC_CENTRE.a, date });
    await addActiveVisits('a', W, { n: 29, member: MEMBER2.a, routeId: rOther.id, centreId: OTHER_CENTRE.a, date });
    const at59 = await listPhlebos({ centre_id: HC_CENTRE.a, route_date: date });
    expect(at59.body.data.find((x: any) => x.membership_id === MEMBER2.a).route_full).toBe(false);
    const sixtieth = await ready(date);
    const ok = await assign({ visitId: sixtieth.v.id, version: sixtieth.v.version, body: body(MEMBER2.a, date), fx: sixtieth.fx });
    expect(ok.status).toBe(200);
    const extra = await ready(date);
    const e = await failure(assign({ visitId: extra.v.id, version: extra.v.version, body: body(MEMBER2.a, date), fx: extra.fx }));
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect(hasPointer(e, '/phlebotomist_membership_id'), JSON.stringify(e.errors)).toBe(true);
    expect(e.probe.createOrder).toHaveLength(0);
    await unchanged(extra.v);
    const at60 = await listPhlebos({ centre_id: HC_CENTRE.a, route_date: date });
    expect(at60.body.data.find((x: any) => x.membership_id === MEMBER2.a).route_full).toBe(true);
    expect(at60.body.data.find((x: any) => x.membership_id === MEMBER.a).route_full, "someone else's load does not count").toBe(false);
  });
  it('a REASSIGN into a phlebotomist who is at 60 is refused as well (the cap counts the target, not the visit origin)', { timeout: 180_000 }, async () => {
    const date = D(); const rHc = await routeFor(MEMBER2.a, date); const rOther = await routeFor(MEMBER2.a, date, OTHER_CENTRE.a);
    await addActiveVisits('a', W, { n: 30, member: MEMBER2.a, routeId: rHc.id, centreId: HC_CENTRE.a, date });
    await addActiveVisits('a', W, { n: 30, member: MEMBER2.a, routeId: rOther.id, centreId: OTHER_CENTRE.a, date });
    const { visit } = await assignedVisit({ member: MEMBER.a, date });
    const e = await failure(assign({ visitId: visit.id, version: visit.version, body: body(MEMBER2.a, date) }));
    expect(e.code).toBe('common.validation_failed');
    expect(hasPointer(e, '/phlebotomist_membership_id')).toBe(true);
    expect((await visitRow(visit.id)).assigned_membership_id).toBe(MEMBER.a);
  });
});

describe('US-03-9 closed visits: completed / failed / cancelled + ANY dispatcher action -> 409 homecollection.visit_closed', () => {
  const OPS: Array<[string, (v: any, date: string) => Promise<unknown>]> = [
    ['H3 assign', (v, date) => assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx: {} })],
    ['H4 unassign', (v) => unassign({ visitId: v.id, version: v.version, body: { reason_code: 'reschedule' } })],
    ['H5 schedule', (v, date) => schedule({ visitId: v.id, version: v.version, body: { ...winOf(date, 8) } })],
    ['H6 cancel', (v) => cancel({ visitId: v.id, version: v.version, body: { reason_code: 'patient_request' } })],
  ];
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    for (const [name, call] of OPS) {
      it(`${status} + ${name}`, { timeout: T }, async () => {
        const date = D(); const { visit } = await assignedVisit({ date, status });
        const e = await failure(call(visit, date));
        expect(e.code).toBe('homecollection.visit_closed');
        expect(e.statusCode).toBe(409);
        expect(e.probe.createOrder).toHaveLength(0);
        expect(await visitRow(visit.id)).toMatchObject({ status, version: visit.version });
      });
    }
  }
});

describe('concurrency: two assigns with the same If-Match version -> exactly one wins, the other is 409 common.version_conflict', () => {
  it('different target phlebotomists, same visit, same version', { timeout: T }, async () => {
    const date = D(); const { v, order } = await ready(date);
    const res = await Promise.allSettled([MEMBER.a, MEMBER2.a].map((m) => assign({ visitId: v.id, version: v.version, body: body(m, date), fx: { orderId: order.id } })));
    const won = res.filter((s) => s.status === 'fulfilled') as Array<PromiseFulfilledResult<any>>;
    const lost = res.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason.code).toBe('common.version_conflict');
    expect(lost[0]!.reason.statusCode).toBe(409);
    const winner = won[0]!.value.body.phlebotomist.membership_id;
    const row = await visitRow(v.id);
    expect(row).toMatchObject({ status: 'assigned', assigned_membership_id: winner, order_id: order.id });
    expect(await assignmentsOf(v.id)).toHaveLength(1);
    expect(await routesOf(winner === MEMBER.a ? MEMBER2.a : MEMBER.a, date), 'the loser leaves no route behind').toEqual([]);
  });
  it('the SAME request twice at once (same key, same version): one assignment, one order_id', { timeout: T }, async () => {
    const date = D(); const { v, order } = await ready(date);
    const res = await Promise.allSettled([0, 1].map(() => assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx: { orderId: order.id }, idem: 'same-key-both' })));
    expect(res.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(await assignmentsOf(v.id)).toHaveLength(1);
  });
});

describe('P-44: the assignment SMS is sent inside a savepoint (ctx.db.tx); a failure never fails the assign (tenant B: its settings row is flipped and restored here)', () => {
  const rosterB: DFx['roster'] = [{ membershipId: MEMBER.b, isActive: true, roleCodes: ['phlebotomist'], permissions: [P.read, P.sync], allCentres: true, centreIds: [] }];
  const setNotify = (on: boolean) => superTx(async (tx: any) => { await tx.query('UPDATE homecollection.settings SET notify_phlebotomist_on_assign = $2 WHERE tenant_id = $1', [TENANT_B, on]); }, TENANT_B);
  beforeAll(async () => { await seedWorld('b'); }, T);
  const readyB = async (date: string, sms?: DFx['sms']) => { const v = await bookingVisit({}, 'b', date); const order = await newOrder('b'); return { v, fx: { orderId: order.id, roster: rosterB, ...(sms ? { sms } : {}) } as DFx }; };
  const assignB = (z: { v: any; fx: DFx }, date: string) => assign({ visitId: z.v.id, version: z.v.version, body: body(MEMBER.b, date), fx: z.fx, who: DISPATCHER_B });

  it('notify_phlebotomist_on_assign = false (default): no SMS call at all', { timeout: T }, async () => {
    await setNotify(false);
    const date = D(); const z = await readyB(date);
    const r = await assignB(z, date);
    expect(r.status).toBe(200);
    expect(r.probe.sms).toHaveLength(0);
  });
  it('true: one sendSms with the spec input (staff recipient, purpose visit_assignment, template homecollection.visit_assigned, key <route_id>:<route_version>:assigned)', { timeout: T }, async () => {
    await setNotify(true);
    try {
      const date = D(); const z = await readyB(date, 'ok');
      const r = await assignB(z, date);
      expect(r.status).toBe(200);
      expect(r.probe.sms).toHaveLength(1);
      expect(r.probe.sms[0]).toMatchObject({ recipient: { kind: 'staff', membershipId: MEMBER.b }, purpose: 'visit_assignment', templateCode: 'homecollection.visit_assigned',
        params: { route_date: date, visit_count: 1 }, related: { entityType: 'visit', entityId: z.v.id } });
      expect(r.probe.sms[0].idempotencyKey).toMatch(new RegExp(`^${r.body.route_id}:[0-9]+:assigned$`));
      expect(r.probe.savepoints, 'sendSms runs inside ctx.db.tx(...)').toBeGreaterThanOrEqual(1);
    } finally { await setNotify(false); }
  });
  it.each(['throw', 'sql'] as const)('sendSms fails (%s): the assign is still 200 and committed (a failing SQL statement would poison the tx without the savepoint)', { timeout: T }, async (mode) => {
    await setNotify(true);
    try {
      const date = D(); const z = await readyB(date, mode);
      const r = await assignB(z, date);
      expect(r.status).toBe(200);
      expect(r.probe.sms).toHaveLength(1);
      expect(r.probe.savepoints).toBeGreaterThanOrEqual(1);
      expect(await visitRow(z.v.id, TENANT_B)).toMatchObject({ status: 'assigned', assigned_membership_id: MEMBER.b });
      expect((await assignmentsOf(z.v.id, TENANT_B))).toHaveLength(1);
    } finally { await setNotify(false); }
  });
});

describe('security + validation (07-SECURITY §4/§5): nothing is written on any refusal', () => {
  it.each([['phlebotomist (sync.upload only)', PHLEBO], ['no grants', NOBODY]])('403 auth.forbidden without homecollection.visit.assign: %s', { timeout: T }, async (_n, who) => {
    const date = D(); const { v, fx } = await ready(date);
    const e = await failure(assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx, who }));
    expect(e.code).toBe('auth.forbidden');
    expect(e.probe.identity.some((c: any) => c.permission === 'homecollection.visit.assign')).toBe(true);
    expect(e.probe.createOrder).toHaveLength(0);
    await unchanged(v);
  });
  it.each([[false], [true]])("another tenant's visit is invisible: 404 common.not_found, tenant A untouched (RLS %s)", { timeout: T }, async (bypass) => {
    const date = D(); const { v, fx } = await ready(date);
    const e = await failure(assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx, who: DISPATCHER_B, bypassRls: bypass }));
    expect(e.code).toBe('common.not_found');
    expect(e.probe.createOrder).toHaveLength(0);
    await unchanged(v);
  });
  it('If-Match is mandatory (428 common.precondition_required) and a stale one is 409 common.version_conflict', { timeout: T }, async () => {
    const date = D(); const { v, fx } = await ready(date);
    const noHeader = await failure(dop('assignHomeVisit', req({ params: { visit_id: v.id }, headers: { 'idempotency-key': key() }, body: body(MEMBER.a, date) }), DISPATCHER, { fx }));
    expect(noHeader.code).toBe('common.precondition_required');
    const stale = await failure(assign({ visitId: v.id, version: v.version + 7, body: body(MEMBER.a, date), fx }));
    expect(stale.code).toBe('common.version_conflict');
    for (const e of [noHeader, stale]) expect(e.probe.createOrder).toHaveLength(0);
    await unchanged(v);
  });
  it.each([
    ['missing phlebotomist_membership_id', (d: string) => ({ route_date: d })],
    ['missing route_date', () => ({ phlebotomist_membership_id: MEMBER.a })],
    ['membership id not a uuid', (d: string) => ({ phlebotomist_membership_id: 'not-a-uuid', route_date: d })],
    ["SQL in the membership id ('; DROP TABLE homecollection.visits;--)", (d: string) => ({ phlebotomist_membership_id: "'; DROP TABLE homecollection.visits;--", route_date: d })],
    ['route_date not a date (2027-02-30)', () => ({ phlebotomist_membership_id: MEMBER.a, route_date: '2027-02-30' })],
    ['route_sequence 0', (d: string) => body(MEMBER.a, d, 0)],
    ['route_sequence 61', (d: string) => body(MEMBER.a, d, 61)],
    ['route_sequence 1.5', (d: string) => ({ ...body(MEMBER.a, d), route_sequence: 1.5 })],
    ['unknown field tenant_id (tenant comes from the claims, never the body)', (d: string) => ({ ...body(MEMBER.a, d), tenant_id: TENANT_B })],
    ['unknown field order_id (the order is created by C4, never supplied)', (d: string) => ({ ...body(MEMBER.a, d), order_id: uid() })],
    ['body is an array', () => []],
    ['null body', () => null],
  ])('400 common.validation_failed: %s', { timeout: T }, async (_n, mk) => {
    const date = D(); const { v, fx } = await ready(date);
    const e = await failure(assign({ visitId: v.id, version: v.version, body: (mk as (d: string) => unknown)(date), fx }));
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect(e.probe.createOrder).toHaveLength(0);
    await unchanged(v);
    expect(JSON.stringify(e.errors ?? [])).not.toContain('DROP TABLE');                       // fixed messages: no submitted value is echoed
  });
  it('a visit id that is not a uuid is a 400, an unknown one a 404 (no existence oracle across tenants)', { timeout: T }, async () => {
    const date = D();
    const bad = await failure(assign({ visitId: "x'; --", version: 1, body: body(MEMBER.a, date) }));
    expect(bad.code).toBe('common.validation_failed');
    const unknown = await failure(assign({ visitId: uid(), version: 1, body: body(MEMBER.a, date) }));
    expect(unknown.code).toBe('common.not_found');
  });
  it('REQ-SEC-081: no patient name / address / phone in the logs of a successful assign', { timeout: T }, async () => {
    const date = D(); const { v, fx } = await ready(date);
    const r = await assign({ visitId: v.id, version: v.version, body: body(MEMBER.a, date), fx });
    const logs = r.probe.logs.join('\n');
    expect(logs).not.toMatch(/Synthetic Ward|Synthetic Patient|\+977980|bakery/i);
  });
});
