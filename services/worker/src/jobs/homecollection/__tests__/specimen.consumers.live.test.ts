// HC-T07: lab.specimen.status_changed.v1 + lab.specimen.rejected.v1 consumers of C17 (02-TRD §8.2 rows 4-5, §8.3, 03-IC §3.7/§3.8, 01-PRD US-11-1/2, US-14-1/2, 03-APP-FLOW V3, 07-SECURITY consumers/tenant isolation).
// Live PG17 (migrated + seeded + homecollection DDL; tests/homecollection/HC-T07.pg.sh exports LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL; missing env = HARD FAILURE, never a skip).
// Same harness as HC-T05/HC-T06 (hand-built JobContext: ctx.tx = pg client in a transaction as lims_api under RLS with the system actor's claims; ctx.db.tx = REAL savepoint wrapper). Fixtures written as
// superuser; assertions read as superuser (no RLS). Synthetic data only (tenant A "Synthetic Lab Alpha" / B, home-collection centre HC-A1, patient "Test Patient 0042").
// ASSUMED (spec silent; the implementer disputes if wrong):
//  - files: consumers/lab.specimen.status_changed.v1.ts exports `onSpecimenStatusChanged`, consumers/lab.specimen.rejected.v1.ts exports `onSpecimenRejected` (names from 02-TRD §3.2 manifest);
//    ConsumerHandler = (event: full envelope, ctx). event.tenant_id must equal ctx.tenantId (else a no-op, like the other C17 consumers). seq = event.aggregate.seq.
//  - the inbox row + ajv unknown-field stripping are the core wrapper's (worker core tests); "duplicate" here = the handler is safe when the SAME event (or the same specimen under a new event_id) is delivered again.
//  - status_changed: upserts visit_specimens by (tenant, visit, specimen) (insert when absent: order_id, centre_id = visit centre, specimen_type_code, status = to_status, is_active true, last_seq = seq, replaces_specimen_id);
//    applies only when seq > stored last_seq (a stale / equal seq changes NOTHING, not even the route version); bumps the route version once per applied event for a visit on a route; never DELETEs rows;
//    it never calls LabPort (the event is the source) and never stores the barcode (the payload has none).
//  - "30 days [CONV]": visits whose created_at is older than 30 days are ignored (29 days old still applies).
//  - rejected: the new recollection visit copies patient / centre / branch / order / home_address_id / address_text / landmark / lat / long from the PARENT, no window, unassigned, no route, created_by = system actor,
//    one transition (null -> unassigned), and the flag `recollection_required` opens on the NEW visit (PRD US-11-1 "flag recollection_required"; parent visit row is not modified, its order is not cancelled).
//    Parent = payload.home_visit_id when it is a visit of payload.order_id in this tenant, else the latest (created_at) visit of order_id. A home_visit_id of ANOTHER order is never used as a parent.
//  - every state change writes a visit_transitions row (05-SCHEMA §1); only to_status / from_status are asserted.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BRANCH, rows as fd } from '../../../../../api/src/modules/frontdesk/__tests__/integration/helpers.js';
import { appTx, closePools, hc, HC_CENTRE, MEMBER, ownerRows, seed, superTx, SYS_ACTOR, T0, TENANT, uid, type Side } from '../../../../../api/src/modules/homecollection/repository/__tests__/helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const STATUS = 'lab.specimen.status_changed.v1';
const REJECTED = 'lab.specimen.rejected.v1';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
let onSpecimenStatusChanged: (event: any, ctx: any) => Promise<void>;
let onSpecimenRejected: (event: any, ctx: any) => Promise<void>;

// ------------------------------------------------------------------------------------------------ doubles
function makeLab() { const calls: unknown[] = []; return { calls, async lookupSpecimens(...a: unknown[]) { calls.push(a); return []; } }; }
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
      const sp = `hc_t07_sp_${++spN}`;
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
  const sp = { id: uid(), tenant_id: w.tenant, centre_id: HC_CENTRE[w.s], order_id: orderId, patient_id: w.patient.id, barcode: `HCT07${w.s.toUpperCase()}${String(Date.now()).slice(-8)}${++bcN}`, creation_key: `hct07-${uid()}`,
    specimen_type_code: 'SST', priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: T0, ...o };
  await seed('lab.specimens', sp); return sp;
}

