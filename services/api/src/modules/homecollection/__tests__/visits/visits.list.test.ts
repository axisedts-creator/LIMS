// HC-T08 H1 listHomeVisits (GET /v1/homecollection/visits, homecollection.visit.read). 02-TRD §5 H1 (filters, sort, cursor, ONE FrontdeskPort.getPatientDemographicsBatch({patientIds, purpose:'home_visit'}) per page,
// review m#34), §5.3 VisitSummaryDto, §5.3.1 field allowlists (REQ-SEC-081), §5.4 rule 2 (phlebotomist-only = sync.upload without visit.assign -> only own visits), P-17 (staff names from ctx.core.memberships.list,
// batched), §2.1 port failure -> board shows "—", 07-SECURITY §4 probes 1/3 + AB9 (phlebotomist lists all centre visits -> filtered to own). Fails now: H1 is an HC-T01 stub (common.internal "not implemented").
import { beforeAll, describe, expect, it } from 'vitest';
import { DISPATCHER, DISPATCHER_B, HC_CENTRE, LONG_ADDRESS, MEMBER, MEMBER2, NOBODY, OTHER_CENTRE, P, PHLEBO, PHLEBO2, T, as, buildScenario, failure, listVisits, nameOf, ownerRows, phoneOf,
  responseErrors, staffName, tenantVisitIds, TENANT_A, TENANT_B, type Scenario } from './helpers.js';

let S: Scenario;
beforeAll(async () => { S = await buildScenario('2027-03-01'); }, T);

const ids = (r: { body: any }): string[] => r.body.data.map((x: any) => x.id);
const mine = () => [S.assigned1.id, S.assigned2.id, S.done.id, S.assignedOther.id];
const day = (o: object = {}) => ({ route_date: S.date, centre_id: HC_CENTRE.a, limit: 200, ...o });
const noNulls = (x: unknown): boolean => (x === null ? false : Array.isArray(x) ? x.every(noNulls) : x && typeof x === 'object' ? Object.values(x).every(noNulls) : true);

describe('H1 contract + mapper', () => {
  it('200 schema-valid page (VisitSummaryDto[] + page); the date filter returns exactly the four scenario visits of the day; no null anywhere; ids are the visits own ids', { timeout: T }, async () => {
    const r = await listVisits(day());
    expect(r.status).toBe(200);
    expect(responseErrors('listHomeVisits', r.body)).toEqual([]);
    expect(ids(r).sort()).toEqual(mine().sort());
    expect(noNulls(r.body)).toBe(true);
  });
  it('maps rows to the DTO: names from the port, route fields, phlebotomist ref, area_hint = first 60 chars of address_text (staff), specimens_summary with all five counters, version', { timeout: T }, async () => {
    const r = await listVisits(day({ phlebotomist_membership_id: MEMBER.a, sort: 'route_sequence' }));
    expect(r.body.data.map((x: any) => x.route_sequence)).toEqual([1, 2, 3]);
    const a1 = r.body.data[0];
    expect(a1).toMatchObject({ id: S.assigned1.id, kind: 'booking', status: 'assigned', centre_id: HC_CENTRE.a, patient_id: S.assigned1.patient_id, patient_display_name: nameOf(S.assigned1.patient_id),
      route_id: S.routeA1.id, route_date: S.date, route_sequence: 1, phlebotomist: { membership_id: MEMBER.a, display_name: staffName(MEMBER.a) }, area_hint: LONG_ADDRESS.slice(0, 60), open_flag_kinds: [] });
    expect(a1.specimens_summary).toEqual({ expected: 0, collected: 0, held: 0, received: 0, rejected: 0 });
    expect(a1.window_start).toBe(`${S.date}T04:00:00.000Z`);
    expect(Number.isInteger(a1.version) && a1.version >= 1).toBe(true);
    expect(r.body.data[2]).toMatchObject({ id: S.done.id, status: 'completed', outcome: 'collected' });
  });
  it('an unassigned visit has no route / phlebotomist fields, its open flag kind and its expected specimen are counted', { timeout: T }, async () => {
    const r = await listVisits({ unassigned_only: true, centre_id: HC_CENTRE.a, limit: 200 });
    const u = r.body.data.find((x: any) => x.id === S.unassigned.id);
    expect(u).toBeDefined();
    for (const k of ['route_id', 'route_date', 'route_sequence', 'phlebotomist']) expect(u, k).not.toHaveProperty(k);
    expect(u.status).toBe('unassigned');
    expect(u.open_flag_kinds).toEqual(['held_collection']);
    expect(u.specimens_summary.expected).toBe(1);
  });
  it('staff list: no phone, no landmark, no note, no coordinates, no full address, no internal ids (REQ-SEC-081): only the DTO keys + area_hint', { timeout: T }, async () => {
    const r = await listVisits(day());
    const text = JSON.stringify(r.body);
    for (const bad of [LONG_ADDRESS, 'Opposite the synthetic bakery', 'Synthetic gate code', 'address_text', 'latitude', 'longitude', 'landmark', 'note_for_phlebotomist', 'phone', 'tenant_id', 'created_by', 'updated_by', 'is_active']) {
      expect(text, bad).not.toContain(bad);
    }
    for (const p of Object.values(S.patients)) expect(text).not.toContain(phoneOf(p.id));
  });
});

