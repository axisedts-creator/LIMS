// HC-T16 task homecollection.sweep_missed_visits (daily 00:20 Asia/Kathmandu, per_tenant; 02-TRD §10, 03-APP-FLOW V7 + E15, 01-PRD US-15-1/2, 08 A19 D-126, 08 A13 P-15 business date).
// Live PG17 (tests/homecollection/HC-T16.pg.sh). Harness: hc16.helpers.ts (lims_worker tx under the SYSTEM actor's claims, FAKE CLOCK via ctx.now()). Missing env = HARD FAILURE.
// ASSUMED (spec silent; the implementer disputes if wrong):
//  - file tasks/sweep_missed_visits.ts exports `sweepMissedVisits` (TaskHandler, payload {tenant_id}); payload.tenant_id must equal ctx.tenantId, else a no-op that resolves.
//  - "today" = ctx.now() as an Asia/Kathmandu calendar date (UTC+05:45); a visit is swept when visit.route_date < today. "pulled" = route.last_snapshot_at falls on route_date in Asia/Kathmandu.
//  - unpulled -> visit status unassigned, route_id/route_date/route_sequence/assigned_membership_id NULL, order_id kept, version++; ONE visit_assignments row action 'missed' (route_id = old route, route_date = old date);
//    ONE visit_transitions row assigned -> unassigned cause 'cron'; ONE open flag `missed` (visit's centre); the OLD route's version++.
//  - pulled -> visit untouched (same version/status/route), ONE open flag `missed`, NO visit_assignments 'missed' row, NO transition.
//  - an `assigned` visit with an applied collection but an unpulled route is treated like pulled (V7 guard "no applied mutation").
//  - re-run adds nothing (flag ON CONFLICT DO NOTHING; a swept visit is no longer assigned). Bad payload / foreign tenant payload: resolves, writes nothing.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TENANT_A, TENANT_B, closePools, kathmandu, makeCtx, runTask, uid, workerTx } from './hc16.helpers.js';
import { HC_CENTRE, MEMBER, assignedVisit, assignmentsOf, collectedVisit, flagsOf, hc, newRoute, nextDate, routeOf, seed, transitionsOf, visitOf } from './hc16.fixtures.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
let sweepMissedVisits: (payload: any, ctx: any) => Promise<void>;
beforeAll(async () => { sweepMissedVisits = (await import('../tasks/sweep_missed_visits.js')).sweepMissedVisits; });
afterAll(async () => { await closePools(); });

/** node-pg parses `date` columns as a local-midnight JS Date (HC-T16 ruling item 3): format local Y-M-D */
const ymd = (d: unknown) => d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10);
/** the 00:20 Kathmandu run of the day after `date` */
const dayAfter = (date: string) => kathmandu(date, '00:20', 1);
const sweep = (now: string, tenant: string = TENANT_A, payload: unknown = { tenant_id: tenant }) => runTask(sweepMissedVisits, payload, tenant, { now });
const missed = (id: string) => flagsOf(id, 'missed');

describe('US-15-1: assigned visit, route date before today, route never pulled -> back to unassigned + flag missed', () => {
  it('the visit returns to unassigned (order kept, route fields cleared, version++), one `missed` assignment row, one `cron` transition, one open `missed` flag, old route version++', async () => {
    const date = nextDate(); const route = await newRoute('a', date); const { visit } = await assignedVisit('a', route);
    const before = await visitOf(visit.id); const rv = Number((await routeOf(route.id)).version);
    const r = await sweep(dayAfter(date));
    expect(r.threw).toBeUndefined();
    const v = await visitOf(visit.id);
    expect(v).toMatchObject({ status: 'unassigned', route_id: null, route_date: null, route_sequence: null, assigned_membership_id: null, order_id: visit.order_id });
    expect(Number(v.version)).toBeGreaterThan(Number(before.version));
    const asg = (await assignmentsOf(visit.id)).filter((a: any) => a.action === 'missed');
    expect(asg).toHaveLength(1);
    expect(asg[0]).toMatchObject({ route_id: route.id, centre_id: HC_CENTRE.a, tenant_id: TENANT_A });
    expect(ymd(asg[0].route_date)).toBe(date);
    const tr = (await transitionsOf(visit.id)).filter((t: any) => t.to_status === 'unassigned');
    expect(tr.map((t: any) => [t.from_status, t.cause])).toEqual([['assigned', 'cron']]);
    const f = await missed(visit.id);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'missed', status: 'open', centre_id: HC_CENTRE.a, tenant_id: TENANT_A });
    expect(Number((await routeOf(route.id)).version)).toBeGreaterThan(rv);
  });
  it('idempotent: running the same sweep again changes nothing (no second assignment row, transition, flag or version bump)', async () => {
    const date = nextDate(); const route = await newRoute('a', date); const { visit } = await assignedVisit('a', route);
    expect((await sweep(dayAfter(date))).threw).toBeUndefined();
    const snap = async () => JSON.stringify([await visitOf(visit.id), await assignmentsOf(visit.id), await transitionsOf(visit.id), await missed(visit.id), (await routeOf(route.id)).version]);
    const first = await snap();
    expect((await sweep(dayAfter(date))).threw).toBeUndefined();
    expect((await sweep(dayAfter(date))).threw).toBeUndefined();
    expect(await snap()).toBe(first);
  });
  it('several visits of one unpulled route are all returned; a visit of another unpulled route too', async () => {
    const date = nextDate(); const route = await newRoute('a', date);
    const vs = [await assignedVisit('a', route, { route_sequence: 1 }), await assignedVisit('a', route, { route_sequence: 2 })];
    expect((await sweep(dayAfter(date))).threw).toBeUndefined();
    for (const { visit } of vs) { expect((await visitOf(visit.id)).status).toBe('unassigned'); expect(await missed(visit.id)).toHaveLength(1); }
  });
});

