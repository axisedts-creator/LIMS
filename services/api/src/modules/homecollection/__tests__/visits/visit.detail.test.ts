// HC-T08 H2 getHomeVisit (GET /v1/homecollection/visits/{visit_id}, homecollection.visit.read). 02-TRD §5 H2 (VisitDetailDto, NO phone — H21; ONE access-log row `home_visit.view` purpose `visit_detail`, review #18;
// error homecollection.visit_not_assigned), §5.3 VisitDetailDto, §5.3.1 allowlists (REQ-SEC-081), §5.4 rules 1+2 (load through the RLS repo -> 404 first, then assertRole(centreId = visit.centre_id); phlebotomist-only
// actor on a visit not assigned to them -> 403 visit_not_assigned), §14 access-log table (REQ-SEC-096/097), §2.1 ports (getPatientDemographics -> "—" on failure, getOrderSummary -> propagate, BillingPort -> balance
// omitted), P-17 (names via ctx.core.memberships.list / ctx.core.user), 07-SECURITY probes 1+3. ACs US-04-3, US-06-5, US-16-1. Fails now: H2 is an HC-T01 stub.
import { beforeAll, describe, expect, it } from 'vitest';
import { DISPATCHER, DISPATCHER_B, HC_CENTRE, LONG_ADDRESS, MEMBER, NOBODY, PHLEBO, PHLEBO2, P, T, TENANT_A, TENANT_B, SYS_ACTOR, accessRows, buildScenario, displayStrings, failure, getVisit, nameOf, ownerRows,
  phoneOf, regOf, responseErrors, staffName, uid, viewRows, type Scenario } from './helpers.js';

let S: Scenario;
beforeAll(async () => { S = await buildScenario('2027-03-02'); }, T);
const NAME_SOURCES = /^(Synthetic (Staff|User|Patient) \S+|—)$/;

describe('H2 contract + mapper (dispatcher)', () => {
  it('200 VisitDetailDto: summary fields + address, registration_no, specimens, collections, flags, assignments, transitions — each mapped from its repository row', { timeout: T }, async () => {
    const v = S.unassigned;
    const r = await getVisit(v.id);
    expect(r.status).toBe(200);
    expect(responseErrors('getHomeVisit', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: v.id, kind: 'front_desk', status: 'unassigned', centre_id: HC_CENTRE.a, patient_id: v.patient_id, patient_display_name: nameOf(v.patient_id), order_id: v.order_id,
      registration_no: regOf(v.order_id), address: { address_text: 'Synthetic Lane 1', landmark: 'Near the synthetic temple' } });
    expect(r.body.flags).toHaveLength(1);
    expect(r.body.flags[0]).toMatchObject({ id: S.w.flag.id, kind: 'held_collection', status: 'open' });
    expect(r.body.transitions).toHaveLength(1);
    expect(r.body.transitions[0]).toMatchObject({ to: 'unassigned' });
    expect(r.body.transitions[0]).not.toHaveProperty('from');
    expect(r.body.assignments).toHaveLength(1);
    expect(r.body.assignments[0]).toMatchObject({ membership_id: MEMBER.a, display_name: staffName(MEMBER.a), route_date: S.w.assignment.route_date });
    expect(r.body.collections).toHaveLength(1);
    expect(r.body.collections[0]).toMatchObject({ id: S.w.collection.id, visit_id: v.id, specimen_id: S.w.specimen.id, status: 'held', scan_method: 'camera', barcode_verified: true,
      collected_by: { membership_id: MEMBER.a, display_name: staffName(MEMBER.a) } });
    expect(r.body.specimens).toHaveLength(1);
    expect(r.body.specimens[0]).toMatchObject({ specimen_id: S.w.specimen.id, specimen_type_code: 'SST', status: 'ordered' });
    expect(r.body.specimens_summary.expected).toBe(1);
  });
  it('an assigned visit carries its route fields and phlebotomist ref', { timeout: T }, async () => {
    const r = await getVisit(S.assigned1.id);
    expect(r.body).toMatchObject({ status: 'assigned', route_id: S.routeA1.id, route_date: S.date, route_sequence: 1, phlebotomist: { membership_id: MEMBER.a, display_name: staffName(MEMBER.a) },
      address: { address_text: LONG_ADDRESS }, note_for_phlebotomist: 'Synthetic gate code 0000' });
    expect(typeof r.body.assigned_at).toBe('string');
    expect(responseErrors('getHomeVisit', r.body)).toEqual([]);
  });
  it('NO phone (that is H21), no barcode, no tenant / audit / mutation internals anywhere in the detail', { timeout: T }, async () => {
    const r = await getVisit(S.unassigned.id);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(phoneOf(S.unassigned.patient_id));
    expect(text).not.toContain(S.w.specimen.barcode);
    for (const bad of ['phone', 'tenant_id', 'created_by', 'updated_by', 'payload', 'is_active', '"mutation_id"', 'device_seq']) expect(text, bad).not.toContain(bad);
  });
  it('ports: one getPatientDemographics (purpose home_visit), one getOrderSummary, one getOrderBalance, no batch call; names come from ctx.core only (ONE memberships.list, memoised per request)', { timeout: T }, async () => {
    const r = await getVisit(S.unassigned.id);
    expect(r.probe.single).toEqual([{ patientId: S.unassigned.patient_id, purpose: 'home_visit' }]);
    expect(r.probe.orderSummary).toEqual([S.unassigned.order_id]);
    expect(r.probe.balance).toEqual([S.unassigned.order_id]);
    expect(r.probe.batch).toHaveLength(0);
    expect(r.probe.memberships).toHaveLength(1);
    expect(r.body.balance).toMatchObject({ balance_due: { amount_paisa: 180000, currency: 'NPR' } });
    for (const s of displayStrings(r.body)) expect(s, s).toMatch(NAME_SOURCES);
  });
  it('port failures (§2.1): patient lookup -> name "—", balance -> omitted; both 200 and schema-valid; a failing getOrderSummary propagates and writes nothing', { timeout: T }, async () => {
    const r = await getVisit(S.unassigned.id, DISPATCHER, { fx: { demoFails: true, balanceFails: true } });
    expect(r.status).toBe(200);
    expect(r.body.patient_display_name).toBe('—');
    expect(r.body).not.toHaveProperty('balance');
    expect(responseErrors('getHomeVisit', r.body)).toEqual([]);
    const e = await failure(getVisit(S.unassigned.id, DISPATCHER, { fx: { orderSummaryFails: true } }));
    expect(e.code).toBe('common.internal');
    expect(await accessRows(e.probe.requestId)).toHaveLength(0);
  });
});