describe('H1 patient names: exactly one batch call per page; staff names via ctx.core.memberships.list', () => {
  it('one getPatientDemographicsBatch call per page with purpose home_visit and the unique patient ids of the page; never a per-visit getPatientDemographics', { timeout: T }, async () => {
    const r = await listVisits(day());
    expect(r.probe.batch).toHaveLength(1);
    expect(r.probe.batch[0]!.purpose).toBe('home_visit');
    expect([...r.probe.batch[0]!.patientIds].sort()).toEqual([...new Set(r.body.data.map((x: any) => x.patient_id))].sort());
    expect(r.probe.single).toHaveLength(0);
  });
  it('paging: limit 3 over 4 visits -> pages of 3 + 1, a next_cursor on the first only, no id twice, still exactly one batch call per page', { timeout: T }, async () => {
    const p1 = await listVisits(day({ limit: 3 }));
    expect(p1.body.data).toHaveLength(3); expect(typeof p1.body.page.next_cursor).toBe('string'); expect(p1.body.page.limit).toBe(3);
    expect(p1.probe.batch).toHaveLength(1);
    const p2 = await listVisits(day({ limit: 3, cursor: p1.body.page.next_cursor }));
    expect(p2.body.data).toHaveLength(1); expect(p2.body.page).not.toHaveProperty('next_cursor');
    expect(p2.probe.batch).toHaveLength(1);
    expect(responseErrors('listHomeVisits', p2.body)).toEqual([]);
    expect([...ids(p1), ...ids(p2)].sort()).toEqual(mine().sort());
  });
  it('a patient the port omits, and a failing port, show "—" and never fail the board (§2.1); the other rows keep their names', { timeout: T }, async () => {
    const omit = await listVisits(day(), DISPATCHER, { fx: { omit: [S.assigned1.patient_id] } });
    expect(omit.status).toBe(200);
    expect(omit.body.data.find((x: any) => x.id === S.assigned1.id).patient_display_name).toBe('—');
    expect(omit.body.data.find((x: any) => x.id === S.assigned2.id).patient_display_name).toBe(nameOf(S.assigned2.patient_id));
    const down = await listVisits(day(), DISPATCHER, { fx: { batchFails: true } });
    expect(down.status).toBe(200);
    expect(down.body.data.every((x: any) => x.patient_display_name === '—')).toBe(true);
    expect(responseErrors('listHomeVisits', down.body)).toEqual([]);
  });
  it('staff names: ONE core.memberships.list call for the page (batched ids, activeOnly:false so ex-staff keep their name), display_name = what core returned, no other name source', { timeout: T }, async () => {
    const r = await listVisits(day());
    expect(r.probe.memberships).toHaveLength(1);
    const call = r.probe.memberships[0] as any;
    expect([...call.membershipIds].sort()).toEqual([MEMBER.a, MEMBER2.a].sort());
    expect(call.activeOnly).toBe(false);
    expect(new Set(r.body.data.map((x: any) => x.phlebotomist?.display_name).filter(Boolean))).toEqual(new Set([staffName(MEMBER.a), staffName(MEMBER2.a)]));
  });
  it('a failing core lookup omits the staff names, it does not fail the request', { timeout: T }, async () => {
    const r = await listVisits(day(), DISPATCHER, { fx: { coreFails: true } });
    expect(r.status).toBe(200);
    expect(responseErrors('listHomeVisits', r.body)).toEqual([]);
  });
});