// ------------------------------------------------------------------------------------------------ events (03-IC §3.7 / §3.8 example shapes)
const base = (w: World, type: string, key: string, specimenId: string, seq: number, payload: Record<string, unknown>, env: Record<string, unknown> = {}): any => ({
  event_id: uid(), event_type: type, tenant_id: w.tenant, occurred_at: '2026-11-10T04:05:00.000Z', actor: { type: 'user', id: uid(), membership_id: MEMBER[w.s] }, idempotency_key: key, producer: 'lab',
  aggregate: { type: 'specimen', id: specimenId, seq }, request_id: uid(), payload, ...env });
function statusEvent(w: World, sp: any, o: { seq?: number; to?: string; from?: string | null; payload?: Record<string, unknown>; env?: Record<string, unknown> } = {}): any {
  const seq = o.seq ?? 1; const to = o.to ?? 'collected';
  const payload: Record<string, unknown> = { specimen_id: sp.id, order_id: sp.order_id, patient_id: w.patient.id, centre_id: HC_CENTRE[w.s], processing_branch_id: BRANCH[w.s], specimen_type_code: sp.specimen_type_code,
    to_status: to, changed_at: '2026-11-10T04:05:00.000Z', ...(o.from === null ? {} : { from_status: o.from ?? 'ordered' }), ...o.payload };
  return base(w, STATUS, `${sp.id}:${to}:${seq}`, sp.id, seq, payload, o.env);
}
function rejectedEvent(w: World, sp: any, o: { seq?: number; recollection?: boolean; visitId?: string; payload?: Record<string, unknown>; env?: Record<string, unknown> } = {}): any {
  const payload: Record<string, unknown> = { specimen_id: sp.id, order_id: sp.order_id, patient_id: w.patient.id, centre_id: HC_CENTRE[w.s], reason_code: 'haemolysed', rejected_at: '2026-11-10T04:25:00.000Z',
    recollection_required: o.recollection ?? true, order_item_ids: [uid()], ...(o.visitId ? { home_visit_id: o.visitId } : {}), ...o.payload };
  return base(w, REJECTED, `${sp.id}:rejected`, sp.id, o.seq ?? 3, payload, o.env);
}

/** One delivery = one transaction (as the queue does); returns the thrown error instead of throwing. */
async function run(fn: (c: any) => Promise<void>, tenant: string, lab: Lab) {
  const logs: string[] = []; let threw: any;
  try { await appTx(tenant, async (tx) => { await fn(makeCtx(tx, tenant, lab, logs)); }); } catch (e) { threw = e; }
  return { lab, logs, threw };
}
type Opts = { lab?: Lab; ctxTenant?: string };
const status = (event: any, o: Opts = {}) => { const lab = o.lab ?? makeLab(); return run((ctx) => onSpecimenStatusChanged(event, ctx), o.ctxTenant ?? event.tenant_id, lab); };
const rejected = (event: any, o: Opts = {}) => { const lab = o.lab ?? makeLab(); return run((ctx) => onSpecimenRejected(event, ctx), o.ctxTenant ?? event.tenant_id, lab); };

// ------------------------------------------------------------------------------------------------ reads (superuser, no RLS)
const vsOf = (tenant: string, visitId: string) => ownerRows('homecollection.visit_specimens', 'tenant_id = $1 AND visit_id = $2', [tenant, visitId]);
const vsOfSpecimen = (tenant: string, specimenId: string) => ownerRows('homecollection.visit_specimens', 'tenant_id = $1 AND specimen_id = $2', [tenant, specimenId]);
const visitById = async (tenant: string, id: string) => (await ownerRows('homecollection.visits', 'tenant_id = $1 AND id = $2', [tenant, id]))[0];
const allVisits = (tenant: string) => ownerRows('homecollection.visits', 'tenant_id = $1', [tenant]);
const recollectionsOf = (tenant: string, specimenId: string) => ownerRows('homecollection.visits', 'tenant_id = $1 AND recollection_of_specimen_id = $2', [tenant, specimenId]);
const childrenOf = (tenant: string, parentId: string) => ownerRows('homecollection.visits', 'tenant_id = $1 AND parent_visit_id = $2', [tenant, parentId]);
const flagsOf = (tenant: string, visitId: string, kind?: string) =>
  ownerRows('homecollection.visit_flags', kind ? 'tenant_id = $1 AND visit_id = $2 AND kind = $3' : 'tenant_id = $1 AND visit_id = $2', kind ? [tenant, visitId, kind] : [tenant, visitId]);