describe('H2 access log (REQ-SEC-096/097, review #18)', () => {
  it('every read writes exactly one audit.access_log row: home_visit.view / entity home_visit / entity_id = visit / purpose visit_detail / outcome allowed / the callers actor + membership / the request id', { timeout: T }, async () => {
    const before = (await viewRows(TENANT_A, S.assigned2.id, 'visit_detail')).length;
    const r = await getVisit(S.assigned2.id);
    const mine = await accessRows(r.probe.requestId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ tenant_id: TENANT_A, action: 'home_visit.view', entity_type: 'home_visit', entity_id: S.assigned2.id, purpose_code: 'visit_detail', outcome: 'allowed',
      actor_id: SYS_ACTOR, membership_id: DISPATCHER.membershipId, request_id: r.probe.requestId });
    expect((await viewRows(TENANT_A, S.assigned2.id, 'visit_detail')).length).toBe(before + 1);
    await getVisit(S.assigned2.id);
    expect((await viewRows(TENANT_A, S.assigned2.id, 'visit_detail')).length).toBe(before + 2);   // one per read, not once per visit
  });
  it('the row carries no patient data: not the name, phone or address (detail is codes / counts only)', { timeout: T }, async () => {
    const r = await getVisit(S.unassigned.id);
    const text = JSON.stringify(await accessRows(r.probe.requestId));
    for (const bad of [nameOf(S.unassigned.patient_id), phoneOf(S.unassigned.patient_id), 'Synthetic Lane 1', 'Near the synthetic temple']) expect(text, bad).not.toContain(bad);
  });
  it('an unknown / foreign / forbidden read writes no allowed row', { timeout: T }, async () => {
    const e = await failure(getVisit(uid()));
    expect(await accessRows(e.probe.requestId)).toHaveLength(0);
    const f = await failure(getVisit(S.assignedB.id));
    expect(await accessRows(f.probe.requestId)).toHaveLength(0);
    const n = await failure(getVisit(S.assigned1.id, NOBODY));
    expect(await accessRows(n.probe.requestId)).toHaveLength(0);
  });
});

