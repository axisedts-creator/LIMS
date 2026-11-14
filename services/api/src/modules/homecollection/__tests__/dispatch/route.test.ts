// HC-T09 / H11 resequenceHomeRoute (02-TRD §5.1 H11 + §5 rule 4; PRD US-04-1, US-04-2, US-04-3; TRD §4.1 route version rule). Real PG17 tx, helpers.ts harness. Fails now: H11 is the HC-T01 stub.
// Dates: this file owns routes 2028-01-01 .. (HC-T03's per-file default routes live at 2027-07-20 + hash offsets; assign.test.ts owns 2027-04-01 .. 2027-06-30, schedule 2028-03-01, revisit 2028-05-01).
import { describe, expect, it } from 'vitest';
import { DISPATCHER, DISPATCHER_B, HC_CENTRE, MEMBER, NOBODY, PHLEBO, T, assignedVisit, day, dop, failure, hdr, req, resequence, responseErrors, routeFor, routeRow, schedule, staffName, uid, visitRow, visitsOnRoute } from './helpers.js';
import { listRoutes } from '../visits/helpers.js';

const BASE = '2028-01-01';   // one 2028 block per file of this task: routes are unique per centre + phlebotomist + date and files run in parallel on one DB
let n = 0;
const D = (): string => day(BASE, n++);

/** a route with `k` active visits at sequence 1..k (ids in sequence order) + optionally a completed and a cancelled visit that must never be part of the sequence set */
async function routeWith(k: number, o: { closed?: boolean } = {}) {
  const date = D(); const route = await routeFor(MEMBER.a, date); const ids: string[] = [];
  for (let i = 1; i <= k; i++) ids.push((await assignedVisit({ date, route, seq: i })).visit.id);
  if (o.closed) { await assignedVisit({ date, route, seq: k + 1, status: 'completed' }); await assignedVisit({ date, route, seq: k + 2, status: 'cancelled' }); }
  return { date, route, ids, version: (await routeRow(route.id)).version as number };
}
const unchanged = async (r: { route: any; ids: string[]; version: number }) => {
  expect((await routeRow(r.route.id)).version).toBe(r.version);
  const rows = await visitsOnRoute(r.route.id);
  expect(rows.filter((x) => r.ids.includes(x.id)).sort((a, b) => a.route_sequence - b.route_sequence).map((x) => x.id)).toEqual(r.ids);
};

describe('US-04-1 resequence: [v3, v1, v2, v5, v4] -> route_sequence 1..5 in that order, route version +1', () => {
  it('stores the order, bumps the version once, answers a valid RouteDto, and the board (H10) shows the new order', { timeout: T }, async () => {
    const r = await routeWith(5, { closed: true }); const [v1, v2, v3, v4, v5] = r.ids as [string, string, string, string, string];
    const order = [v3, v1, v2, v5, v4];
    const res = await resequence({ routeId: r.route.id, visitIds: order, version: r.version });
    expect(res.status).toBe(200);
    expect(responseErrors('resequenceHomeRoute', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ id: r.route.id, version: r.version + 1, centre_id: HC_CENTRE.a, route_date: r.date, active_visits: 5, completed_visits: 1,
      phlebotomist: { membership_id: MEMBER.a, display_name: staffName(MEMBER.a) } });
    expect(res.body.visit_ids_in_order.slice(0, 5)).toEqual(order);
    const rows = await visitsOnRoute(r.route.id);
    for (const [i, id] of order.entries()) expect(rows.find((x) => x.id === id)!.route_sequence, `sequence of ${id}`).toBe(i + 1);
    expect((await routeRow(r.route.id)).version).toBe(r.version + 1);
    for (const id of order) expect((await visitRow(id)).status).toBe('assigned');           // sequencing changes the order only
    const board = await listRoutes({ route_date: r.date, centre_id: HC_CENTRE.a });
    expect(board.body.data.find((x: any) => x.id === r.route.id).visit_ids_in_order.slice(0, 5)).toEqual(order);
  });
  it('the visits themselves are bumped too (each moved visit changes, so the phone sees it): visit version +1 for the visits whose sequence changed', { timeout: T }, async () => {
    const r = await routeWith(3); const [a, b, c] = r.ids as [string, string, string];
    const before = await Promise.all(r.ids.map(async (id) => (await visitRow(id)).version as number));
    await resequence({ routeId: r.route.id, visitIds: [c, b, a], version: r.version });
    const after = await Promise.all(r.ids.map(async (id) => (await visitRow(id)).version as number));
    expect(after[0]).toBe(before[0]! + 1);       // a: 1 -> 3
    expect(after[2]).toBe(before[2]! + 1);       // c: 3 -> 1
    expect(after[1]).toBeGreaterThanOrEqual(before[1]!);   // b stays at 2
  });
  it('one visit and sixty visits (the limits 1..60 of TRD H11) work', { timeout: 180_000 }, async () => {
    const one = await routeWith(1);
    expect((await resequence({ routeId: one.route.id, visitIds: one.ids, version: one.version })).status).toBe(200);
    const date = D(); const route = await routeFor(MEMBER.a, date); const ids: string[] = [];
    for (let i = 1; i <= 60; i++) ids.push((await assignedVisit({ date, route, seq: i })).visit.id);
    const version = (await routeRow(route.id)).version;
    const res = await resequence({ routeId: route.id, visitIds: [...ids].reverse(), version });
    expect(res.status).toBe(200);
    expect(res.body.visit_ids_in_order).toEqual([...ids].reverse());
  });
});

