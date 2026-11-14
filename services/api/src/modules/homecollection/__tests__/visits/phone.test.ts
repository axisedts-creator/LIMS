// HC-T08 H21 revealHomeVisitPhone (POST /v1/homecollection/visits/{visit_id}/phone-reveal, homecollection.visit.assign, body {}). 02-TRD §5 H21 (`{phone_e164?}` from FrontdeskPort.getPatientDemographics({patientId,
// purpose:'home_visit'}); absent when the patient has no phone; the ONLY write is the access-log row `home_visit.view`, purpose `phone_reveal`, review #18; port errors propagate), §14 access-log table,
// REQ-SEC-081/096/097 (phone shown only on an explicit, audited reveal — H1/H2 carry none), 04-UI-UX (masked until "Show"), 07-SECURITY probe 1 (cross-tenant) + probe 5 (phlebotomist calling H21 -> 403 auth.forbidden)
// + §6 (no patient data in logs). ACs US-06-5, US-16-2. Fails now: H21 is an HC-T01 stub.
import { beforeAll, describe, expect, it } from 'vitest';
import { DISPATCHER, DISPATCHER_B, HC_CENTRE, NOBODY, P, PHLEBO, SYS_ACTOR, T, TENANT_A, accessRows, buildScenario, failure, nameOf, ownerRows, phoneOf, responseErrors, revealPhone, uid, viewRows,
  type Scenario } from './helpers.js';

let S: Scenario;
beforeAll(async () => { S = await buildScenario('2027-03-06'); }, T);

describe('H21 reveal', () => {
  it('200 {phone_e164}: the number the port returned for this visits patient, nothing else; schema-valid', { timeout: T }, async () => {
    const v = S.assigned1;
    const r = await revealPhone(v.id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ phone_e164: phoneOf(v.patient_id) });
    expect(responseErrors('revealHomeVisitPhone', r.body)).toEqual([]);
    expect(r.probe.single).toEqual([{ patientId: v.patient_id, purpose: 'home_visit' }]);
    expect(r.probe.batch).toHaveLength(0);
  });
  it('a patient without a phone: 200 with NO phone_e164 key (not null, not empty); the reveal is still logged', { timeout: T }, async () => {
    const v = S.assigned2;
    const r = await revealPhone(v.id, DISPATCHER, { fx: { noPhone: [v.patient_id] } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
    expect(responseErrors('revealHomeVisitPhone', r.body)).toEqual([]);
    expect(await accessRows(r.probe.requestId)).toHaveLength(1);
  });
  it('works for any visit state the dispatcher can see (completed too) and for an unassigned visit', { timeout: T }, async () => {
    for (const v of [S.done, S.unassigned, S.assignedOther]) expect((await revealPhone(v.id)).body.phone_e164, v.id).toBe(phoneOf(v.patient_id));
  });
});

describe('H21 access log (REQ-SEC-096/097, review #18)', () => {
  it('exactly one audit.access_log row per reveal: home_visit.view / home_visit / entity_id = visit / purpose phone_reveal / allowed / callers actor + membership / request id; one per call, no dedupe', { timeout: T }, async () => {
    const v = S.assigned1;
    const before = (await viewRows(TENANT_A, v.id, 'phone_reveal')).length;
    const r = await revealPhone(v.id);
    const rows = await accessRows(r.probe.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, action: 'home_visit.view', entity_type: 'home_visit', entity_id: v.id, purpose_code: 'phone_reveal', outcome: 'allowed', actor_id: SYS_ACTOR,
      membership_id: DISPATCHER.membershipId, request_id: r.probe.requestId });
    await revealPhone(v.id);
    expect((await viewRows(TENANT_A, v.id, 'phone_reveal')).length).toBe(before + 2);
    expect((await viewRows(TENANT_A, v.id, 'visit_detail')).filter((x) => x.request_id === r.probe.requestId)).toHaveLength(0);   // a reveal is not a visit_detail read
  });
  it('the number is never stored or logged: not in the access-log row, not in any ctx.log line (REQ-SEC-081, 07 §6); the only write is that row', { timeout: T }, async () => {
    const v = S.assigned1;
    const r = await revealPhone(v.id);
    const text = JSON.stringify(await accessRows(r.probe.requestId)) + r.probe.logs.join('\n');
    for (const bad of [phoneOf(v.patient_id), phoneOf(v.patient_id).slice(4), nameOf(v.patient_id)]) expect(text, bad).not.toContain(bad);
    const visits = await ownerRows('homecollection.visits', 'id = $1', [v.id]);
    expect(JSON.stringify(visits)).not.toContain(phoneOf(v.patient_id));
    expect(visits[0].version).toBe(1);                                         // no state change, no version bump (the fixture row is at the DB default 1)
    expect(await ownerRows('homecollection.visit_transitions', 'visit_id = $1', [v.id])).toHaveLength(0);
  });
  it('a port error propagates unchanged (auth.forbidden / common.not_found) and the request writes no access-log row (rolled back with the failed request)', { timeout: T }, async () => {
    const f = await failure(revealPhone(S.assigned1.id, DISPATCHER, { fx: { demoFails: true } }));
    expect(f.code).toBe('auth.forbidden');
    expect(await accessRows(f.probe.requestId)).toHaveLength(0);
    const n = await failure(revealPhone(S.assigned1.id, DISPATCHER, { fx: { omit: [S.assigned1.patient_id] } }));
    expect(n.code).toBe('common.not_found');
    expect(await accessRows(n.probe.requestId)).toHaveLength(0);
  });
});

