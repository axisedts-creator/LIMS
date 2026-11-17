// FD-T07 F15 requestDiscountApproval (US-FD-07.2 first half; 02-TRD §5.2 row F15; 03-APP-FLOW §1.3 + §2.7; 07-SECURITY F15 abuse row, REQ-SEC-024 tenant/centre).
// Fails now: handlers/requestDiscountApproval.ts is a stub (common.service_unavailable).
// NOT TESTED (spec gap, see .orchestra/notes/FD-T07-tests.md): gross / percent_of_gross_bp / the absolute-max 422 (F15 gets only base_fingerprint + discounts, no lines or gross);
//   the DB `draft_hash` normalisation (new-patient draft); rate limit.
import { describe, expect, it } from 'vitest';
import { schemaErrors } from '../patients/helpers.js';
import { CENTRE, CENTRE_A2, MIN, NOW, OTHER, P, REQUESTER, T, TENANT_B, as, approvalRow, bill30, hex64, newApproval, ownerRows, request, requestFails, seedPatient } from './helpers.js';

const rowsFor = (patientId: string) => ownerRows('frontdesk.discount_approvals', 'patient_id = $1', [patientId]);

describe('US-FD-07.2 request: a pending approval bound to base_fingerprint + discounts + patient + centre', () => {
  it('201 pending; requester + 15 min TTL (LIMS_FRONTDESK_APPROVAL_TTL_MINUTES default); row binds fingerprint, discounts, patient, centre; DTO is schema-valid and leaks no binding internals', async () => {
    const a = await newApproval();
    expect(a.r.status).toBe(201);
    expect(a.approval).toMatchObject({ status: 'pending', centre_id: CENTRE.a, version: 1, reason_code: 'staff_family',
      requested_by: { membership_id: REQUESTER.membershipId, display_name: REQUESTER.displayName } });
    expect(a.approval.discounts).toEqual(a.body.discounts);
    expect(new Date(a.approval.expires_at).getTime()).toBe(NOW.getTime() + 15 * MIN);
    expect(schemaErrors('DiscountApproval', a.approval)).toEqual([]);
    for (const k of ['patient_id', 'draft_hash', 'base_fingerprint', 'tenant_id']) expect(a.approval, k).not.toHaveProperty(k);
    const row = await approvalRow(a.id);
    expect(row).toMatchObject({ status: 'pending', base_fingerprint: a.body.base_fingerprint, patient_id: a.patient.id, draft_hash: null, centre_id: CENTRE.a,
      requested_by_membership_id: REQUESTER.membershipId, decided_by_membership_id: null, decided_at: null, consumed_order_id: null, consumed_at: null, reason_code: 'staff_family', version: 1 });
    expect(new Date(row.expires_at).getTime()).toBe(NOW.getTime() + 15 * MIN);
  }, T);

  it('reason_text is stored and echoed; an amount discount reports its own paisa as computed_discount', async () => {
    const a = await newApproval({ over: { reason_text: 'Synthetic staff family discount', discounts: [{ scope: 'bill', kind: 'amount', amount_paisa: 12345, reason_code: 'staff_family' }] } });
    expect(a.approval.reason_text).toBe('Synthetic staff family discount');
    expect(a.approval.computed_discount.amount_paisa).toBe(12345);
    expect(Number((await approvalRow(a.id)).computed_discount_paisa)).toBe(12345);
  }, T);

  it('a new-patient draft binds by draft_hash instead of a patient id (exactly one of the two is stored)', async () => {
    const h = hex64();
    const r = await request({ centre_id: CENTRE.a, base_fingerprint: hex64(), discounts: [bill30()], reason_code: 'staff_family', patient_ref: { draft_hash: h } });
    expect(r.status).toBe(201);
    expect(await approvalRow(r.body.id)).toMatchObject({ patient_id: null, draft_hash: h, status: 'pending' });
  }, T);

  it('two requests for the same patient/fingerprint are two independent approvals (no silent reuse of a previous one)', async () => {
    const a = await newApproval();
    const b = await newApproval({ patient: a.patient, over: { base_fingerprint: a.body.base_fingerprint } });
    expect(b.id).not.toBe(a.id);
    expect(await rowsFor(a.patient.id)).toHaveLength(2);
  }, T);
});