describe('US-04-2: the list must be exactly the route\'s active visits -> else 400 common.validation_failed (and nothing changes)', () => {
  it('a visit missing from the list', { timeout: T }, async () => {
    const r = await routeWith(4);
    const e = await failure(resequence({ routeId: r.route.id, visitIds: r.ids.slice(1), version: r.version }));
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    await unchanged(r);
  });
  it('a closed (completed / cancelled) visit of the route in the list: it is not an active visit', { timeout: T }, async () => {
    const r = await routeWith(3, { closed: true });
    const all = (await visitsOnRoute(r.route.id)).map((x) => x.id);
    const e = await failure(resequence({ routeId: r.route.id, visitIds: all, version: r.version }));
    expect(e.code).toBe('common.validation_failed');
    await unchanged(r);
  });
  it('a visit of ANOTHER route (same tenant) in the list: 400 (not in the set) or 404 (not part of this request scope), never applied', { timeout: T }, async () => {
    const r = await routeWith(2); const other = await routeWith(1);
    const e = await failure(resequence({ routeId: r.route.id, visitIds: [...r.ids, other.ids[0]!], version: r.version }));
    expect(e.code).toMatch(/^common\.(validation_failed|not_found)$/);
    await unchanged(r); await unchanged(other);
  });
  it('an unknown id or ANOTHER TENANT\'s visit id: 404 common.not_found for the whole request (sets are exact-match, TRD §5 rule 4)', { timeout: T }, async () => {
    const r = await routeWith(2); const foreign = (await assignedVisit({ date: D() }, 'b')).visit.id;
    for (const bad of [uid(), foreign]) {
      const e = await failure(resequence({ routeId: r.route.id, visitIds: [...r.ids, bad], version: r.version }));
      expect(e.code).toBe('common.not_found');
      expect(e.statusCode).toBe(404);
    }
    await unchanged(r);
  });
  it.each<[string, (ids: string[]) => unknown]>([
    ['duplicate ids', (ids) => [ids[0], ids[0], ids[1]]],
    ['empty list', () => []],
    ['61 ids', () => Array.from({ length: 61 }, () => uid())],
    ['not a uuid', (ids) => [ids[0], "x'; DROP TABLE homecollection.visits;--"]],
    ['not an array', (ids) => ({ 0: ids[0] })],
    ['null', () => null],
    ['numbers', () => [1, 2]],
  ])('%s', { timeout: T }, async (_n, mk) => {
    const r = await routeWith(3);
    const e = await failure(resequence({ routeId: r.route.id, visitIds: mk(r.ids), version: r.version }));
    expect(e.code).toBe('common.validation_failed');
    await unchanged(r);
    expect(JSON.stringify(e.errors ?? [])).not.toContain('DROP TABLE');
  });
  it('an unknown body field (route_id, tenant_id) is a 400 as well', { timeout: T }, async () => {
    const r = await routeWith(2);
    const e = await failure(dop('resequenceHomeRoute', req({ params: { route_id: r.route.id }, headers: hdr(r.version, null), body: { visit_ids: r.ids, tenant_id: uid() } }), DISPATCHER));
    expect(e.code).toBe('common.validation_failed');
    await unchanged(r);
  });
});