describe('H21 authorization + tenant isolation (probes 1 + 5)', () => {
  it('a phlebotomist (visit.read + sync.upload) and an actor with no grant -> 403 auth.forbidden, even for their own assigned visit; assertRole(visit.assign) for the visits centre; the port is never called, nothing is logged', { timeout: T }, async () => {
    for (const who of [PHLEBO, NOBODY, { ...PHLEBO, grants: [P.read] }]) {
      const e = await failure(revealPhone(S.assigned1.id, who));
      expect(e.code).toBe('auth.forbidden');
      expect(e.statusCode).toBe(403);
      expect(e.probe.single).toHaveLength(0);
      expect(await accessRows(e.probe.requestId)).toHaveLength(0);
    }
    const ok = await revealPhone(S.assigned1.id);
    expect(ok.probe.identity.calls).toContainEqual({ permission: P.assign, centreId: HC_CENTRE.a });
  });
  it('unknown id and other tenants visit -> 404 common.not_found (also with RLS bypassed): no port call, no log row; each tenant can reveal its own', { timeout: T }, async () => {
    for (const [id, who] of [[uid(), DISPATCHER], [S.assignedB.id, DISPATCHER], [S.assigned1.id, DISPATCHER_B]] as const) {
      for (const bypassRls of [false, true]) {
        const e = await failure(revealPhone(id, who, { bypassRls }));
        expect(e.code, `${id} bypass=${bypassRls}`).toBe('common.not_found');
        expect(e.probe.single).toHaveLength(0);
        expect(await accessRows(e.probe.requestId)).toHaveLength(0);
      }
    }
    expect((await revealPhone(S.assignedB.id, DISPATCHER_B)).body.phone_e164).toBe(phoneOf(S.assignedB.patient_id));
    expect((await viewRows(TENANT_A, S.assignedB.id)).length).toBe(0);
  });
  it('injection in the path id: 404 / 400, never a 500; nothing is dropped', { timeout: T }, async () => {
    for (const id of ["' OR 1=1 --", "00000000-0000-7000-8000-000000000000'; DROP TABLE audit.access_log; --"]) {
      expect(['common.not_found', 'common.validation_failed'], id).toContain((await failure(revealPhone(id))).code);
    }
    expect((await ownerRows('audit.access_log', 'tenant_id = $1', [TENANT_A])).length).toBeGreaterThan(0);
  });
});