const transitionsOf = (tenant: string, visitId: string) => ownerRows('homecollection.visit_transitions', 'tenant_id = $1 AND visit_id = $2', [tenant, visitId]);
const routeOf = async (tenant: string, id: string) => (await ownerRows('homecollection.routes', 'tenant_id = $1 AND id = $2', [tenant, id]))[0];
const jobsCount = (tenant: string) => superTx(async (tx: any) => Number((await tx.query(`SELECT count(*) AS n FROM graphile_worker._private_jobs j WHERE j.payload->>'tenant_id' = $1`, [tenant])).rows[0].n));
const everything = async (tenant: string, visitId: string) =>
  JSON.stringify([await visitById(tenant, visitId), await flagsOf(tenant, visitId), await transitionsOf(tenant, visitId), await vsOf(tenant, visitId)]);

// ------------------------------------------------------------------------------------------------ fixtures
/** A visit on an order (what V2 / H3 / the recollection flow create), optionally assigned on a route. */
async function visitOn(w: World, o: { assigned?: boolean; order?: any; extra?: Record<string, unknown> } = {}) {
  const order = o.order ?? await newOrder(w); let route: any; const extra: Record<string, unknown> = { ...o.extra };
  if (o.assigned) {
    route = hc.route(w.s); await seed('homecollection.routes', route);
    Object.assign(extra, { status: 'assigned', route_id: route.id, route_date: route.route_date, route_sequence: 1, assigned_membership_id: MEMBER[w.s], assigned_at: '2026-11-10T02:00:00Z',
      window_start: '2026-11-11T01:15:00Z', window_end: '2026-11-11T01:45:00Z' });
  }
  const visit = hc.visit(w.s, { patient: w.patient, order }, extra); await seed('homecollection.visits', visit);
  return { visit, order, route };
}

beforeAll(async () => {
  worlds.a = await mkWorld('a'); worlds.b = await mkWorld('b');
  onSpecimenStatusChanged = (await import('../consumers/lab.specimen.status_changed.v1.js')).onSpecimenStatusChanged;
  onSpecimenRejected = (await import('../consumers/lab.specimen.rejected.v1.js')).onSpecimenRejected;
});
afterAll(async () => { await closePools(); });