describe('route version, concurrency, security', () => {
  it('stale If-Match -> 409 common.version_conflict; missing -> 428 common.precondition_required; nothing changes', { timeout: T }, async () => {
    const r = await routeWith(2);
    expect((await failure(resequence({ routeId: r.route.id, visitIds: [...r.ids].reverse(), version: r.version + 4 }))).code).toBe('common.version_conflict');
    expect((await failure(resequence({ routeId: r.route.id, visitIds: [...r.ids].reverse(), version: r.version, headers: {} }))).code).toBe('common.precondition_required');
    await unchanged(r);
  });
  it('a concurrent change that bumped the route (H5 on one of its visits) makes the sequence call stale: 409, the dispatcher reloads', { timeout: T }, async () => {
    const r = await routeWith(2);
    const v = await visitRow(r.ids[0]!);
    await schedule({ visitId: v.id, version: v.version, body: { window_start: '2026-11-12T04:00:00Z', window_end: '2026-11-12T04:30:00Z' } });
    const e = await failure(resequence({ routeId: r.route.id, visitIds: [...r.ids].reverse(), version: r.version }));
    expect(e.code).toBe('common.version_conflict');
  });
  it('two dispatchers sequencing the same route version at once: one 200, one 409 common.version_conflict; the stored order is one of the two, whole', { timeout: T }, async () => {
    const r = await routeWith(4); const asc = r.ids; const desc = [...r.ids].reverse();
    const res = await Promise.allSettled([asc.slice(1).concat(asc[0]!), desc].map((order) => resequence({ routeId: r.route.id, visitIds: order, version: r.version })));
    expect(res.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect((res.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('common.version_conflict');
    const rows = (await visitsOnRoute(r.route.id)).sort((a, b) => a.route_sequence - b.route_sequence);
    expect(rows.map((x) => x.route_sequence)).toEqual([1, 2, 3, 4]);
    expect(await routeRow(r.route.id)).toMatchObject({ version: r.version + 1 });
  });
  it.each([['phlebotomist (sync.upload only)', PHLEBO], ['no grants', NOBODY]])('403 auth.forbidden without homecollection.visit.assign: %s', { timeout: T }, async (_n, who) => {
    const r = await routeWith(2);
    const e = await failure(resequence({ routeId: r.route.id, visitIds: [...r.ids].reverse(), version: r.version, who }));
    expect(e.code).toBe('auth.forbidden');
    await unchanged(r);
  });
  it.each([[false], [true]])("another tenant's route is invisible: 404 common.not_found (RLS %s)", { timeout: T }, async (bypass) => {
    const r = await routeWith(2);
    const e = await failure(dop('resequenceHomeRoute', req({ params: { route_id: r.route.id }, headers: hdr(r.version, null), body: { visit_ids: [...r.ids].reverse() } }), DISPATCHER_B, { bypassRls: bypass }));
    expect(e.code).toBe('common.not_found');
    await unchanged(r);
  });
  it('a route id that is not a uuid -> 400; an unknown one -> 404', { timeout: T }, async () => {
    expect((await failure(resequence({ routeId: "1' OR '1'='1", visitIds: [uid()], version: 1 }))).code).toBe('common.validation_failed');
    expect((await failure(resequence({ routeId: uid(), visitIds: [uid()], version: 1 }))).code).toBe('common.not_found');
  });
  it('a route of the SAME tenant but another phlebotomist is still sequenced by any dispatcher (route scope = tenant + centre, not the caller)', { timeout: T }, async () => {
    const date = D(); const route = await routeFor(MEMBER.a, date, HC_CENTRE.a);
    const ids = [(await assignedVisit({ date, route, seq: 1 })).visit.id, (await assignedVisit({ date, route, seq: 2 })).visit.id];
    const res = await resequence({ routeId: route.id, visitIds: [...ids].reverse(), version: (await routeRow(route.id)).version });
    expect(res.status).toBe(200);
  });
});
