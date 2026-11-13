// HC-T08 H10 listHomeRoutes (GET /v1/homecollection/routes, visit.read) + H12 listEligiblePhlebotomists (GET /v1/homecollection/phlebotomists, visit.assign). 02-TRD §5 H10 ({data: RouteDto[]}, route_date required,
// centre_id?), §5.3 RouteDto, H12 ({data:[{membership_id, display_name, route_id?, active_visits, route_full}]}; route_full = the route has max_visits_per_route active visits OR the phlebotomists active visits on
// route_date across routes reached LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS (60) — the two H3 refusals, 08 A19 D-131, review m#27; without route_date route_full is false), P-17 (names via core.memberships.list),
// US-06-5, 07-SECURITY probe 1 + probe 5 (phlebotomist calling H12 -> auth.forbidden). Fails now: H10/H12 are HC-T01 stubs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DISPATCHER, DISPATCHER_B, HC_CENTRE, MEMBER, MEMBER2, NOBODY, NOT_ELIGIBLE, OTHER_CENTRE, P, PHLEBO, T, TENANT_A, addActiveVisits, buildScenario, displayStrings, failure, hc, listPhlebos,
  listRoutes, responseErrors, seed, setMaxVisitsPerRoute, staffName, type Scenario } from './helpers.js';

let S: Scenario;
beforeAll(async () => { S = await buildScenario('2027-03-03'); }, T);

const rid = (r: { body: any }): string[] => r.body.data.map((x: any) => x.id);

describe('H10 listHomeRoutes', () => {
  it('200 {data: RouteDto[]}: exactly the tenants routes of the day, no page object, schema-valid', { timeout: T }, async () => {
    const r = await listRoutes({ route_date: S.date });
    expect(r.status).toBe(200);
    expect(responseErrors('listHomeRoutes', r.body)).toEqual([]);
    expect(Object.keys(r.body)).toEqual(['data']);
    expect(rid(r).sort()).toEqual([S.routeA1.id, S.routeA2.id].sort());
  });
  it('maps a route: version, centre, date, phlebotomist ref (name from core), active / completed counts, visit ids ordered by route_sequence (insertion order was reversed)', { timeout: T }, async () => {
    const r = await listRoutes({ route_date: S.date, centre_id: HC_CENTRE.a });
    const a1 = r.body.data.find((x: any) => x.id === S.routeA1.id), a2 = r.body.data.find((x: any) => x.id === S.routeA2.id);
    expect(a1).toMatchObject({ centre_id: HC_CENTRE.a, route_date: S.date, phlebotomist: { membership_id: MEMBER.a, display_name: staffName(MEMBER.a) }, active_visits: 2, completed_visits: 1 });
    expect(Number.isInteger(a1.version)).toBe(true);
    expect(a1.visit_ids_in_order).toEqual(expect.arrayContaining([S.assigned1.id, S.assigned2.id]));
    expect(a1.visit_ids_in_order.indexOf(S.assigned1.id)).toBeLessThan(a1.visit_ids_in_order.indexOf(S.assigned2.id));
    expect(a2).toMatchObject({ phlebotomist: { membership_id: MEMBER2.a, display_name: staffName(MEMBER2.a) }, visit_ids_in_order: [S.assignedOther.id], active_visits: 1, completed_visits: 0 });
  });
  it('names: ONE core.memberships.list call for all routes, nothing else names a phlebotomist', { timeout: T }, async () => {
    const r = await listRoutes({ route_date: S.date });
    expect(r.probe.memberships).toHaveLength(1);
    expect([...(r.probe.memberships[0] as any).membershipIds].sort()).toEqual([MEMBER.a, MEMBER2.a].sort());
    expect(new Set(displayStrings(r.body))).toEqual(new Set([staffName(MEMBER.a), staffName(MEMBER2.a)]));
  });
  it('filters: other centre / other day -> empty; route_date is required and must be a date (400 common.validation_failed, injection included)', { timeout: T }, async () => {
    expect(rid(await listRoutes({ route_date: S.date, centre_id: OTHER_CENTRE.a }))).toEqual([]);
    expect(rid(await listRoutes({ route_date: '2027-03-31' }))).toEqual([]);
    for (const q of [{}, { centre_id: HC_CENTRE.a }, { route_date: '2027-13-45' }, { route_date: "2027-03-03' OR 1=1 --" }, { route_date: S.date, centre_id: "' OR 1=1 --" }]) {
      expect((await failure(listRoutes(q))).code, JSON.stringify(q)).toBe('common.validation_failed');
    }
  });
  it('no visit.read -> auth.forbidden (assertRole visit.read); other tenants routes are invisible, also with RLS bypassed', { timeout: T }, async () => {
    const e = await failure(listRoutes({ route_date: S.date }, NOBODY));
    expect(e.code).toBe('auth.forbidden'); expect(e.probe.identity.calls.map((c: any) => c.permission)).toContain(P.read); expect(e.probe.memberships).toHaveLength(0);
    for (const bypassRls of [false, true]) {
      expect(rid(await listRoutes({ route_date: S.date }, DISPATCHER_B, { bypassRls }))).toEqual([S.routeB.id]);
      expect(rid(await listRoutes({ route_date: S.date, centre_id: HC_CENTRE.a }, DISPATCHER_B, { bypassRls }))).toEqual([]);
      expect(rid(await listRoutes({ route_date: S.date }, DISPATCHER, { bypassRls }))).not.toContain(S.routeB.id);
    }
  });
});

