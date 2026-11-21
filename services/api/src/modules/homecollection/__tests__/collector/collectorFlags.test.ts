// T0B-SALES-1 done_when (4): collector flags Allow Collection / Allow Pickup (homecollection.collector_flags; absent row = both true, so existing behaviour is unchanged).
// updateCollectorFlags PATCH /v1/homecollection/phlebotomists/{membership_id} (homecollection.settings.manage); listEligiblePhlebotomists items carry both flags;
// a collector without allow_collection is never put on a home collection route (assignHomeVisit refuses). Real PG17, RLS on. Synthetic data only.
// PINS (T0B-SALES-1-tests.md): H12 OMITS a collector with allow_collection=false and lists allow_pickup=false collectors with allow_pickup:false (pickup assignment UIs filter on it);
// assignHomeVisit refuses allow_collection=false with common.validation_failed /phlebotomist_membership_id; allow_pickup=false does not block a home visit.
// Dates: this file owns 2027-07-01 .. 2027-07-31. Fails now: updateCollectorFlags is pending, H12 shows no flags, assign ignores them.
import { describe, expect, it } from 'vitest';
import { DISPATCHER, DISPATCHER_B, HC_CENTRE, MEMBER, P, ROSTER, T, TENANT_A, TENANT_B, assign, bookingVisit, day, dop, failure, newOrder, ownerRows, req, responseErrors, routesOf, seed, uid, visitRow, as, type Who } from '../dispatch/helpers.js';
import { listPhlebos } from '../visits/helpers.js';
import { manifest } from '../../index.js';

const FLAGS = 'homecollection.settings.manage';
const ADMIN: Who = as(DISPATCHER, { grants: [P.read, P.assign, FLAGS] });
const ADMIN_B2: Who = as(DISPATCHER_B, { grants: [P.read, P.assign, FLAGS] });
let n = 0; const D = () => day('2027-07-01', n++);
const patch = (membership: string, body: unknown, who: Who = ADMIN) => dop('updateCollectorFlags', req({ params: { membership_id: membership }, body }), who);
const flagRows = (membership: string) => ownerRows('homecollection.collector_flags', 'membership_id = $1', [membership]);

/** a fresh staff membership of tenant A (core.users + core.memberships), so no parallel suite shares it */
async function collector(): Promise<{ id: string; roster: any[] }> {
  const user = uid(); const id = uid();
  await seed('core.users', { tenant_id: TENANT_A, id: user, display_name: `Synthetic Collector ${id.slice(-6)}` });
  await seed('core.memberships', { id, tenant_id: TENANT_A, user_id: user, actor_type: 'user', all_centres: true, status: 'active' });
  return { id, roster: [...ROSTER, { membershipId: id, isActive: true, roleCodes: ['phlebotomist'], permissions: [P.read, P.sync], allCentres: true, centreIds: [] }] };
}
async function readyVisit(date: string) { const v = await bookingVisit({}, 'a', date); const order = await newOrder(); return { v, fx: { orderId: order.id } }; }

describe('updateCollectorFlags', () => {
  it('the operation has a real handler (not pending)', () => {
    expect(typeof (manifest.handlers as any).updateCollectorFlags).toBe('function');
    expect([...((manifest as any).pendingOperations ?? [])]).not.toContain('updateCollectorFlags');
  });
  it('upserts: first call creates the row (the flag not sent stays true), second changes only the flag sent; one row; INSERT then UPDATE audit', { timeout: T }, async () => {
    const c = await collector();
    expect(await flagRows(c.id)).toEqual([]);
    const r1 = await patch(c.id, { allow_pickup: false });
    expect(r1.status).toBe(200); expect(r1.body).toEqual({ membership_id: c.id, allow_collection: true, allow_pickup: false });
    const r2 = await patch(c.id, { allow_collection: false });
    expect(r2.body).toEqual({ membership_id: c.id, allow_collection: false, allow_pickup: false });
    const r3 = await patch(c.id, { allow_collection: true, allow_pickup: true });
    expect(r3.body).toEqual({ membership_id: c.id, allow_collection: true, allow_pickup: true });
    const rows = await flagRows(c.id); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, allow_collection: true, allow_pickup: true });
    const audit = await ownerRows('audit.audit_log', "table_name = 'collector_flags' AND row_id = $1 ORDER BY created_at, id", [rows[0].id]);
    expect(audit.map((a: any) => a.action)).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
  });
  it.each([[{}], [{ allow_pickup: 'no' }], [{ allow_collection: 1 }], [{ allow_pickup: null }], [{ other: true }]])('body %j -> common.validation_failed, no row written', { timeout: T }, async (body) => {
    const c = await collector(); const e = await failure(patch(c.id, body));
    expect(e.code).toBe('common.validation_failed'); expect(await flagRows(c.id)).toEqual([]);
  });
  it('unknown membership and a tenant B membership -> common.not_found, nothing written', { timeout: T }, async () => {
    const c = await collector();
    expect((await failure(patch(uid(), { allow_pickup: false }))).code).toBe('common.not_found');
    expect((await failure(patch(c.id, { allow_pickup: false }, ADMIN_B2))).code).toBe('common.not_found');
    expect(await flagRows(c.id)).toEqual([]);
  });
  it('without homecollection.settings.manage -> auth.forbidden, nothing written', { timeout: T }, async () => {
    const c = await collector(); const e = await failure(patch(c.id, { allow_pickup: false }, DISPATCHER)); expect(e.code).toBe('auth.forbidden'); expect(await flagRows(c.id)).toEqual([]);
  });
});