// ================================================================================================ status_changed
describe('HC-T07 lab.specimen.status_changed.v1 -> visit_specimens read model (US-14-1)', () => {
  it('US-14-1: a status event for a specimen of an order linked to a visit with NO read-model row yet -> one row (order, visit centre, type, status, is_active, last_seq = aggregate.seq); no LabPort call', async () => {
    const w = worlds.a; const { visit, order } = await visitOn(w); const s = await newSpecimen(w, order.id, { specimen_type_code: 'EDTA' });
    const lab = makeLab(); const r = await status(statusEvent(w, s, { seq: 4, to: 'collected', payload: { specimen_type_code: 'EDTA' } }), { lab });
    expect(r.threw).toBeUndefined();
    const rows = await vsOf(w.tenant, visit.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ specimen_id: s.id, order_id: order.id, centre_id: visit.centre_id, specimen_type_code: 'EDTA', status: 'collected', is_active: true, last_seq: 4, replaces_specimen_id: null });
    expect(lab.calls).toHaveLength(0);
  });

  it('US-14-1: an existing row (port refresh, last_seq 0) is updated in place when aggregate.seq is higher: same row id, new status, last_seq = seq; a later higher seq wins again', async () => {
    const w = worlds.a; const { visit, order } = await visitOn(w); const s = await newSpecimen(w, order.id);
    const seeded = hc.visitSpecimen(w.s, { specimen: s, order }, visit.id, { status: 'ordered', last_seq: 0 }); await seed('homecollection.visit_specimens', seeded);
    expect((await status(statusEvent(w, s, { seq: 2, to: 'collected' }))).threw).toBeUndefined();
    let rows = await vsOf(w.tenant, visit.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: seeded.id, status: 'collected', last_seq: 2 });
    await status(statusEvent(w, s, { seq: 3, to: 'received', from: 'in_transit' }));
    rows = await vsOf(w.tenant, visit.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: seeded.id, status: 'received', last_seq: 3 });
  });

  it('stale seq ignored: seq lower than OR equal to the stored last_seq changes nothing (status, last_seq, updated_at, route version) — out-of-order delivery keeps the newest state', async () => {
    const w = worlds.a; const { visit, order, route } = await visitOn(w, { assigned: true }); const s = await newSpecimen(w, order.id);
    await seed('homecollection.visit_specimens', hc.visitSpecimen(w.s, { specimen: s, order }, visit.id, { status: 'received', last_seq: 7 }));
    const snap = await everything(w.tenant, visit.id); const v0 = (await routeOf(w.tenant, route.id)).version;
    for (const seq of [5, 7, 1]) expect((await status(statusEvent(w, s, { seq, to: 'collected' }))).threw, `seq ${seq}`).toBeUndefined();
    expect(await everything(w.tenant, visit.id)).toBe(snap);
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0);
    expect((await status(statusEvent(w, s, { seq: 8, to: 'in_process', from: 'received' }))).threw).toBeUndefined();
    expect((await vsOf(w.tenant, visit.id))[0]).toMatchObject({ status: 'in_process', last_seq: 8 });
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0 + 1);
  });

  it('out of order from nothing: seq 5 (received) then a late seq 2 (collected) -> the row ends received / 5', async () => {
    const w = worlds.a; const { visit, order } = await visitOn(w); const s = await newSpecimen(w, order.id);
    await status(statusEvent(w, s, { seq: 5, to: 'received', from: 'in_transit' }));
    await status(statusEvent(w, s, { seq: 2, to: 'collected' }));
    const rows = await vsOf(w.tenant, visit.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'received', last_seq: 5 });
  });

  it('TRD §4.1 / US-14-1: an applied event on a visit that is on a route bumps that route\'s version by 1; a visit without a route touches no route', async () => {
    const w = worlds.a; const { visit, order, route } = await visitOn(w, { assigned: true }); const s = await newSpecimen(w, order.id); const v0 = (await routeOf(w.tenant, route.id)).version;
    await status(statusEvent(w, s, { seq: 2 }));
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0 + 1);
    expect(await vsOf(w.tenant, visit.id)).toHaveLength(1);
    const { visit: unrouted, order: o2 } = await visitOn(w); const s2 = await newSpecimen(w, o2.id);
    expect((await status(statusEvent(w, s2, { seq: 2 }))).threw).toBeUndefined();
    expect(await vsOf(w.tenant, unrouted.id)).toHaveLength(1);
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0 + 1);
  });

  it('duplicate: the SAME event delivered twice -> one row, last_seq unchanged, the route version bumped once', async () => {
    const w = worlds.a; const { visit, order, route } = await visitOn(w, { assigned: true }); const s = await newSpecimen(w, order.id); const v0 = (await routeOf(w.tenant, route.id)).version;
    const ev = statusEvent(w, s, { seq: 3, to: 'collected' });
    expect((await status(ev)).threw).toBeUndefined();
    expect((await status(ev)).threw).toBeUndefined();
    const rows = await vsOf(w.tenant, visit.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'collected', last_seq: 3 });
    expect((await routeOf(w.tenant, route.id)).version).toBe(v0 + 1);
  });

  it('concurrency: three deliveries of the same event racing -> ONE row, last_seq = seq (losers no-op or fail with 23505/40001/40P01 for a queue retry)', async () => {
    const w = worlds.a; const { visit, order } = await visitOn(w); const s = await newSpecimen(w, order.id); const ev = statusEvent(w, s, { seq: 2 });
    const res = await Promise.all([status(ev), status(ev), status({ ...ev, event_id: uid() })]);
    for (const r of res) if (r.threw) expect(['23505', '40001', '40P01']).toContain(r.threw.code);
    await status(ev);                                                                          // the queue's retry of a lost race
    const rows = await vsOf(w.tenant, visit.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'collected', last_seq: 2 });
  });

  it('every visit of the order gets the update (front_desk visit + its revisit), each with its own row and its own seq check', async () => {
    const w = worlds.a; const { visit: v1, order } = await visitOn(w, { extra: { created_at: ago(2) } });
    const { visit: v2 } = await visitOn(w, { order, extra: { kind: 'revisit', parent_visit_id: v1.id, created_at: ago(1) } });
    const s = await newSpecimen(w, order.id);
    await seed('homecollection.visit_specimens', hc.visitSpecimen(w.s, { specimen: s, order }, v1.id, { status: 'received', last_seq: 9 }));   // v1 already newer
    await status(statusEvent(w, s, { seq: 4, to: 'collected' }));
    expect((await vsOf(w.tenant, v1.id))[0]).toMatchObject({ status: 'received', last_seq: 9 });
    expect((await vsOf(w.tenant, v2.id))[0]).toMatchObject({ specimen_id: s.id, status: 'collected', last_seq: 4 });
  });

  it('replacement specimen (from_status absent + replaces_specimen_id) -> NEW row carrying replaces_specimen_id, the old row stays untouched', async () => {
    const w = worlds.a; const { visit, order } = await visitOn(w); const oldS = await newSpecimen(w, order.id, { status: 'rejected' }); const newS = await newSpecimen(w, order.id);
    const oldRow = hc.visitSpecimen(w.s, { specimen: oldS, order }, visit.id, { status: 'rejected', last_seq: 3, is_active: false }); await seed('homecollection.visit_specimens', oldRow);
    const r = await status(statusEvent(w, newS, { seq: 1, to: 'ordered', from: null, payload: { replaces_specimen_id: oldS.id } }));
    expect(r.threw).toBeUndefined();
    const rows = await vsOf(w.tenant, visit.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.specimen_id === newS.id)).toMatchObject({ replaces_specimen_id: oldS.id, status: 'ordered', is_active: true, last_seq: 1 });
    expect(rows.find((x) => x.specimen_id === oldS.id)).toMatchObject({ id: oldRow.id, status: 'rejected', last_seq: 3, is_active: false });
  });

  it('US-14-2: an event for an order with NO visit stores nothing (inbox only): no read-model row, no visit, no flag, no job, no throw', async () => {
    const w = worlds.a; const order = await newOrder(w); const s = await newSpecimen(w, order.id); const before = (await allVisits(w.tenant)).length; const jobs = await jobsCount(w.tenant);
    const r = await status(statusEvent(w, s, { seq: 2 }));
    expect(r.threw).toBeUndefined();
    expect(await vsOfSpecimen(w.tenant, s.id)).toHaveLength(0);
    expect((await allVisits(w.tenant)).length).toBe(before);
    expect(await jobsCount(w.tenant)).toBe(jobs);
  });

  it('30-day window [CONV]: a visit created 40 days ago is ignored (no row), one created 29 days ago still applies', async () => {
    const w = worlds.a; const { visit: old, order: o1 } = await visitOn(w, { extra: { created_at: ago(40) } }); const s1 = await newSpecimen(w, o1.id);
    expect((await status(statusEvent(w, s1, { seq: 2 }))).threw).toBeUndefined();
    expect(await vsOf(w.tenant, old.id)).toHaveLength(0);
    const { visit: recent, order: o2 } = await visitOn(w, { extra: { created_at: ago(29) } }); const s2 = await newSpecimen(w, o2.id);
    await status(statusEvent(w, s2, { seq: 2 }));
    expect(await vsOf(w.tenant, recent.id)).toHaveLength(1);
  });

  it('any visit status (completed / cancelled / failed) still gets the read-model update (status of the visit does not gate it)', async () => {
    const w = worlds.a; const out: Array<[string, any, any]> = [];
    for (const st of ['completed', 'cancelled', 'failed']) {
      const extra: Record<string, unknown> = st === 'completed' ? { status: st, outcome: 'collected', completed_at: T0 } : st === 'cancelled' ? { status: st, cancelled_at: T0, status_reason_code: 'booking_cancelled' } : { status: st, failed_at: T0 };
      const { visit, order } = await visitOn(w, { extra }); const s = await newSpecimen(w, order.id); out.push([st, visit, s]);
      await status(statusEvent(w, s, { seq: 2 }));
    }
    for (const [st, visit, s] of out) expect((await vsOf(w.tenant, visit.id)).map((x) => x.specimen_id), st).toEqual([s.id]);
  });

  it('PHI / log hygiene (07-SECURITY): no barcode is stored in the read model; the consumer logs neither the barcode nor the patient id', async () => {
    const w = worlds.a; const { visit, order } = await visitOn(w); const s = await newSpecimen(w, order.id);
    const r = await status(statusEvent(w, s, { seq: 2 }));
    expect(JSON.stringify(await vsOf(w.tenant, visit.id))).not.toContain(s.barcode);
    expect(r.logs.join('\n')).not.toContain(s.barcode);
    expect(r.logs.join('\n')).not.toContain(w.patient.id);
  });

  it('tenant isolation: event.tenant_id != ctx.tenantId, or an event of tenant A carrying tenant B\'s order id, writes nothing for either tenant', async () => {
    const a = worlds.a, b = worlds.b; const { visit, order } = await visitOn(b); const s = await newSpecimen(b, order.id); const snap = await everything(b.tenant, visit.id);
    const r1 = await status(statusEvent(b, s, { seq: 2 }), { ctxTenant: a.tenant });                    // tenant B's event under tenant A's context
    expect(r1.threw === undefined || r1.threw).toBeTruthy();
    const forged = statusEvent(a, s, { seq: 3 });                                                        // tenant A's event, tenant B's order + specimen ids
    const r2 = await status(forged);
    expect(r2.threw === undefined || r2.threw).toBeTruthy();
    expect(await everything(b.tenant, visit.id)).toBe(snap);
    expect(await vsOfSpecimen(a.tenant, s.id)).toHaveLength(0);
  });
});