describe('H1 filters, sort, cursor', () => {
  it('status csv', { timeout: T }, async () => {
    expect(ids(await listVisits(day({ status: 'completed' })))).toEqual([S.done.id]);
    expect(ids(await listVisits(day({ status: 'assigned,completed' }))).sort()).toEqual(mine().sort());
    expect(ids(await listVisits(day({ status: 'failed' })))).toEqual([]);
  });
  it('kind csv; unassigned_only; has_open_flags', { timeout: T }, async () => {
    expect(ids(await listVisits(day({ kind: 'front_desk' })))).toEqual([]);                                         // all four scenario visits of the day are booking visits
    expect(ids(await listVisits(day({ kind: 'booking' }))).sort()).toEqual(mine().sort());
    const un = ids(await listVisits({ unassigned_only: true, centre_id: HC_CENTRE.a, limit: 200 }));
    expect(un).toEqual(expect.arrayContaining([S.unassigned.id, S.unassignedBooking.id]));
    for (const id of mine()) expect(un).not.toContain(id);
    const fl = await listVisits({ has_open_flags: true, centre_id: HC_CENTRE.a, limit: 200 });
    expect(ids(fl)).toContain(S.unassigned.id);
    for (const id of mine()) expect(ids(fl)).not.toContain(id);
    expect(fl.body.data.every((x: any) => x.open_flag_kinds.length > 0)).toBe(true);
  });
  it('route_date, centre_id, phlebotomist_membership_id, window_from / window_to', { timeout: T }, async () => {
    expect(ids(await listVisits(day({ phlebotomist_membership_id: MEMBER2.a })))).toEqual([S.assignedOther.id]);
    expect(ids(await listVisits({ route_date: '2027-03-31', centre_id: HC_CENTRE.a }))).toEqual([]);
    expect(ids(await listVisits(day({ centre_id: OTHER_CENTRE.a })))).toEqual([]);
    expect(ids(await listVisits(day({ window_from: '2030-01-01T00:00:00.000Z' })))).toEqual([]);
    expect(ids(await listVisits(day({ window_to: '2000-01-01T00:00:00.000Z' })))).toEqual([]);
  });
  it('sort: window_start / -window_start / route_sequence', { timeout: T }, async () => {
    expect(ids(await listVisits(day({ sort: '-window_start' })))).toEqual([S.assignedOther.id, S.done.id, S.assigned2.id, S.assigned1.id]);
    expect(ids(await listVisits(day({ sort: 'window_start' })))).toEqual([S.assigned1.id, S.assigned2.id, S.done.id, S.assignedOther.id]);
    expect(ids(await listVisits(day({ phlebotomist_membership_id: MEMBER.a, sort: 'route_sequence' })))).toEqual([S.assigned1.id, S.assigned2.id, S.done.id]);
  });
  it('unknown status / kind values -> 400 common.validation_failed (never a 500, never ignored)', { timeout: T }, async () => {
    expect((await failure(listVisits(day({ status: 'bogus' })))).code).toBe('common.validation_failed');
    expect((await failure(listVisits(day({ status: 'assigned,bogus' })))).code).toBe('common.validation_failed');
    expect((await failure(listVisits(day({ kind: 'bogus' })))).code).toBe('common.validation_failed');
  });
  it('malformed / foreign / tampered cursor -> common.invalid_cursor', { timeout: T }, async () => {
    for (const cursor of ['not-a-cursor!!', '', 'eyJ2IjoxfQ', Buffer.from('{"v":99,"id":"x"}').toString('base64url'), "'; DROP TABLE homecollection.visits; --"]) {
      expect((await failure(listVisits(day({ cursor })))).code, cursor).toBe('common.invalid_cursor');
    }
    expect((await ownerRows('homecollection.visits', 'tenant_id = $1', [TENANT_A])).length).toBeGreaterThan(0);   // the injection string dropped nothing
  });
  it('SQL injection probes in filter values are 400s, never executed, never widen the result', { timeout: T }, async () => {
    for (const q of [{ centre_id: "' OR 1=1 --" }, { phlebotomist_membership_id: "x'; DELETE FROM homecollection.visits; --" }, { status: "assigned' OR '1'='1" }, { route_date: "2027-03-01' OR 1=1" }]) {
      expect((await failure(listVisits({ limit: 200, ...q }))).code, JSON.stringify(q)).toBe('common.validation_failed');
    }
    expect((await ownerRows('homecollection.visits', 'tenant_id = $1', [TENANT_A])).length).toBeGreaterThan(0);
  });
});