describe('US-15-2 / D-126 / E15: the route was pulled on its route date (a phone holds the visit) -> stays assigned, only flag missed', () => {
  it('last_snapshot_at on the route date: visit untouched (status, route, version), one open `missed` flag, no `missed` assignment row, no transition', async () => {
    const date = nextDate(); const route = await newRoute('a', date, { last_snapshot_at: kathmandu(date, '09:30') }); const { visit } = await assignedVisit('a', route);
    const before = await visitOf(visit.id); const trBefore = (await transitionsOf(visit.id)).length;
    expect((await sweep(dayAfter(date))).threw).toBeUndefined();
    const v = await visitOf(visit.id);
    expect(v).toMatchObject({ status: 'assigned', route_id: route.id, assigned_membership_id: route.phlebotomist_membership_id });
    expect(Number(v.version)).toBe(Number(before.version));
    expect(ymd(v.route_date)).toBe(date);
    const f = await missed(visit.id);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ status: 'open', centre_id: HC_CENTRE.a });
    expect((await assignmentsOf(visit.id)).filter((a: any) => a.action === 'missed')).toEqual([]);
    expect((await transitionsOf(visit.id)).length).toBe(trBefore);
  });
  it('the pulled-check uses the Kathmandu business date: a pull at 00:10 on the route date (= 18:25Z the day before) and one at 23:50 (= 18:05Z on the date) both count as pulled', async () => {
    for (const hhmm of ['00:10', '23:50']) {
      const date = nextDate(); const route = await newRoute('a', date, { last_snapshot_at: kathmandu(date, hhmm) }); const { visit } = await assignedVisit('a', route);
      expect((await sweep(dayAfter(date))).threw).toBeUndefined();
      expect((await visitOf(visit.id)).status, hhmm).toBe('assigned');
      expect(await missed(visit.id), hhmm).toHaveLength(1);
    }
  });
  it('a pull on the day BEFORE the route date (or the day after, e.g. the sweep day) is not "pulled on its route date" -> swept like an unpulled route', async () => {
    for (const snap of [(d: string) => kathmandu(d, '23:30', -1), (d: string) => kathmandu(d, '00:05', 1)]) {
      const date = nextDate(); const route = await newRoute('a', date, { last_snapshot_at: snap(date) }); const { visit } = await assignedVisit('a', route);
      expect((await sweep(kathmandu(date, '12:00', 1))).threw).toBeUndefined();
      expect((await visitOf(visit.id)).status).toBe('unassigned');
    }
  });
  it('re-run: the flag is not duplicated and the visit stays assigned', async () => {
    const date = nextDate(); const route = await newRoute('a', date, { last_snapshot_at: kathmandu(date, '09:30') }); const { visit } = await assignedVisit('a', route);
    for (let i = 0; i < 3; i++) expect((await sweep(dayAfter(date))).threw).toBeUndefined();
    expect(await missed(visit.id)).toHaveLength(1);
    expect((await visitOf(visit.id)).status).toBe('assigned');
  });
  it('a RESOLVED earlier `missed` flag does not block a new open one (open-flag unique index)', async () => {
    const date = nextDate(); const route = await newRoute('a', date, { last_snapshot_at: kathmandu(date, '09:30') }); const { visit } = await assignedVisit('a', route);
    await seed('homecollection.visit_flags', hc.flag('a', visit.id, { kind: 'missed', related_id: null, status: 'resolved', resolved_at: '2026-11-12T00:00:00Z', resolved_by: MEMBER.a, resolution_code: 'other' }));
    expect((await sweep(dayAfter(date))).threw).toBeUndefined();
    expect((await missed(visit.id)).map((f: any) => f.status).sort()).toEqual(['open', 'resolved']);
  });
  it('(V7 guard, ASSUMED) an unpulled route whose visit already has an applied collection is NOT unassigned: flag missed only', async () => {
    const date = nextDate(); const route = await newRoute('a', date);
    const c = await collectedVisit('a', kathmandu(date, '08:00'), { visit: { status: 'assigned', outcome: null, completed_at: null, route_id: route.id, route_date: date, route_sequence: 1, assigned_membership_id: route.phlebotomist_membership_id } });
    expect((await sweep(dayAfter(date))).threw).toBeUndefined();
    expect((await visitOf(c.visit.id)).status).toBe('assigned');
    expect(await missed(c.visit.id)).toHaveLength(1);
  });
});