describe('listEligiblePhlebotomists (H12) with flags', () => {
  const list = (roster: any[], who: Who = DISPATCHER) => listPhlebos({ centre_id: HC_CENTRE.a }, who, { fx: { roster } });
  it('no flag row: both flags true on every item, and the existing items are unchanged (additive)', { timeout: T }, async () => {
    const r = await list([...ROSTER]); expect(r.status).toBe(200); expect(responseErrors('listEligiblePhlebotomists', r.body)).toEqual([]);
    const mine = r.body.data.find((x: any) => x.membership_id === MEMBER.a); expect(mine).toMatchObject({ allow_collection: true, allow_pickup: true });
  });
  it('allow_pickup=false: still listed for home visits, flagged allow_pickup:false; allow_collection=false: left out of the list', { timeout: T }, async () => {
    const c = await collector();
    await patch(c.id, { allow_pickup: false });
    let r = await list(c.roster); expect(r.body.data.find((x: any) => x.membership_id === c.id)).toMatchObject({ allow_collection: true, allow_pickup: false });
    await patch(c.id, { allow_collection: false });
    r = await list(c.roster); expect(r.body.data.some((x: any) => x.membership_id === c.id), 'allow_collection=false must not be offered').toBe(false);
    expect(r.body.data.some((x: any) => x.membership_id === MEMBER.a)).toBe(true);
    await patch(c.id, { allow_collection: true });
    r = await list(c.roster); expect(r.body.data.find((x: any) => x.membership_id === c.id)).toMatchObject({ allow_collection: true, allow_pickup: false });
  });
  it('flags of a tenant A collector are invisible to tenant B (own roster only, flags default true)', { timeout: T }, async () => {
    const c = await collector(); await patch(c.id, { allow_collection: false, allow_pickup: false });
    const rowsB = await ownerRows('homecollection.collector_flags', 'tenant_id = $1 AND membership_id = $2', [TENANT_B, c.id]); expect(rowsB).toEqual([]);
  });
});

describe('assignHomeVisit never puts a collector without allow_collection on a route', () => {
  const body = (m: string, date: string) => ({ phlebotomist_membership_id: m, route_date: date });
  it('allow_collection=false -> common.validation_failed /phlebotomist_membership_id; the visit stays unassigned and NO route is created', { timeout: T }, async () => {
    const c = await collector(); await patch(c.id, { allow_collection: false });
    const date = D(); const { v, fx } = await readyVisit(date);
    const e = await failure(assign({ visitId: v.id, version: v.version, body: body(c.id, date), fx: { ...fx, roster: c.roster } }));
    expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? [])).toContain('/phlebotomist_membership_id');
    expect(await visitRow(v.id)).toMatchObject({ status: 'unassigned', route_id: null, assigned_membership_id: null, version: v.version });
    expect(await routesOf(c.id, date)).toEqual([]);
  });
  it('allow_collection=true and allow_pickup=false: the home visit is assigned (the pickup flag does not block home collection)', { timeout: T }, async () => {
    const c = await collector(); await patch(c.id, { allow_pickup: false });
    const date = D(); const { v, fx } = await readyVisit(date);
    const r = await assign({ visitId: v.id, version: v.version, body: body(c.id, date), fx: { ...fx, roster: c.roster } });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ status: 'assigned', phlebotomist: { membership_id: c.id } });
  });
  it('switching allow_collection back on makes the collector assignable again', { timeout: T }, async () => {
    const c = await collector(); await patch(c.id, { allow_collection: false }); await patch(c.id, { allow_collection: true });
    const date = D(); const { v, fx } = await readyVisit(date);
    expect((await assign({ visitId: v.id, version: v.version, body: body(c.id, date), fx: { ...fx, roster: c.roster } })).status).toBe(200);
  });
  it('a collector WITHOUT a flag row (all existing ones) is assignable exactly as before', { timeout: T }, async () => {
    const c = await collector(); expect(await flagRows(c.id)).toEqual([]);
    const date = D(); const { v, fx } = await readyVisit(date);
    expect((await assign({ visitId: v.id, version: v.version, body: body(c.id, date), fx: { ...fx, roster: c.roster } })).status).toBe(200);
  });
  it('a collector of tenant A is not touched by tenant B flag writes (cross tenant): tenant B cannot create a row for it', { timeout: T }, async () => {
    const c = await collector();
    expect((await failure(patch(c.id, { allow_collection: false }, ADMIN_B2))).code).toBe('common.not_found');
    const date = D(); const { v, fx } = await readyVisit(date);
    expect((await assign({ visitId: v.id, version: v.version, body: body(c.id, date), fx: { ...fx, roster: c.roster } })).status).toBe(200);
  });
});