// ================================================================================================ rejected
describe('HC-T07 lab.specimen.rejected.v1 -> recollection visit (US-11-1 / US-11-2)', () => {
  /** A completed home visit V1 with an address + coordinates, and a specimen of its order that lab rejected. */
  async function rejectedWorld(w: World, o: { assigned?: boolean; extra?: Record<string, unknown> } = {}) {
    const v = await visitOn(w, { assigned: o.assigned, extra: { latitude: 27.7172, longitude: 85.324, address_text: 'House 12, Synthetic Tole, Ward 4', landmark: 'Near the blue gate', ...o.extra } });
    const s = await newSpecimen(w, v.order.id, { status: 'rejected' });
    return { ...v, s };
  }

  it('US-11-1: recollection_required + home_visit_id = V1 -> ONE new visit kind recollection (parent V1, same order / patient / centre / branch, address + landmark + coordinates copied, no window, no route, unassigned, recollection_of_specimen_id) + flag recollection_required + transition', async () => {
    const w = worlds.a; const { visit: v1, order, s } = await rejectedWorld(w, { extra: { status: 'completed', outcome: 'collected', completed_at: T0 } });
    const lab = makeLab(); const r = await rejected(rejectedEvent(w, s, { visitId: v1.id }), { lab });
    expect(r.threw).toBeUndefined();
    const rec = await recollectionsOf(w.tenant, s.id);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ kind: 'recollection', status: 'unassigned', parent_visit_id: v1.id, order_id: order.id, patient_id: v1.patient_id, centre_id: v1.centre_id, branch_id: v1.branch_id,
      address_text: 'House 12, Synthetic Tole, Ward 4', landmark: 'Near the blue gate', window_start: null, window_end: null, route_id: null, route_date: null, route_sequence: null, assigned_membership_id: null,
      booking_id: null, is_active: true });
    expect(Number(rec[0].latitude)).toBeCloseTo(27.7172, 4);
    expect(Number(rec[0].longitude)).toBeCloseTo(85.324, 4);
    expect(rec[0].tenant_id).toBe(w.tenant);
    expect(rec[0].created_by).toBe(SYS_ACTOR);
    const fl = await flagsOf(w.tenant, rec[0].id, 'recollection_required');
    expect(fl).toHaveLength(1);
    expect(fl[0].status).toBe('open');
    expect((await transitionsOf(w.tenant, rec[0].id)).filter((t) => t.to_status === 'unassigned' && t.from_status === null)).toHaveLength(1);
    expect(lab.calls).toHaveLength(0);
  });

  it('APP-FLOW V3: the parent visit row and its order are NOT modified (no cancel, no status / version change) and the parent\'s route version is untouched', async () => {
    const w = worlds.a; const { visit: v1, route, s } = await rejectedWorld(w, { assigned: true }); const before = await visitById(w.tenant, v1.id); const rv = (await routeOf(w.tenant, route.id)).version;
    expect((await rejected(rejectedEvent(w, s, { visitId: v1.id }))).threw).toBeUndefined();
    expect(await visitById(w.tenant, v1.id)).toEqual(before);
    expect((await routeOf(w.tenant, route.id)).version).toBe(rv);
    expect(await recollectionsOf(w.tenant, s.id)).toHaveLength(1);
  });

  it('US-11-1 via the order: no home_visit_id -> parent = the LATEST (created_at) visit of order_id', async () => {
    const w = worlds.a; const { visit: older, order } = await visitOn(w, { extra: { latitude: null, longitude: null, created_at: ago(5) } });
    const { visit: newer } = await visitOn(w, { order, extra: { kind: 'revisit', parent_visit_id: older.id, created_at: ago(1) } });
    const s = await newSpecimen(w, order.id, { status: 'rejected' });
    expect((await rejected(rejectedEvent(w, s))).threw).toBeUndefined();
    const rec = await recollectionsOf(w.tenant, s.id);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ parent_visit_id: newer.id, order_id: order.id, kind: 'recollection', status: 'unassigned' });
  });

  it('recollection idempotent per specimen: the SAME event twice, and the same specimen under a NEW event_id -> still one visit, one open flag, one transition (unique (tenant, recollection_of_specimen_id))', async () => {
    const w = worlds.a; const { visit: v1, s } = await rejectedWorld(w); const ev = rejectedEvent(w, s, { visitId: v1.id });
    expect((await rejected(ev)).threw).toBeUndefined();
    expect((await rejected(ev)).threw).toBeUndefined();
    const again = await rejected({ ...ev, event_id: uid() });
    expect(again.threw === undefined || again.threw).toBeTruthy();                                // no-op, or 23505 retried by the queue
    const rec = await recollectionsOf(w.tenant, s.id);
    expect(rec).toHaveLength(1);
    expect(await flagsOf(w.tenant, rec[0].id, 'recollection_required')).toHaveLength(1);
    expect((await transitionsOf(w.tenant, rec[0].id)).filter((t) => t.from_status === null)).toHaveLength(1);
    expect(await childrenOf(w.tenant, v1.id)).toHaveLength(1);
  });

  it('idempotency is PER SPECIMEN: two different rejected specimens of the same visit -> two recollection visits, each with its own flag', async () => {
    const w = worlds.a; const { visit: v1, order, s } = await rejectedWorld(w); const s2 = await newSpecimen(w, order.id, { status: 'rejected' });
    await rejected(rejectedEvent(w, s, { visitId: v1.id }));
    await rejected(rejectedEvent(w, s2, { visitId: v1.id }));
    const a = await recollectionsOf(w.tenant, s.id); const b = await recollectionsOf(w.tenant, s2.id);
    expect(a).toHaveLength(1); expect(b).toHaveLength(1);
    expect(a[0].id).not.toBe(b[0].id);
    expect(await childrenOf(w.tenant, v1.id)).toHaveLength(2);
    expect(await flagsOf(w.tenant, a[0].id, 'recollection_required')).toHaveLength(1);
    expect(await flagsOf(w.tenant, b[0].id, 'recollection_required')).toHaveLength(1);
  });

  it('concurrency: three deliveries racing on the same rejected specimen end with ONE recollection visit and ONE flag (losers no-op or fail with 23505/40001/40P01 for a queue retry)', async () => {
    const w = worlds.a; const { visit: v1, s } = await rejectedWorld(w); const ev = rejectedEvent(w, s, { visitId: v1.id });
    const res = await Promise.all([rejected(ev), rejected(ev), rejected({ ...ev, event_id: uid() })]);
    for (const r of res) if (r.threw) expect(['23505', '40001', '40P01']).toContain(r.threw.code);
    await rejected(ev);                                                                          // the queue's retry of a lost race
    const rec = await recollectionsOf(w.tenant, s.id);
    expect(rec).toHaveLength(1);
    expect(await flagsOf(w.tenant, rec[0].id, 'recollection_required')).toHaveLength(1);
  });

  it('US-11-2: recollection_required false -> NO visit, NO flag, no job, parent untouched; only the read model moves, and that is the status_changed event (to_status rejected) which creates no visit', async () => {
    const w = worlds.a; const { visit: v1, order, s } = await rejectedWorld(w); const snap = await everything(w.tenant, v1.id); const before = (await allVisits(w.tenant)).length; const jobs = await jobsCount(w.tenant);
    expect((await rejected(rejectedEvent(w, s, { visitId: v1.id, recollection: false }))).threw).toBeUndefined();
    expect(await recollectionsOf(w.tenant, s.id)).toHaveLength(0);
    expect((await allVisits(w.tenant)).length).toBe(before);
    expect(await everything(w.tenant, v1.id)).toBe(snap);
    expect(await jobsCount(w.tenant)).toBe(jobs);
    expect((await status(statusEvent(w, s, { seq: 3, to: 'rejected', from: 'received' }))).threw).toBeUndefined();     // the read-model change
    expect((await vsOf(w.tenant, v1.id))[0]).toMatchObject({ specimen_id: s.id, order_id: order.id, status: 'rejected', last_seq: 3 });
    expect((await allVisits(w.tenant)).length).toBe(before);
    expect(await flagsOf(w.tenant, v1.id, 'recollection_required')).toHaveLength(0);
  });

  it('no-visit order ignored: recollection_required for an order with NO visit (and no / unknown home_visit_id) creates nothing and does not throw', async () => {
    const w = worlds.a; const order = await newOrder(w); const s = await newSpecimen(w, order.id, { status: 'rejected' }); const before = (await allVisits(w.tenant)).length;
    expect((await rejected(rejectedEvent(w, s))).threw).toBeUndefined();
    expect((await rejected(rejectedEvent(w, s, { visitId: uid() }))).threw === undefined || true).toBeTruthy();   // unknown home_visit_id: no-op (or retried), never a visit
    expect(await recollectionsOf(w.tenant, s.id)).toHaveLength(0);
    expect((await allVisits(w.tenant)).length).toBe(before);
  });

  it('guard: a home_visit_id that belongs to ANOTHER order is never used as the parent (that visit gets no child and is not modified)', async () => {
    const w = worlds.a; const { visit: foreign } = await visitOn(w); const { order, s } = await rejectedWorld(w); const snap = await everything(w.tenant, foreign.id);
    const r = await rejected(rejectedEvent(w, s, { visitId: foreign.id }));
    expect(r.threw === undefined || r.threw).toBeTruthy();
    expect(await childrenOf(w.tenant, foreign.id)).toHaveLength(0);
    expect(await everything(w.tenant, foreign.id)).toBe(snap);
    for (const rec of await recollectionsOf(w.tenant, s.id)) expect(rec.order_id).toBe(order.id);
  });

  it('tenant isolation: event.tenant_id != ctx.tenantId, or a tenant A event naming tenant B\'s home_visit_id / order, creates nothing and never touches B\'s visits', async () => {
    const a = worlds.a, b = worlds.b; const { visit: vB, s: sB } = await rejectedWorld(b); const snap = await everything(b.tenant, vB.id); const before = [(await allVisits(a.tenant)).length, (await allVisits(b.tenant)).length];
    const r1 = await rejected(rejectedEvent(b, sB, { visitId: vB.id }), { ctxTenant: a.tenant });        // B's event under A's context
    expect(r1.threw === undefined || r1.threw).toBeTruthy();
    const r2 = await rejected(rejectedEvent(a, sB, { visitId: vB.id }));                                 // A's event carrying B's ids (RLS hides B's visit)
    expect(r2.threw === undefined || r2.threw).toBeTruthy();
    expect(await recollectionsOf(b.tenant, sB.id)).toHaveLength(0);
    expect(await recollectionsOf(a.tenant, sB.id)).toHaveLength(0);
    expect(await childrenOf(b.tenant, vB.id)).toHaveLength(0);
    expect(await everything(b.tenant, vB.id)).toBe(snap);
    expect([(await allVisits(a.tenant)).length, (await allVisits(b.tenant)).length]).toEqual(before);
  });

  it('log hygiene (07-SECURITY): the consumer logs no patient id (P3), no barcode and no address text', async () => {
    const w = worlds.a; const { visit: v1, s } = await rejectedWorld(w); const r = await rejected(rejectedEvent(w, s, { visitId: v1.id }));
    const log = r.logs.join('\n');
    expect(log).not.toContain(w.patient.id);
    expect(log).not.toContain(s.barcode);
    expect(log).not.toContain('Synthetic Tole');
  });
});

describe('HC-T07 brief files', () => {
  it('the two consumer files named by the brief (consumers/lab.specimen.*) exist', () => {
    const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
    expect(existsSync(here('../consumers/lab.specimen.status_changed.v1.ts'))).toBe(true);
    expect(existsSync(here('../consumers/lab.specimen.rejected.v1.ts'))).toBe(true);
  });
});
