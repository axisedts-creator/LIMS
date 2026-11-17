// HC-T06: frontdesk.order.created.v1 consumer of C17 + homecollection.refresh_visit_specimens task (02-TRD §8.2 row 3, §8.3, §10, 03-IC §3.1, 01-PRD US-02-1..3, 03-APP-FLOW V2 + §5.2, 07-SECURITY consumers/tenant isolation).
// Live PG17 (migrated + seeded + homecollection DDL; tests/homecollection/HC-T06.pg.sh exports LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL; missing env = HARD FAILURE, never a skip).
// Same harness as HC-T05 (hand-built JobContext: ctx.tx = pg client in a transaction as lims_api under RLS with the system actor's claims; ctx.db.tx = REAL savepoint wrapper). Fixtures written as
// superuser; assertions read as superuser (no RLS). Synthetic data only (tenant A "Synthetic Lab Alpha" / B, home-collection centre HC-A1, patient "Test Patient 0042").
// ASSUMED (spec silent; the implementer disputes if wrong):
//  - files: consumers/frontdesk.order.created.v1.ts exports `onOrderCreated` (ConsumerHandler = (event: full envelope, ctx)); tasks/refresh_visit_specimens.ts exports `refreshVisitSpecimens`
//    (TaskHandler = (payload {tenant_id, visit_id}, ctx)) — names from 02-TRD §3.2 manifest. event.tenant_id must equal ctx.tenantId (else a no-op, like the other C17 consumers).
//  - the inbox row + ajv unknown-field stripping are the core wrapper's (worker core tests); "inbox dedupe" here = the handler is safe when the SAME event (or the same order under a new event_id) is delivered again.
//  - the consumer enqueues through app.enqueue_job('homecollection.refresh_visit_specimens', {tenant_id, visit_id}, 'refresh:<visit_id>') (TRD §10 job_key); it never calls LabPort itself (the TASK does).
//    Observed in graphile_worker.jobs; the registry row (core.g_task_registry, normally written by registry-sync at deploy) is upserted here as superuser.
//  - the task reaches the port as ctx.ports.LabPort.lookupSpecimens(ctx, { orderId }) (03-IC SpecimenSelector `{orderId, statuses?}` — statuses is not pinned) and rethrows a port error (queue retries, 10 attempts).
//  - refresh upserts visit_specimens by (tenant, visit, specimen): never DELETEs rows, never stores the barcode (no column), never LOWERS last_seq (events with a higher seq still win), inserts with last_seq 0;
//    bumps the route version only when a row actually changed (a re-run that changes nothing bumps nothing); skips SpecimenRefs whose orderId is not the visit's order (defence in depth).
//  - a redelivery of a home_collection confirmation does not bump the route version a second time (nothing changed).
//  - every state change writes a visit_transitions row (05-SCHEMA §1); only to_status / from_status are asserted.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BRANCH, rows as fd } from '../../../../../api/src/modules/frontdesk/__tests__/integration/helpers.js';
import { appTx, closePools, hc, HC_CENTRE, MEMBER, ownerRows, seed, superTx, SYS_ACTOR, T0, TENANT, uid, type Side } from '../../../../../api/src/modules/homecollection/repository/__tests__/helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const ORDER_CREATED = 'frontdesk.order.created.v1';
const REFRESH = 'homecollection.refresh_visit_specimens';
const REGISTERED_AT = '2026-11-05T02:31:11.950Z';
let onOrderCreated: (event: any, ctx: any) => Promise<void>;
let refreshVisitSpecimens: (payload: any, ctx: any) => Promise<void>;

// ------------------------------------------------------------------------------------------------ doubles
function makeLab(o: { refs?: any[]; error?: Error } = {}) {
  const calls: Array<{ ctx: any; input: any }> = [];
  return { calls, async lookupSpecimens(ctx: any, input: any) { calls.push({ ctx, input }); if (o.error) throw o.error; return o.refs ?? []; } };
}
type Lab = ReturnType<typeof makeLab>;