describe('H2 phlebotomist-only actor (§5.4 rule 2; US-04-3, 07-SECURITY probe 3)', () => {
  it('own visit: 200 with the assignee allowlist (name, address, registration_no) and the visit_detail log row under their membership', { timeout: T }, async () => {
    const r = await getVisit(S.assigned1.id, PHLEBO);
    expect(r.status).toBe(200);
    expect(responseErrors('getHomeVisit', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: S.assigned1.id, patient_display_name: nameOf(S.assigned1.patient_id), registration_no: regOf(S.assigned1.order_id), address: { address_text: LONG_ADDRESS } });
    expect(JSON.stringify(r.body)).not.toContain(phoneOf(S.assigned1.patient_id));
    const rows = await accessRows(r.probe.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose_code: 'visit_detail', membership_id: PHLEBO.membershipId, entity_id: S.assigned1.id, outcome: 'allowed' });
    expect((await getVisit(S.done.id, PHLEBO)).status).toBe(200);   // closed visits stay readable by their assignee
  });
  it('another phlebotomists visit, an unassigned visit: 403 homecollection.visit_not_assigned; nothing is fetched from any port and no allowed access-log row appears', { timeout: T }, async () => {
    for (const [v, who] of [[S.assignedOther, PHLEBO], [S.unassigned, PHLEBO], [S.unassignedBooking, PHLEBO], [S.assigned1, PHLEBO2]] as const) {
      const e = await failure(getVisit(v.id, who));
      expect(e.code, v.id).toBe('homecollection.visit_not_assigned');
      expect(e.statusCode).toBe(403);
      expect(e.probe.single).toHaveLength(0); expect(e.probe.orderSummary).toHaveLength(0); expect(e.probe.balance).toHaveLength(0);
      expect((await ownerRows('audit.access_log', "request_id = $1 AND outcome = 'allowed'", [e.probe.requestId]))).toHaveLength(0);
      expect(JSON.stringify({ code: e.code, message: e.message })).not.toContain(nameOf(v.patient_id));
    }
  });
  it('visibility comes first (§5.4 rule 1): a visit that does not exist or belongs to another tenant is 404 common.not_found for a phlebotomist too, not 403', { timeout: T }, async () => {
    expect((await failure(getVisit(uid(), PHLEBO))).code).toBe('common.not_found');
    expect((await failure(getVisit(S.assignedB.id, PHLEBO))).code).toBe('common.not_found');
  });
  it('a holder of visit.assign is not restricted to own visits', { timeout: T }, async () => {
    for (const v of [S.assigned1, S.assignedOther, S.unassigned]) expect((await getVisit(v.id, DISPATCHER)).status).toBe(200);
    expect((await getVisit(S.assignedOther.id, { ...PHLEBO, grants: [P.read, P.sync, P.assign] })).status).toBe(200);
  });
});

describe('H2 authorization + tenant isolation (probe 1)', () => {
  it('no visit.read -> auth.forbidden; assertRole is called with the VISITS centre (§5.4 rule 1) after the visit was loaded', { timeout: T }, async () => {
    const e = await failure(getVisit(S.assigned1.id, NOBODY));
    expect(e.code).toBe('auth.forbidden');
    expect(e.probe.identity.calls).toContainEqual({ permission: P.read, centreId: HC_CENTRE.a });
    expect(e.probe.single).toHaveLength(0);
    const ok = await getVisit(S.assigned1.id);
    expect(ok.probe.identity.calls).toContainEqual({ permission: P.read, centreId: HC_CENTRE.a });
  });
  it('tenant isolation: A cannot read B (also with RLS bypassed), B cannot read A, both 404 common.not_found, no port call, no log row', { timeout: T }, async () => {
    for (const [id, who] of [[S.assignedB.id, DISPATCHER], [S.assigned1.id, DISPATCHER_B]] as const) {
      for (const bypassRls of [false, true]) {
        const e = await failure(getVisit(id, who, { bypassRls }));
        expect(e.code, `${id} bypass=${bypassRls}`).toBe('common.not_found');
        expect(e.probe.single).toHaveLength(0);
      }
    }
    expect((await viewRows(TENANT_B, S.assignedB.id)).length).toBe(0);
    expect((await viewRows(TENANT_A, S.assigned1.id, 'visit_detail')).filter((x) => x.membership_id === DISPATCHER_B.membershipId)).toHaveLength(0);
    expect((await getVisit(S.assignedB.id, DISPATCHER_B)).body.id).toBe(S.assignedB.id);
  });
  it('injection in the path id: 404 / 400, never a 500; nothing is dropped', { timeout: T }, async () => {
    for (const id of ["' OR 1=1 --", "00000000-0000-7000-8000-000000000000'; DROP TABLE homecollection.visits; --", '../../etc/passwd']) {
      expect(['common.not_found', 'common.validation_failed'], id).toContain((await failure(getVisit(id))).code);
    }
    expect((await ownerRows('homecollection.visits', 'tenant_id = $1', [TENANT_A])).length).toBeGreaterThan(0);
  });
});