describe('H12 listEligiblePhlebotomists', () => {
  const eligible = (r: { body: any }) => r.body.data.map((x: any) => x.membership_id).sort();

  it('200 {data:[...]} schema-valid: the active phlebotomists of the centre, each with the name core returned; inactive / non-phlebotomist / other-centre-only memberships are not offered', { timeout: T }, async () => {
    const r = await listPhlebos({ centre_id: HC_CENTRE.a });
    expect(r.status).toBe(200);
    expect(responseErrors('listEligiblePhlebotomists', r.body)).toEqual([]);
    expect(Object.keys(r.body)).toEqual(['data']);
    expect(eligible(r)).toEqual([MEMBER.a, MEMBER2.a].sort());
    for (const x of r.body.data) expect(x.display_name).toBe(staffName(x.membership_id));
    for (const bad of Object.values(NOT_ELIGIBLE)) expect(JSON.stringify(r.body)).not.toContain(bad);
    expect(new Set(displayStrings(r.body))).toEqual(new Set([staffName(MEMBER.a), staffName(MEMBER2.a)]));
  });
  it('the roster is the one core.memberships.list call, scoped to the requested centre, active only, by the phlebotomist role / sync.upload permission (the C17 definition of "phlebotomist")', { timeout: T }, async () => {
    const r = await listPhlebos({ centre_id: HC_CENTRE.a });
    expect(r.probe.memberships.length).toBeGreaterThanOrEqual(1);
    const roster = r.probe.memberships.find((m: any) => m.membershipIds === undefined) as any;
    expect(roster, 'no roster call (core.memberships.list without membershipIds)').toBeDefined();
    expect(roster.centreId).toBe(HC_CENTRE.a);
    expect(roster.activeOnly).not.toBe(false);
    expect(roster.roleCode === 'phlebotomist' || roster.permission === P.sync).toBe(true);
    expect(eligible(await listPhlebos({ centre_id: OTHER_CENTRE.a }))).toEqual([MEMBER.a, NOT_ELIGIBLE.otherCentre].sort());   // all-centres + the other-centre-only phlebotomist
  });
  it('without route_date: route_full is false for everybody and no per-day counts are required', { timeout: T }, async () => {
    const r = await listPhlebos({ centre_id: HC_CENTRE.a });
    expect(r.body.data.every((x: any) => x.route_full === false)).toBe(true);
  });
  it('with route_date: route_id + active_visits of the phlebotomists route that day (completed visits are not active); one without a route has none', { timeout: T }, async () => {
    const r = await listPhlebos({ centre_id: HC_CENTRE.a, route_date: S.date });
    const m1 = r.body.data.find((x: any) => x.membership_id === MEMBER.a), m2 = r.body.data.find((x: any) => x.membership_id === MEMBER2.a);
    expect(m1).toMatchObject({ route_id: S.routeA1.id, active_visits: 2, route_full: false });
    expect(m2).toMatchObject({ route_id: S.routeA2.id, active_visits: 1, route_full: false });
    const none = await listPhlebos({ centre_id: HC_CENTRE.a, route_date: '2027-03-30' });
    for (const x of none.body.data) { expect(x).not.toHaveProperty('route_id'); expect(x.active_visits).toBe(0); expect(x.route_full).toBe(false); }
    expect(responseErrors('listEligiblePhlebotomists', r.body)).toEqual([]);
  });

  describe('route_full (D-131, review m#27): one flag for both H3 refusals', () => {
    afterAll(async () => { await setMaxVisitsPerRoute(TENANT_A, 40); }, T);

    it('the route has max_visits_per_route active visits -> true (the settings value, not a constant); one below -> false', { timeout: T }, async () => {
      // tenant A has a committed settings row (seedWorld); the tenant default is 40
      await setMaxVisitsPerRoute(TENANT_A, 3);
      const below = await listPhlebos({ centre_id: HC_CENTRE.a, route_date: S.date });
      expect(below.body.data.find((x: any) => x.membership_id === MEMBER.a).route_full).toBe(false);                 // 2 active < 3 (the completed visit does not count)
      await setMaxVisitsPerRoute(TENANT_A, 2);
      const full = await listPhlebos({ centre_id: HC_CENTRE.a, route_date: S.date });
      expect(full.body.data.find((x: any) => x.membership_id === MEMBER.a)).toMatchObject({ active_visits: 2, route_full: true });
      expect(full.body.data.find((x: any) => x.membership_id === MEMBER2.a).route_full).toBe(false);                  // 1 active < 2
      await setMaxVisitsPerRoute(TENANT_A, 40);
    });

    it('active visits of the phlebotomist on route_date ACROSS routes reach 60 -> true even though each route is below max_visits_per_route; 59 -> false', { timeout: T }, async () => {
      const day = '2027-03-05';
      const w = S.w;
      const rHc = hc.route('a', { phlebotomist_membership_id: MEMBER2.a, route_date: day }); await seed('homecollection.routes', rHc);
      const rOther = hc.route('a', { phlebotomist_membership_id: MEMBER2.a, route_date: day, centre_id: OTHER_CENTRE.a }); await seed('homecollection.routes', rOther);
      await addActiveVisits('a', w, { n: 30, member: MEMBER2.a, routeId: rHc.id, centreId: HC_CENTRE.a, date: day });
      await addActiveVisits('a', w, { n: 29, member: MEMBER2.a, routeId: rOther.id, centreId: OTHER_CENTRE.a, date: day });
      const at59 = await listPhlebos({ centre_id: HC_CENTRE.a, route_date: day });
      expect(at59.body.data.find((x: any) => x.membership_id === MEMBER2.a)).toMatchObject({ route_id: rHc.id, route_full: false });
      await addActiveVisits('a', w, { n: 1, member: MEMBER2.a, routeId: rOther.id, centreId: OTHER_CENTRE.a, date: day, startSeq: 30 });
      const at60 = await listPhlebos({ centre_id: HC_CENTRE.a, route_date: day });
      expect(at60.body.data.find((x: any) => x.membership_id === MEMBER2.a).route_full).toBe(true);
      expect(at60.body.data.find((x: any) => x.membership_id === MEMBER.a).route_full).toBe(false);                    // someone elses load does not count
      const noDate = await listPhlebos({ centre_id: HC_CENTRE.a });
      expect(noDate.body.data.every((x: any) => x.route_full === false)).toBe(true);                                   // without route_date: always false
    });
  });

  it('privilege (probe 5): H12 needs visit.assign — a phlebotomist (read + sync.upload) and an actor with nothing get auth.forbidden; assertRole(visit.assign) is made for the requested centre; nothing is looked up before the check', { timeout: T }, async () => {
    for (const who of [PHLEBO, NOBODY]) {
      const e = await failure(listPhlebos({ centre_id: HC_CENTRE.a }, who));
      expect(e.code).toBe('auth.forbidden');
      expect(e.probe.memberships).toHaveLength(0);
    }
    const ok = await listPhlebos({ centre_id: HC_CENTRE.a });
    expect(ok.probe.identity.calls).toContainEqual({ permission: P.assign, centreId: HC_CENTRE.a });
  });
  it('centre_id is required and must be a UUID (400 common.validation_failed, injection included); route_date must be a date', { timeout: T }, async () => {
    for (const q of [{}, { route_date: S.date }, { centre_id: "' OR 1=1 --" }, { centre_id: HC_CENTRE.a, route_date: '2027-02-30' }, { centre_id: HC_CENTRE.a, route_date: "2027-03-03'; DROP TABLE homecollection.visits; --" }]) {
      expect((await failure(listPhlebos(q))).code, JSON.stringify(q)).toBe('common.validation_failed');
    }
  });
  it('tenant isolation: the per-day numbers only count the callers tenant, also with RLS bypassed (tenant B sees its own route; a tenant-A membership asked by tenant B shows no route and 0 active visits)', { timeout: T }, async () => {
    const entry = (membershipId: string) => ({ membershipId, isActive: true, roleCodes: ['phlebotomist'], permissions: [P.sync], allCentres: true, centreIds: [] as string[] });
    for (const bypassRls of [false, true]) {
      const own = await listPhlebos({ centre_id: HC_CENTRE.b, route_date: S.date }, DISPATCHER_B, { bypassRls, fx: { roster: [entry(MEMBER.b)] } });
      expect(own.body.data).toHaveLength(1);
      expect(own.body.data[0]).toMatchObject({ membership_id: MEMBER.b, route_id: S.routeB.id, active_visits: 1, route_full: false });
      let foreign: any;
      try { foreign = (await listPhlebos({ centre_id: HC_CENTRE.a, route_date: S.date }, DISPATCHER_B, { bypassRls, fx: { roster: [entry(MEMBER.a)] } })).body.data; } catch (e) { expect((e as any).code).toBe('common.not_found'); continue; }
      for (const x of foreign) { expect(x).not.toHaveProperty('route_id'); expect(x.active_visits).toBe(0); expect(x.route_full).toBe(false); }
    }
  });
});