describe('which visits the sweep leaves alone (business date P-15)', () => {
  it('route_date == today (Kathmandu) or later: untouched, even when the UTC date already moved on; 00:20 on the route date itself is still "today"', async () => {
    const date = nextDate(); const route = await newRoute('a', date); const { visit } = await assignedVisit('a', route);
    // 23:59 Kathmandu on the route date = 18:14Z same UTC date; 00:20 on the date = 18:35Z the day before: both are "today" = route date
    for (const now of [kathmandu(date, '00:20'), kathmandu(date, '23:59')]) expect((await sweep(now)).threw).toBeUndefined();
    const v = await visitOf(visit.id);
    expect(v).toMatchObject({ status: 'assigned', route_id: route.id });
    expect(await missed(visit.id)).toEqual([]);
  });
  it('the first Kathmandu minute after the route date (00:00 = 18:15Z) is "tomorrow": the visit IS swept even though the UTC date is still the route date', async () => {
    const date = nextDate(); const route = await newRoute('a', date); const { visit } = await assignedVisit('a', route);
    expect((await sweep(kathmandu(date, '00:00', 1))).threw).toBeUndefined();
    expect((await visitOf(visit.id)).status).toBe('unassigned');
  });
  it('visits that are not `assigned` are untouched even with a past route date: in_progress (arrived), completed, unassigned', async () => {
    const date = nextDate(); const route = await newRoute('a', date);
    const inProg = await assignedVisit('a', route, { status: 'in_progress', arrived_at: kathmandu(date, '06:00') });
    const done = await collectedVisit('a', kathmandu(date, '07:00'));
    const un = await assignedVisit('a', route, { status: 'unassigned', route_id: null, route_date: null, route_sequence: null, assigned_membership_id: null, assigned_at: null });
    expect((await sweep(dayAfter(date))).threw).toBeUndefined();
    expect((await visitOf(inProg.visit.id)).status).toBe('in_progress');
    expect((await visitOf(done.visit.id)).status).toBe('completed');
    expect((await visitOf(un.visit.id)).status).toBe('unassigned');
    for (const id of [inProg.visit.id, done.visit.id, un.visit.id]) expect(await missed(id)).toEqual([]);
  });
});

describe('guards: tenant, payload, clock, RLS', () => {
  it('tenant isolation: a sweep for tenant A leaves tenant B\'s overdue assigned visit untouched (same fake clock)', async () => {
    const date = nextDate(); const rb = await newRoute('b', date); const b = await assignedVisit('b', rb);
    const ra = await newRoute('a', date); const a = await assignedVisit('a', ra);
    expect((await sweep(dayAfter(date))).threw).toBeUndefined();
    expect((await visitOf(a.visit.id)).status).toBe('unassigned');
    expect(await visitOf(b.visit.id)).toMatchObject({ status: 'assigned', route_id: rb.id });
    expect(await missed(b.visit.id)).toEqual([]);
    expect((await sweep(dayAfter(date), TENANT_B)).threw).toBeUndefined();   // and B's own sweep handles B
    expect((await visitOf(b.visit.id)).status).toBe('unassigned');
  });
  it('payload.tenant_id different from ctx.tenantId -> no-op (nothing written); malformed payloads resolve and write nothing', async () => {
    const date = nextDate(); const route = await newRoute('a', date); const { visit } = await assignedVisit('a', route);
    for (const p of [{ tenant_id: TENANT_B }, {}, null, 'x', { tenant_id: 'not-a-uuid' }, { tenant_id: uid() }])
      expect((await sweep(dayAfter(date), TENANT_A, p)).threw, JSON.stringify(p)).toBeUndefined();
    expect(await visitOf(visit.id)).toMatchObject({ status: 'assigned', route_id: route.id });
    expect(await missed(visit.id)).toEqual([]);
  });
  it('the task is atomic with its delivery: a failure after the first visit rolls the whole delivery back (nothing half-swept)', async () => {
    const date = nextDate(); const route = await newRoute('a', date); const { visit } = await assignedVisit('a', route);
    let threw: unknown;
    try {
      await workerTx(TENANT_A, async (tx: any) => {
        await sweepMissedVisits({ tenant_id: TENANT_A }, makeCtx(tx, TENANT_A, { now: dayAfter(date) }));
        throw new Error('simulated failure after the task body (the queue would retry the delivery)');
      });
    } catch (e) { threw = e; }
    expect(String(threw)).toContain('simulated failure');
    expect(await visitOf(visit.id)).toMatchObject({ status: 'assigned', route_id: route.id });
    expect(await missed(visit.id)).toEqual([]);
    expect((await sweep(dayAfter(date))).threw).toBeUndefined();            // retry succeeds
    expect((await visitOf(visit.id)).status).toBe('unassigned');
  });
});