describe('request validation (400 common.validation_failed with JSON-pointer paths), nothing stored', () => {
  const cases: Array<[string, (p: string) => Record<string, unknown>, string | undefined]> = [
    ['reason_code missing', (p) => ({ reason_code: undefined, patient_ref: { patient_id: p } }), '/reason_code'],
    ['discounts empty (minItems 1)', (p) => ({ discounts: [], patient_ref: { patient_id: p } }), '/discounts'],
    ['21 discounts (maxItems 20)', (p) => ({ discounts: Array.from({ length: 21 }, bill30), patient_ref: { patient_id: p } }), '/discounts'],
    ['base_fingerprint not 64 hex', (p) => ({ base_fingerprint: 'xyz', patient_ref: { patient_id: p } }), '/base_fingerprint'],
    ['base_fingerprint upper-case hex', (p) => ({ base_fingerprint: 'A'.repeat(64), patient_ref: { patient_id: p } }), '/base_fingerprint'],
    ['patient_ref names both a patient and a draft hash', (p) => ({ patient_ref: { patient_id: p, draft_hash: hex64() } }), '/patient_ref'],
    ['patient_ref missing', () => ({ patient_ref: undefined }), '/patient_ref'],
    ['reason_text 501 chars', (p) => ({ reason_text: 'x'.repeat(501), patient_ref: { patient_id: p } }), '/reason_text'],
    ['a discount without its own reason_code', (p) => ({ discounts: [{ scope: 'bill', kind: 'percent', percent_bp: 3000 }], patient_ref: { patient_id: p } }), '/discounts/0/reason_code'],
    ['unknown field (price tampering, 07-SECURITY A1)', (p) => ({ unit_price: 1, patient_ref: { patient_id: p } }), undefined],
  ];
  for (const [name, mutate, path] of cases) {
    it(name, async () => {
      const patient = await seedPatient('a');
      const body: Record<string, unknown> = { centre_id: CENTRE.a, base_fingerprint: hex64(), discounts: [bill30()], reason_code: 'staff_family', patient_ref: { patient_id: patient.id }, ...mutate(patient.id) };
      for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
      const e = await requestFails(body);
      expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
      if (path) expect((e.errors ?? []).map((x: any) => x.path)).toContain(path);
      expect(await rowsFor(patient.id)).toHaveLength(0);
    }, T);
  }
});

describe('request authority + scope', () => {
  it('without frontdesk.discount.apply -> 403 auth.forbidden, nothing stored', async () => {
    const patient = await seedPatient('a');
    const e = await requestFails({ centre_id: CENTRE.a, base_fingerprint: hex64(), discounts: [bill30()], reason_code: 'staff_family', patient_ref: { patient_id: patient.id } }, as(REQUESTER, { grants: [P.reg, P.inv] }));
    expect(e.code).toBe('auth.forbidden'); expect(e.statusCode).toBe(403);
    expect(await rowsFor(patient.id)).toHaveLength(0);
  }, T);

  it('a centre outside the caller\'s scope -> 404 common.not_found (the centre is not confirmed to exist), nothing stored', async () => {
    const patient = await seedPatient('a');
    const e = await requestFails({ centre_id: CENTRE_A2, base_fingerprint: hex64(), discounts: [bill30()], reason_code: 'staff_family', patient_ref: { patient_id: patient.id } });
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
    expect(await rowsFor(patient.id)).toHaveLength(0);
  }, T);

  it('tenant B\'s centre and tenant B\'s patient are invisible to tenant A: 404 common.not_found, no row in either tenant', async () => {
    const mine = await seedPatient('a'), theirs = await seedPatient('b');
    const base = { base_fingerprint: hex64(), discounts: [bill30()], reason_code: 'staff_family' };
    const e1 = await requestFails({ ...base, centre_id: CENTRE.b, patient_ref: { patient_id: mine.id } });
    const e2 = await requestFails({ ...base, centre_id: CENTRE.a, patient_ref: { patient_id: theirs.id } });
    for (const e of [e1, e2]) { expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); }
    expect(await rowsFor(mine.id)).toHaveLength(0);
    expect(await rowsFor(theirs.id)).toHaveLength(0);
    expect(await ownerRows('frontdesk.discount_approvals', 'tenant_id = $1 AND base_fingerprint = $2', [TENANT_B, base.base_fingerprint])).toHaveLength(0);
  }, T);

  it('an unknown patient id -> 404 common.not_found', async () => {
    const e = await requestFails({ centre_id: CENTRE.a, base_fingerprint: hex64(), discounts: [bill30()], reason_code: 'staff_family', patient_ref: { patient_id: '01a1a98a-ac40-7000-8000-0000ffff0001' } });
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
  }, T);

  it('requesting never needs (or grants) approval authority: a caller holding only apply is accepted and the row is still pending', async () => {
    const a = await newApproval({ who: OTHER });
    expect(a.r.status).toBe(201);
    expect((await approvalRow(a.id)).status).toBe('pending');
  }, T);
});