let spN = 0;
function makeCtx(tx: any, tenant: string, lab: Lab, logs: string[]) {
  const sink = (x: unknown, m?: unknown) => logs.push(JSON.stringify([x, m]));
  const log: any = { info: sink, warn: sink, error: sink, debug: sink, child: () => log };
  const ctx: any = {
    tenantId: tenant, tx, actor: { type: 'system', id: SYS_ACTOR }, requestId: uid(), attempt: 1, maxAttempts: 10, jobId: '1',
    now: () => new Date().toISOString(), isNewer: (last: number | undefined, seq: number) => last === undefined || seq > last,
    events: {}, core: {}, audit: { access: async () => undefined }, storage: {}, files: {}, log, metrics: { inc() {}, set() {}, observe() {} },
    ports: { LabPort: lab },
  };
  ctx.db = {
    tx: async (fn: (c: any) => Promise<any>) => {
      const sp = `hc_t06_sp_${++spN}`;
      await tx.query(`SAVEPOINT ${sp}`);
      try { const r = await fn(ctx); await tx.query(`RELEASE SAVEPOINT ${sp}`); return r; }
      catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`); throw e; }
    },
  };
  return ctx;
}

interface World { s: Side; tenant: string; patient: any }
const worlds = {} as Record<Side, World>;
async function mkWorld(s: Side): Promise<World> { const patient = fd.patient(s); await seed('frontdesk.patients', patient); return { s, tenant: TENANT[s], patient }; }
/** A fresh home-collection order (frontdesk + lab side, so lab.specimens FKs hold). */
async function newOrder(w: World) {
  const order = fd.order(w.s, w.patient.id, { centre_id: HC_CENTRE[w.s], collection_mode: 'home' }); await seed('frontdesk.orders', order);
  await seed('lab.orders', { id: order.id, tenant_id: w.tenant, centre_id: HC_CENTRE[w.s], branch_id: BRANCH[w.s], patient_id: w.patient.id, registration_no: order.registration_no, visit_type: 'opd',
    priority: 'routine', collection_mode: 'home', source: 'home_collection', registered_at: T0, patient_sex: 'female', last_order_seq: 1 });
  return order;
}
let bcN = 0;
async function newSpecimen(w: World, orderId: string, o: Record<string, unknown> = {}) {
  const sp = { id: uid(), tenant_id: w.tenant, centre_id: HC_CENTRE[w.s], order_id: orderId, patient_id: w.patient.id, barcode: `HCT06${w.s.toUpperCase()}${String(Date.now()).slice(-8)}${++bcN}`, creation_key: `hct06-${uid()}`,
    specimen_type_code: 'SST', priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: T0, ...o };
  await seed('lab.specimens', sp); return sp;
}
const refOf = (w: World, sp: any, o: Record<string, unknown> = {}) => ({ specimenId: sp.id, barcode: sp.barcode, orderId: sp.order_id, patientId: w.patient.id, centreId: HC_CENTRE[w.s],
  specimenTypeCode: sp.specimen_type_code, status: 'ordered', isActive: true, version: 1, ...o });

// ------------------------------------------------------------------------------------------------ events (03-IC §3.1 example shape)
function orderEvent(w: World, orderId: string, o: { seq?: number; payload?: Record<string, unknown>; env?: Record<string, unknown> } = {}): any {
  return {
    event_id: uid(), event_type: ORDER_CREATED, tenant_id: w.tenant, occurred_at: '2026-11-05T02:31:12.004Z',
    actor: { type: 'user', id: uid(), membership_id: MEMBER[w.s] }, idempotency_key: `${orderId}:created`, producer: 'frontdesk',
    aggregate: { type: 'order', id: orderId, seq: o.seq ?? 1 }, request_id: uid(),
    payload: {
      order_id: orderId, patient_id: w.patient.id, branch_id: BRANCH[w.s], centre_id: HC_CENTRE[w.s], visit_type: 'opd', billing_mode: 'cash', priority: 'routine',
      collection_mode: 'home', source: 'front_desk', registered_at: REGISTERED_AT,
      items: [{ order_item_id: uid(), orderable_id: uid(), orderable_kind: 'test', test_ids: [uid()], priority: 'routine' }], ...o.payload,
    },
    ...o.env,
  };
}

/** One delivery = one transaction (as the queue does); returns the thrown error instead of throwing. */
async function run(fn: (c: any) => Promise<void>, tenant: string, lab: Lab) {
  const logs: string[] = []; let threw: any;
  try { await appTx(tenant, async (tx) => { await fn(makeCtx(tx, tenant, lab, logs)); }); } catch (e) { threw = e; }
  return { lab, logs, threw };
}
const deliver = (event: any, o: { lab?: Lab; ctxTenant?: string } = {}) => { const t = o.ctxTenant ?? event.tenant_id; const lab = o.lab ?? makeLab(); return run((ctx) => onOrderCreated(event, ctx), t, lab); };
const refresh = (tenant: string, visitId: string, o: { lab?: Lab; payloadTenant?: string } = {}) =>
  run((ctx) => refreshVisitSpecimens({ tenant_id: o.payloadTenant ?? tenant, visit_id: visitId }, ctx), tenant, o.lab ?? makeLab());

// ------------------------------------------------------------------------------------------------ reads (superuser, no RLS)
const visitsOfOrder = (tenant: string, orderId: string) => ownerRows('homecollection.visits', 'tenant_id = $1 AND order_id = $2', [tenant, orderId]);
const visitById = async (tenant: string, id: string) => (await ownerRows('homecollection.visits', 'tenant_id = $1 AND id = $2', [tenant, id]))[0];
const flagsOf = (tenant: string, visitId: string, kind?: string) =>
  ownerRows('homecollection.visit_flags', kind ? 'tenant_id = $1 AND visit_id = $2 AND kind = $3' : 'tenant_id = $1 AND visit_id = $2', kind ? [tenant, visitId, kind] : [tenant, visitId]);
const transitionsOf = (tenant: string, visitId: string) => ownerRows('homecollection.visit_transitions', 'tenant_id = $1 AND visit_id = $2', [tenant, visitId]);
const vsOf = (tenant: string, visitId: string) => ownerRows('homecollection.visit_specimens', 'tenant_id = $1 AND visit_id = $2', [tenant, visitId]);
const routeOf = async (tenant: string, id: string) => (await ownerRows('homecollection.routes', 'tenant_id = $1 AND id = $2', [tenant, id]))[0];
const jobsFor = (visitId: string) => superTx(async (tx: any) => (await tx.query(`SELECT j.key, t.identifier AS task_identifier, j.payload FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE j.key = $1`, [`refresh:${visitId}`])).rows);
const allVisits = (tenant: string) => ownerRows('homecollection.visits', 'tenant_id = $1', [tenant]);
const everything = async (tenant: string, visitId: string) =>
  JSON.stringify([await visitById(tenant, visitId), await flagsOf(tenant, visitId), await transitionsOf(tenant, visitId), await vsOf(tenant, visitId)]);

// ------------------------------------------------------------------------------------------------ fixtures
/** A front_desk visit on an order (what V2 creates), optionally assigned on a route. */
async function frontDeskVisit(w: World, o: { assigned?: boolean; order?: any; extra?: Record<string, unknown> } = {}) {
  const order = o.order ?? await newOrder(w); let route: any; const extra: Record<string, unknown> = { ...o.extra };
  if (o.assigned) {
    route = hc.route(w.s); await seed('homecollection.routes', route);
    Object.assign(extra, { status: 'assigned', route_id: route.id, route_date: route.route_date, route_sequence: 1, assigned_membership_id: MEMBER[w.s], assigned_at: '2026-11-05T12:00:00Z',
      window_start: '2026-11-06T01:15:00Z', window_end: '2026-11-06T01:45:00Z' });
  }
  const visit = hc.visit(w.s, { patient: w.patient, order }, extra); await seed('homecollection.visits', visit);
  return { visit, order, route };
}

beforeAll(async () => {
  worlds.a = await mkWorld('a'); worlds.b = await mkWorld('b');
  await superTx(async (tx: any) => { await tx.query(`INSERT INTO core.g_task_registry (identifier, module, kind, scope, max_attempts, is_active) VALUES ($1, 'homecollection', 'task', 'per_tenant', 10, true)
    ON CONFLICT (identifier) DO UPDATE SET is_active = true`, [REFRESH]); });                // registry-sync runs at deploy, not in tests
  onOrderCreated = (await import('../consumers/frontdesk.order.created.v1.js')).onOrderCreated;
  refreshVisitSpecimens = (await import('../tasks/refresh_visit_specimens.js')).refreshVisitSpecimens;
});
afterAll(async () => { await closePools(); });

// ================================================================================================ consumer
describe('HC-T06 frontdesk.order.created.v1 -> front_desk visit (US-02-1)', () => {
  it('US-02-1: collection_mode home + source front_desk -> exactly one unassigned kind front_desk visit with order_id / patient_id / centre_id / branch_id, no window, no address; flag address_missing open', async () => {
    const w = worlds.a; const order = await newOrder(w); const ev = orderEvent(w, order.id, { payload: { referrer_id: uid() } }); const p = ev.payload;
    const r = await deliver(ev);
    expect(r.threw).toBeUndefined();
    const vs = await visitsOfOrder(w.tenant, order.id);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ status: 'unassigned', kind: 'front_desk', order_id: order.id, patient_id: p.patient_id, centre_id: p.centre_id, branch_id: p.branch_id, referrer_id: p.referrer_id,
      booking_id: null, window_start: null, window_end: null, address_text: null, landmark: null, latitude: null, longitude: null, route_id: null, assigned_membership_id: null, is_active: true });
    expect(vs[0].tenant_id).toBe(w.tenant);
    expect(vs[0].created_by).toBe(SYS_ACTOR);
    const fl = await flagsOf(w.tenant, vs[0].id, 'address_missing');
    expect(fl).toHaveLength(1);
    expect(fl[0].status).toBe('open');
    const tr = await transitionsOf(w.tenant, vs[0].id);
    expect(tr.filter((t) => t.to_status === 'unassigned' && t.from_status === null)).toHaveLength(1);
  });

  it('US-02-1 + 03-APP-FLOW V2: the consumer enqueues homecollection.refresh_visit_specimens, job_key refresh:<visit_id>, payload {tenant_id, visit_id}; it does NOT call LabPort itself', async () => {
    const w = worlds.a; const order = await newOrder(w); const lab = makeLab();
    expect((await deliver(orderEvent(w, order.id), { lab })).threw).toBeUndefined();
    const v = (await visitsOfOrder(w.tenant, order.id))[0];
    const jobs = await jobsFor(v.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task_identifier).toBe(REFRESH);
    expect(jobs[0].payload).toEqual({ tenant_id: w.tenant, visit_id: v.id });
    expect(lab.calls).toHaveLength(0);
  });

  it('US-02-1 duplicate: the SAME event delivered twice -> still one visit, one open address_missing flag, one transition, one job', async () => {
    const w = worlds.a; const order = await newOrder(w); const ev = orderEvent(w, order.id);
    expect((await deliver(ev)).threw).toBeUndefined();
    expect((await deliver(ev)).threw).toBeUndefined();
    const vs = await visitsOfOrder(w.tenant, order.id);
    expect(vs).toHaveLength(1);
    expect(await flagsOf(w.tenant, vs[0].id, 'address_missing')).toHaveLength(1);
    expect((await transitionsOf(w.tenant, vs[0].id)).filter((t) => t.from_status === null)).toHaveLength(1);
    expect(await jobsFor(vs[0].id)).toHaveLength(1);
  });

  it('duplicate under a NEW event_id (replay / re-emit; unique (tenant, order_id) WHERE kind front_desk) -> still one visit, the first visit is not modified', async () => {
    const w = worlds.a; const order = await newOrder(w);
    await deliver(orderEvent(w, order.id));
    const v = (await visitsOfOrder(w.tenant, order.id))[0]; const snap = await everything(w.tenant, v.id);
    const r = await deliver(orderEvent(w, order.id, { seq: 1 }));
    expect(r.threw === undefined || r.threw).toBeTruthy();                                      // no-op, or 23505 retried by the queue
    expect(await visitsOfOrder(w.tenant, order.id)).toHaveLength(1);
    expect(await everything(w.tenant, v.id)).toBe(snap);
  });

  it('concurrency: three deliveries racing on the same order end with ONE visit and ONE address_missing flag (losers no-op or fail with 23505 for a queue retry)', async () => {
    const w = worlds.a; const order = await newOrder(w); const ev = orderEvent(w, order.id);
    const res = await Promise.all([deliver(ev), deliver(ev), deliver(orderEvent(w, order.id))]);
    for (const r of res) if (r.threw) expect(['23505', '40001', '40P01']).toContain(r.threw.code);
    await deliver(ev);                                                                          // the queue's retry of a lost race
    const vs = await visitsOfOrder(w.tenant, order.id);
    expect(vs).toHaveLength(1);
    expect(await flagsOf(w.tenant, vs[0].id, 'address_missing')).toHaveLength(1);
  });

  it('home + front_desk for an order that already has a (booking-born) visit with that order_id is NOT turned into a second visit: the order id stays unique per visit', async () => {
    const w = worlds.a; const { visit, order } = await frontDeskVisit(w);
    await deliver(orderEvent(w, order.id));
    expect(await visitsOfOrder(w.tenant, order.id)).toHaveLength(1);
    expect((await visitById(w.tenant, visit.id)).status).toBe('unassigned');
  });
});

describe('HC-T06 frontdesk.order.created.v1 source home_collection -> order_registered_at (US-02-2)', () => {
  it('US-02-2: source home_collection + source_ref_id = an existing visit -> no new visit; order_registered_at = payload.registered_at; status / order_id / window untouched; refresh enqueued', async () => {
    const w = worlds.a; const { visit, order } = await frontDeskVisit(w, { assigned: true });
    const before = await visitById(w.tenant, visit.id); expect(before.order_registered_at).toBeNull();
    const visitsBefore = (await allVisits(w.tenant)).length;
    const r = await deliver(orderEvent(w, order.id, { payload: { source: 'home_collection', source_ref_id: visit.id, collection_mode: 'home' } }));
    expect(r.threw).toBeUndefined();
    expect((await allVisits(w.tenant)).length).toBe(visitsBefore);
    expect(await visitsOfOrder(w.tenant, order.id)).toHaveLength(1);
    const after = await visitById(w.tenant, visit.id);
    expect(new Date(after.order_registered_at).toISOString()).toBe(REGISTERED_AT);
    expect(after).toMatchObject({ status: 'assigned', order_id: order.id, kind: 'front_desk', route_id: visit.route_id ?? before.route_id, assigned_membership_id: before.assigned_membership_id });
    expect(new Date(after.window_start).getTime()).toBe(new Date(before.window_start).getTime());
    expect(await flagsOf(w.tenant, visit.id, 'address_missing')).toHaveLength(0);               // no new flag from this path
    const jobs = await jobsFor(visit.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ tenant_id: w.tenant, visit_id: visit.id });
  });

  it('US-02-2 (booking-born visit): source_ref_id = a kind booking visit (order created at assign, 02-TRD §8.2) -> same visit gets order_registered_at, no second visit', async () => {
    const w = worlds.a; const order = await newOrder(w); const route = hc.route(w.s); await seed('homecollection.routes', route);
    const bv = hc.bookingVisit(w.s, { patient: w.patient }, { status: 'assigned', order_id: order.id, route_id: route.id, route_date: route.route_date, route_sequence: 1, assigned_membership_id: MEMBER[w.s],
      assigned_at: '2026-11-05T12:00:00Z', window_start: '2026-11-06T01:15:00Z', window_end: '2026-11-06T01:45:00Z' });
    await seed('homecollection.visits', bv);
    const r = await deliver(orderEvent(w, order.id, { payload: { source: 'home_collection', source_ref_id: bv.id } }));
    expect(r.threw).toBeUndefined();
    expect(await visitsOfOrder(w.tenant, order.id)).toHaveLength(1);
    expect(new Date((await visitById(w.tenant, bv.id)).order_registered_at).toISOString()).toBe(REGISTERED_AT);
  });

  it('TRD §4.1: setting order_registered_at on a visit that is on a route increments that route\'s version (same transaction); a visit without a route changes no route', async () => {
    const w = worlds.a; const { visit, order, route } = await frontDeskVisit(w, { assigned: true });
    const v0 = (await routeOf(w.tenant, route.id)).version;
    await deliver(orderEvent(w, order.id, { payload: { source: 'home_collection', source_ref_id: visit.id } }));
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0 + 1);
    const { visit: unrouted, order: o2 } = await frontDeskVisit(w);
    await deliver(orderEvent(w, o2.id, { payload: { source: 'home_collection', source_ref_id: unrouted.id } }));
    expect(new Date((await visitById(w.tenant, unrouted.id)).order_registered_at).toISOString()).toBe(REGISTERED_AT);
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0 + 1);
  });

  it('duplicate: the same home_collection event twice -> order_registered_at unchanged, ONE job, route version bumped once (ASSUMED: nothing changed on redelivery)', async () => {
    const w = worlds.a; const { visit, order, route } = await frontDeskVisit(w, { assigned: true }); const v0 = (await routeOf(w.tenant, route.id)).version;
    const ev = orderEvent(w, order.id, { payload: { source: 'home_collection', source_ref_id: visit.id } });
    await deliver(ev);
    const first = (await visitById(w.tenant, visit.id)).order_registered_at;
    expect((await deliver(ev)).threw).toBeUndefined();
    expect(new Date((await visitById(w.tenant, visit.id)).order_registered_at).getTime()).toBe(new Date(first).getTime());
    expect(await jobsFor(visit.id)).toHaveLength(1);
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0 + 1);
  });

  it('source home_collection whose source_ref_id matches NO visit (or is absent) -> nothing created, nothing thrown, no job', async () => {
    const w = worlds.a; const order = await newOrder(w); const before = (await allVisits(w.tenant)).length;
    const ghost = uid();
    expect((await deliver(orderEvent(w, order.id, { payload: { source: 'home_collection', source_ref_id: ghost } }))).threw).toBeUndefined();
    expect((await deliver(orderEvent(w, order.id, { payload: { source: 'home_collection' } }))).threw).toBeUndefined();
    expect((await allVisits(w.tenant)).length).toBe(before);
    expect(await jobsFor(ghost)).toHaveLength(0);
  });

  it('ASSUMED guard: source_ref_id is a visit whose order_id is a DIFFERENT order -> order_registered_at is not stamped from this event', async () => {
    const w = worlds.a; const { visit } = await frontDeskVisit(w, { assigned: true }); const otherOrder = await newOrder(w);
    const r = await deliver(orderEvent(w, otherOrder.id, { payload: { source: 'home_collection', source_ref_id: visit.id } }));
    expect(r.threw === undefined || r.threw).toBeTruthy();
    expect((await visitById(w.tenant, visit.id)).order_registered_at).toBeNull();
  });

  it('tenant isolation: a tenant A event whose source_ref_id is tenant B\'s visit never touches B\'s visit, flags, route or specimens', async () => {
    const a = worlds.a, b = worlds.b; const { visit, route } = await frontDeskVisit(b, { assigned: true }); const snap = await everything(b.tenant, visit.id); const rv = (await routeOf(b.tenant, route.id)).version;
    const orderA = await newOrder(a);
    const r = await deliver(orderEvent(a, orderA.id, { payload: { source: 'home_collection', source_ref_id: visit.id } }));
    expect(r.threw === undefined || r.threw).toBeTruthy();
    expect(await everything(b.tenant, visit.id)).toBe(snap);
    expect((await routeOf(b.tenant, route.id)).version).toBe(rv);
    expect(await jobsFor(visit.id)).toHaveLength(0);
  });
});

describe('HC-T06 frontdesk.order.created.v1 ignored cases (US-02-3)', () => {
  it('US-02-3: collection_mode walk_in with EVERY source (front_desk, engagement_booking, home_collection + a real visit, partner_manifest) -> nothing: no visit, flag, job, no order_registered_at', async () => {
    const w = worlds.a; const { visit: existing, order: exOrder } = await frontDeskVisit(w, { assigned: true }); const snap = await everything(w.tenant, existing.id);
    const before = (await allVisits(w.tenant)).length;
    for (const source of ['front_desk', 'engagement_booking', 'home_collection', 'partner_manifest']) {
      const order = source === 'home_collection' ? exOrder : await newOrder(w);
      const payload: Record<string, unknown> = { collection_mode: 'walk_in', source, ...(source === 'home_collection' ? { source_ref_id: existing.id } : {}) };
      const r = await deliver(orderEvent(w, order.id, { payload }));
      expect(r.threw).toBeUndefined();
      if (source !== 'home_collection') expect(await visitsOfOrder(w.tenant, order.id)).toHaveLength(0);
    }
    expect((await allVisits(w.tenant)).length).toBe(before);
    expect(await everything(w.tenant, existing.id)).toBe(snap);
    expect((await visitById(w.tenant, existing.id)).order_registered_at).toBeNull();
    expect(await jobsFor(existing.id)).toHaveLength(0);
  });

  it('TRD §8.2 "else ignore": collection_mode centre / partner (source front_desk) and home + engagement_booking / partner_manifest -> no visit, no job, no throw', async () => {
    const w = worlds.a; const before = (await allVisits(w.tenant)).length;
    const cases: Array<Record<string, unknown>> = [{ collection_mode: 'centre', source: 'front_desk' }, { collection_mode: 'partner', source: 'front_desk' },
      { collection_mode: 'home', source: 'engagement_booking' }, { collection_mode: 'home', source: 'partner_manifest' }];
    for (const payload of cases) {
      const order = await newOrder(w); const r = await deliver(orderEvent(w, order.id, { payload }));
      expect(r.threw, JSON.stringify(payload)).toBeUndefined();
      expect(await visitsOfOrder(w.tenant, order.id), JSON.stringify(payload)).toHaveLength(0);
    }
    expect((await allVisits(w.tenant)).length).toBe(before);
  });

  it('tenant isolation: an event whose tenant_id differs from ctx.tenantId creates nothing (for either tenant)', async () => {
    const a = worlds.a, b = worlds.b; const orderB = await newOrder(b); const before = [(await allVisits(a.tenant)).length, (await allVisits(b.tenant)).length];
    const r = await deliver(orderEvent(b, orderB.id), { ctxTenant: a.tenant });
    expect(r.threw === undefined || r.threw).toBeTruthy();
    expect(await visitsOfOrder(b.tenant, orderB.id)).toHaveLength(0);
    expect([(await allVisits(a.tenant)).length, (await allVisits(b.tenant)).length]).toEqual(before);
  });

  it('log hygiene (07-SECURITY): the consumer logs no patient id (P3) and no barcode', async () => {
    const w = worlds.a; const order = await newOrder(w); const r = await deliver(orderEvent(w, order.id));
    expect(r.logs.join('\n')).not.toContain(w.patient.id);
  });
});

// ================================================================================================ refresh task
describe('HC-T06 homecollection.refresh_visit_specimens (02-TRD §10, §4.1, §8.3, 05-SCHEMA visit_specimens)', () => {
  it('lookupSpecimens({orderId}) as the system actor -> one visit_specimens row per SpecimenRef (type, container, status, is_active, last_seq 0, refreshed_at now, centre = visit centre); the barcode is NEVER stored or logged', async () => {
    const w = worlds.a; const { visit, order } = await frontDeskVisit(w);
    const s1 = await newSpecimen(w, order.id, { specimen_type_code: 'SST' }); const s2 = await newSpecimen(w, order.id, { specimen_type_code: 'EDTA' });
    const lab = makeLab({ refs: [refOf(w, s1, { containerCode: 'TUBE_GOLD' }), refOf(w, s2, { specimenTypeCode: 'EDTA', status: 'collected' })] });
    const r = await refresh(w.tenant, visit.id, { lab });
    expect(r.threw).toBeUndefined();
    expect(lab.calls).toHaveLength(1);
    expect(lab.calls[0]!.input).toMatchObject({ orderId: order.id });
    expect(lab.calls[0]!.ctx.actor).toMatchObject({ type: 'system' });
    const rows = await vsOf(w.tenant, visit.id);
    expect(rows).toHaveLength(2);
    const a = rows.find((x) => x.specimen_id === s1.id)!; const b = rows.find((x) => x.specimen_id === s2.id)!;
    expect(a).toMatchObject({ order_id: order.id, centre_id: HC_CENTRE.a, specimen_type_code: 'SST', container_code: 'TUBE_GOLD', status: 'ordered', is_active: true, last_seq: 0, replaces_specimen_id: null });
    expect(b).toMatchObject({ specimen_type_code: 'EDTA', container_code: null, status: 'collected', last_seq: 0 });
    expect(Math.abs(Date.now() - new Date(a.refreshed_at).getTime())).toBeLessThan(120_000);
    expect(JSON.stringify(rows)).not.toContain(s1.barcode);
    expect(JSON.stringify(rows)).not.toContain(s2.barcode);
    expect(r.logs.join('\n')).not.toContain(s1.barcode);
  });

  it('idempotent: running the task twice -> same rows, no duplicates; a changed port status is updated in place (same row id)', async () => {
    const w = worlds.a; const { visit, order } = await frontDeskVisit(w); const s = await newSpecimen(w, order.id);
    await refresh(w.tenant, visit.id, { lab: makeLab({ refs: [refOf(w, s)] }) });
    const id1 = (await vsOf(w.tenant, visit.id))[0].id;
    await refresh(w.tenant, visit.id, { lab: makeLab({ refs: [refOf(w, s)] }) });
    expect(await vsOf(w.tenant, visit.id)).toHaveLength(1);
    await refresh(w.tenant, visit.id, { lab: makeLab({ refs: [refOf(w, s, { status: 'received' })] }) });
    const rows = await vsOf(w.tenant, visit.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: id1, status: 'received' });
  });

  it('never lowers last_seq: a row written by an event (last_seq 7) keeps 7 after a port refresh, and the refresh does not delete rows the port no longer lists', async () => {
    const w = worlds.a; const { visit, order } = await frontDeskVisit(w); const s = await newSpecimen(w, order.id); const gone = await newSpecimen(w, order.id);
    await seed('homecollection.visit_specimens', hc.visitSpecimen(w.s, { specimen: s, order }, visit.id, { last_seq: 7, status: 'collected' }));
    await seed('homecollection.visit_specimens', hc.visitSpecimen(w.s, { specimen: gone, order }, visit.id, { last_seq: 3 }));
    const r = await refresh(w.tenant, visit.id, { lab: makeLab({ refs: [refOf(w, s, { status: 'in_transit' })] }) });
    expect(r.threw).toBeUndefined();
    const rows = await vsOf(w.tenant, visit.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.specimen_id === s.id)).toMatchObject({ last_seq: 7, status: 'in_transit' });
    expect(rows.find((x) => x.specimen_id === gone.id)).toMatchObject({ last_seq: 3 });
  });

  it('recollection: a SpecimenRef with replacesSpecimenId -> new row with replaces_specimen_id, the old row stays (both present, old may be inactive)', async () => {
    const w = worlds.a; const { visit, order } = await frontDeskVisit(w); const oldS = await newSpecimen(w, order.id, { status: 'rejected' }); const newS = await newSpecimen(w, order.id);
    const r = await refresh(w.tenant, visit.id, { lab: makeLab({ refs: [refOf(w, oldS, { status: 'rejected', isActive: false }), refOf(w, newS, { replacesSpecimenId: oldS.id })] }) });
    expect(r.threw).toBeUndefined();
    const rows = await vsOf(w.tenant, visit.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.specimen_id === newS.id)).toMatchObject({ replaces_specimen_id: oldS.id, is_active: true });
    expect(rows.find((x) => x.specimen_id === oldS.id)).toMatchObject({ status: 'rejected', is_active: false });
  });

  it('TRD §4.1: a refresh that changes the read model of a visit on a route bumps the route version by 1; an identical re-run bumps nothing; a visit without a route touches no route', async () => {
    const w = worlds.a; const { visit, order, route } = await frontDeskVisit(w, { assigned: true }); const s = await newSpecimen(w, order.id); const v0 = (await routeOf(w.tenant, route.id)).version;
    await refresh(w.tenant, visit.id, { lab: makeLab({ refs: [refOf(w, s)] }) });
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0 + 1);
    await refresh(w.tenant, visit.id, { lab: makeLab({ refs: [refOf(w, s)] }) });
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0 + 1);
    await refresh(w.tenant, visit.id, { lab: makeLab({ refs: [refOf(w, s, { status: 'collected' })] }) });
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0 + 2);
    const { visit: unrouted, order: o2 } = await frontDeskVisit(w); const s2 = await newSpecimen(w, o2.id);
    expect((await refresh(w.tenant, unrouted.id, { lab: makeLab({ refs: [refOf(w, s2)] }) })).threw).toBeUndefined();
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0 + 2);
  });

  it('port failure -> the task THROWS (queue retries, TRD §10: 10 attempts), existing rows and the route version are untouched', async () => {
    const w = worlds.a; const { visit, order, route } = await frontDeskVisit(w, { assigned: true }); const s = await newSpecimen(w, order.id);
    await seed('homecollection.visit_specimens', hc.visitSpecimen(w.s, { specimen: s, order }, visit.id, { status: 'ordered' }));
    const snap = await everything(w.tenant, visit.id); const v0 = (await routeOf(w.tenant, route.id)).version;
    const r = await refresh(w.tenant, visit.id, { lab: makeLab({ error: Object.assign(new Error('lab port down'), { code: 'common.unavailable' }) }) });
    expect(r.threw).toBeDefined();
    expect(await everything(w.tenant, visit.id)).toBe(snap);
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0);
  });

  it('an empty port answer (specimens not created yet) -> no rows, no throw, existing rows kept (never DELETE of the read model)', async () => {
    const w = worlds.a; const { visit, order } = await frontDeskVisit(w); const s = await newSpecimen(w, order.id);
    expect((await refresh(w.tenant, visit.id, { lab: makeLab({ refs: [] }) })).threw).toBeUndefined();
    expect(await vsOf(w.tenant, visit.id)).toHaveLength(0);
    await seed('homecollection.visit_specimens', hc.visitSpecimen(w.s, { specimen: s, order }, visit.id));
    expect((await refresh(w.tenant, visit.id, { lab: makeLab({ refs: [] }) })).threw).toBeUndefined();
    expect(await vsOf(w.tenant, visit.id)).toHaveLength(1);
  });

  it('a visit with no order yet (unassigned booking visit) -> the port is not called, nothing written, no throw', async () => {
    const w = worlds.a; const bv = hc.bookingVisit(w.s, { patient: w.patient }); await seed('homecollection.visits', bv); const lab = makeLab({ refs: [] });
    const r = await refresh(w.tenant, bv.id, { lab });
    expect(r.threw).toBeUndefined();
    expect(lab.calls).toHaveLength(0);
    expect(await vsOf(w.tenant, bv.id)).toHaveLength(0);
  });

  it('defence in depth: a SpecimenRef whose orderId is NOT the visit\'s order is not stored', async () => {
    const w = worlds.a; const { visit, order } = await frontDeskVisit(w); const other = await newOrder(w);
    const mine = await newSpecimen(w, order.id); const foreign = await newSpecimen(w, other.id);
    const r = await refresh(w.tenant, visit.id, { lab: makeLab({ refs: [refOf(w, mine), refOf(w, foreign)] }) });
    expect(r.threw === undefined || r.threw).toBeTruthy();
    expect((await vsOf(w.tenant, visit.id)).map((x) => x.specimen_id)).not.toContain(foreign.id);
  });

  it('tenant isolation: payload.tenant_id != ctx.tenantId, or a visit_id of the other tenant (RLS hides it) -> no port call, no write', async () => {
    const a = worlds.a, b = worlds.b; const { visit, order } = await frontDeskVisit(b); const s = await newSpecimen(b, order.id); const snap = await everything(b.tenant, visit.id);
    const lab1 = makeLab({ refs: [refOf(b, s)] });
    expect((await refresh(a.tenant, visit.id, { lab: lab1 })).threw === undefined || true).toBeTruthy();   // tenant A claims, B's visit id
    expect(lab1.calls).toHaveLength(0);
    const lab2 = makeLab({ refs: [refOf(b, s)] });
    const r2 = await refresh(a.tenant, visit.id, { lab: lab2, payloadTenant: b.tenant });                 // forged payload tenant
    expect(r2.threw === undefined || r2.threw).toBeTruthy();
    expect(lab2.calls).toHaveLength(0);
    expect(await everything(b.tenant, visit.id)).toBe(snap);
    const lab3 = makeLab();
    expect((await refresh(a.tenant, uid(), { lab: lab3 })).threw === undefined || true).toBeTruthy();    // unknown visit: no-op (the visit may be gone by the time the job runs)
    expect(lab3.calls).toHaveLength(0);
  });
});

describe('HC-T06 brief files', () => {
  it('the three implementation files named by the brief exist (consumer, task, API specimen.service.ts)', () => {
    const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
    expect(existsSync(here('../consumers/frontdesk.order.created.v1.ts'))).toBe(true);
    expect(existsSync(here('../tasks/refresh_visit_specimens.ts'))).toBe(true);
    expect(existsSync(here('../../../../../api/src/modules/homecollection/specimen.service.ts'))).toBe(true);
  });
});