describe('H1 phlebotomist-only filter (§5.4 rule 2, AB9)', () => {
  it('a phlebotomist-only actor (visit.read + sync.upload, no visit.assign) gets only visits assigned to them, whatever the query says', { timeout: T }, async () => {
    const r = await listVisits({ route_date: S.date, centre_id: HC_CENTRE.a, limit: 200 }, PHLEBO);
    expect(r.status).toBe(200);
    expect(responseErrors('listHomeVisits', r.body)).toEqual([]);
    expect(ids(r).sort()).toEqual([S.assigned1.id, S.assigned2.id, S.done.id].sort());
    expect(r.body.data.every((x: any) => x.phlebotomist.membership_id === MEMBER.a)).toBe(true);
    for (const q of [{ phlebotomist_membership_id: MEMBER2.a }, { unassigned_only: true }, { status: 'unassigned' }, { has_open_flags: true }]) {
      expect(ids(await listVisits({ route_date: S.date, centre_id: HC_CENTRE.a, limit: 200, ...q }, PHLEBO)), JSON.stringify(q)).toEqual([]);
    }
    expect(ids(await listVisits(day(), PHLEBO2))).toEqual([S.assignedOther.id]);
  });
  it('the other visits never reach the port or the response: the batch call only names this phlebotomists patients, and no foreign patient name / address leaks', { timeout: T }, async () => {
    const r = await listVisits({ route_date: S.date, centre_id: HC_CENTRE.a, limit: 200 }, PHLEBO);
    expect(r.probe.batch).toHaveLength(1);
    expect([...r.probe.batch[0]!.patientIds].sort()).toEqual([S.assigned1, S.assigned2, S.done].map((v) => v.patient_id).sort());
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(nameOf(S.assignedOther.patient_id));
    expect(text).not.toContain(nameOf(S.unassigned.patient_id));
  });
  it('own rows keep their name (assignee allowlist) but the staff-only area_hint is withheld; a holder of visit.assign AND sync.upload is staff: sees everything', { timeout: T }, async () => {
    const r = await listVisits(day(), PHLEBO);
    for (const x of r.body.data) { expect(x.patient_display_name).toBe(nameOf(x.patient_id)); expect(x, 'area_hint').not.toHaveProperty('area_hint'); }
    const both = await listVisits(day(), as(PHLEBO, { grants: [P.read, P.sync, P.assign] }));
    expect(ids(both).sort()).toEqual(mine().sort());
    expect(both.body.data[0]).toHaveProperty('area_hint');
  });
});

describe('H1 authorization + tenant isolation', () => {
  it('no visit.read -> auth.forbidden through IdentityPort.assertRole(homecollection.visit.read); no demographics / staff lookup happens before the check passes', { timeout: T }, async () => {
    const e = await failure(listVisits(day(), NOBODY));
    expect(e.code).toBe('auth.forbidden');
    expect(e.probe.identity.calls.map((c: any) => c.permission)).toContain(P.read);
    expect(e.probe.batch).toHaveLength(0); expect(e.probe.memberships).toHaveLength(0);
    const ok = await listVisits(day());
    expect(ok.probe.identity.calls.map((c) => c.permission)).toContain(P.read);
  });
  it('cross-tenant (probe 1): tenant B sees only its own visit, also with RLS bypassed; tenant-A ids / centre / member in the query return nothing; tenant A never sees B rows', { timeout: T }, async () => {
    const b = await listVisits({ route_date: S.date, limit: 200 }, DISPATCHER_B);
    expect(ids(b)).toEqual([S.assignedB.id]);
    expect(ids(await listVisits({ route_date: S.date, limit: 200 }, DISPATCHER_B, { bypassRls: true }))).toEqual([S.assignedB.id]);
    expect(ids(await listVisits({ centre_id: HC_CENTRE.a, limit: 200 }, DISPATCHER_B, { bypassRls: true }))).toEqual([]);
    expect(ids(await listVisits({ phlebotomist_membership_id: MEMBER.a, limit: 200 }, DISPATCHER_B, { bypassRls: true }))).toEqual([]);
    const bIds = await tenantVisitIds(TENANT_B);
    for (const opts of [{}, { bypassRls: true }]) {
      const a = await listVisits({ limit: 200 }, DISPATCHER, opts);
      for (const id of ids(a)) expect(bIds, id).not.toContain(id);
      expect(ids(await listVisits({ phlebotomist_membership_id: MEMBER.b, limit: 200 }, DISPATCHER, opts))).toEqual([]);
    }
  });
  it('only this tenants patients are sent to the port', { timeout: T }, async () => {
    const r = await listVisits({ limit: 200 }, DISPATCHER, { bypassRls: true });
    const bPatients = new Set((await ownerRows('frontdesk.patients', 'tenant_id = $1', [TENANT_B])).map((p) => p.id));
    for (const pid of r.probe.batch.flatMap((b) => b.patientIds)) expect(bPatients.has(pid), pid).toBe(false);
  });
});
