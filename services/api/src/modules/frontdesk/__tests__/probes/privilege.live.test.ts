// FD-T16 / 07-SECURITY §6.4 privilege-escalation probes for the frontdesk-owned rows of the table (approve discount, anonymise patient, settings, cash registration without
// billing.invoice.issue, locked account / revoked membership on privileged actions, self-approval) + the "Plus:" list for FrontdeskPort (purposes, createOrderFromBooking sources).
// Actor without the permission -> 403 auth.forbidden; permission at aal1 -> 403 auth.mfa_required; in both cases NOTHING changes in the database.
// Modelled like ../admin/helpers.ts and ../approvals/helpers.ts: the IdentityPort fake mirrors packages/fakes IdentityPort.fake assertRole (no grant -> forbidden; privileged at aal1 -> mfa_required).
// Billing / export / refund / cash-session rows of the table belong to BL-T22 (billing/__tests__/probes). The core pipeline's own x-permission + aal2 enforcement is static-checked in registry.static.test.ts.
import { describe, expect, it } from 'vitest';
import { ALL_USER_PERMS, PERMS as PORT_PERMS, asUser, booking, createFails, creator, fails as portFails, fullPatient, without } from '../contract/helpers.js';
import { prepare } from '../registration/helpers.js';
import { seedPatient } from '../patients/helpers.js';
import { A1_ONLY, FULL_A, INVOICE_ISSUE, PERMS, T, TENANT_A, as, codeOf, fire, mid, objs, ownerRows, requestFor, snapshot, uid } from './kit.js';

const without1 = (perm: string) => PERMS.filter((p) => p !== perm);
const PRIV_OPS = [
  { id: 'approveDiscount', perm: 'frontdesk.discount.approve', obj: 'approval' },
  { id: 'anonymisePatient', perm: 'frontdesk.patient.anonymise', obj: 'patient' },
  { id: 'getFrontdeskSettings', perm: 'frontdesk.settings.manage', obj: 'settings' },
  { id: 'updateFrontdeskSettings', perm: 'frontdesk.settings.manage', obj: 'settings' },
] as const;

describe.each(PRIV_OPS.map((o) => [o.id, o] as const))('%s (privileged: %s)', (_id, o) => {
  it('without the permission => 403 auth.forbidden, database unchanged', { timeout: T }, async () => {
    const S = await objs('a'); const before = await snapshot(TENANT_A);
    const out = await fire(o.id, requestFor(o.id, S), as(FULL_A, { grants: without1(o.perm) }));
    expect(out.reply, `answered ${out.reply?.status}`).toBeUndefined();
    expect(codeOf(out), `${out.error?.message}`).toBe('auth.forbidden');
    expect(await snapshot(TENANT_A)).toEqual(before);
  });
  it('with the permission at aal1 => 403 auth.mfa_required, database unchanged', { timeout: T }, async () => {
    const S = await objs('a'); const before = await snapshot(TENANT_A);
    const out = await fire(o.id, requestFor(o.id, S), as(FULL_A, { mfa: 'aal1' }));
    expect(out.reply, `answered ${out.reply?.status}`).toBeUndefined();
    expect(codeOf(out), `${out.error?.message}`).toBe('auth.mfa_required');
    expect(await snapshot(TENANT_A)).toEqual(before);
  });
  it.each([['locked account', 'auth.account_locked'], ['revoked membership (IdentityPort re-validation)', 'auth.forbidden']] as const)('%s => the IdentityPort refusal propagates unchanged, database unchanged', { timeout: T }, async (_n, code) => {
    const S = await objs('a'); const before = await snapshot(TENANT_A);
    const out = await fire(o.id, requestFor(o.id, S), as(FULL_A, { refuse: code }));
    expect(out.reply, `answered ${out.reply?.status}`).toBeUndefined();
    expect(codeOf(out), `${out.error?.message}`).toBe(code);
    expect(await snapshot(TENANT_A)).toEqual(before);
  });
});

describe('F18 approveDiscount: self-approval', () => {
  it('a user holding both frontdesk.discount.apply and .approve cannot approve their own request: 403 frontdesk.discount_self_approval_forbidden', { timeout: T }, async () => {
    const S = await objs('a');
    const both = as(FULL_A, { membershipId: mid('a', 502) });
    const req1 = await fire('requestDiscountApproval', requestFor('requestDiscountApproval', S), both);
    expect(req1.reply?.status, `${req1.error?.message}`).toBe(201);
    const id = req1.reply!.body.id as string;
    const own = await fire('approveDiscount', { params: { approval_id: id }, query: {}, headers: { 'idempotency-key': uid(), 'if-match': '"1"' }, body: {} }, both);
    expect(codeOf(own), `${own.error?.message}`).toBe('frontdesk.discount_self_approval_forbidden');
    expect((await ownerRows('frontdesk.discount_approvals', 'id = $1', [id]))[0].status).toBe('pending');
    const other = await fire('approveDiscount', { params: { approval_id: id }, query: {}, headers: { 'idempotency-key': uid(), 'if-match': '"1"' }, body: {} }, as(FULL_A, { membershipId: mid('a', 500) }));
    expect(other.reply?.status, `${other.error?.message}`).toBe(200);                                         // control: a different approver succeeds
    expect((await ownerRows('frontdesk.discount_approvals', 'id = $1', [id]))[0].status).toBe('approved');
  });
});

describe('F9 createRegistration: cash registration without billing.invoice.issue (centre_staff)', () => {
  it('=> 403 auth.forbidden, no order, no payment', { timeout: T }, async () => {
    const p = await prepare({ side: 'a' });
    const out = await fire('createRegistration', { params: {}, query: {}, headers: { 'idempotency-key': uid() }, body: p.body }, as(A1_ONLY, { grants: [...PERMS].filter((x) => x !== INVOICE_ISSUE) }), { w: p.w });
    expect(out.reply, `answered ${out.reply?.status}`).toBeUndefined();
    expect(codeOf(out), `${out.error?.message}`).toBe('auth.forbidden');
    expect((await ownerRows('frontdesk.orders', 'patient_id = $1', [p.patient.id])).length).toBe(0);
    expect(p.w.billingFake.calls('recordPayment')).toHaveLength(0);
    expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
  });
  it('without frontdesk.registration.create => 403 auth.forbidden', { timeout: T }, async () => {
    const p = await prepare({ side: 'a' });
    const out = await fire('createRegistration', { params: {}, query: {}, headers: { 'idempotency-key': uid() }, body: p.body }, as(A1_ONLY, { grants: without1('frontdesk.registration.create') }), { w: p.w });
    expect(codeOf(out), `${out.error?.message}`).toBe('auth.forbidden');
    expect((await ownerRows('frontdesk.orders', 'patient_id = $1', [p.patient.id])).length).toBe(0);
  });
});

describe('F7 anonymisePatient: a front-desk operator (registration.create + reads) is refused and nothing is erased', () => {
  it('=> 403 auth.forbidden, the demographics survive', { timeout: T }, async () => {
    const p = await seedPatient('a', { full_name: 'Probe Keep Name', email: 'probe.keep@example.invalid' });
    const out = await fire('anonymisePatient', { params: { patient_id: p.id }, query: {}, headers: { 'idempotency-key': uid(), 'if-match': '"1"' }, body: { reason_code: 'patient_request' } },
      as(A1_ONLY, { grants: ['frontdesk.registration.create', 'frontdesk.patient.read', 'frontdesk.order.read'], mfa: 'aal1' }));
    expect(codeOf(out)).toBe('auth.forbidden');
    const row = (await ownerRows('frontdesk.patients', 'id = $1', [p.id]))[0];
    expect([row.full_name, row.email, row.anonymised_at]).toEqual(['Probe Keep Name', 'probe.keep@example.invalid', null]);
  });
});

describe('FrontdeskPort "Plus:" rows of §6.4 (full matrix: ../contract/FrontdeskPort.contract.test.ts, FD-T11)', () => {
  it('getPatientDemographics with a purpose whose permission the user lacks => auth.forbidden', { timeout: T }, async () => {
    const pt = await fullPatient('a');
    for (const [purpose, drop] of [['lab_display', [PORT_PERMS.worklist, PORT_PERMS.statusBoard]], ['patient_app_link', [PORT_PERMS.linkIssue]]] as const) {
      const e = await portFails(asUser(without(...drop)), (p, c) => p.getPatientDemographics(c, { patientId: pt.id, purpose }));
      expect(e.code, purpose).toBe('auth.forbidden');
    }
    expect((await portFails(asUser(ALL_USER_PERMS), (p, c) => p.getPatientDemographics(c, { patientId: pt.id, purpose: 'instrument_host_query' }))).code).toBe('auth.forbidden');   // device/system only
  });
  it('createOrderFromBooking: source engagement_booking by a user actor, or home_collection without homecollection.visit.assign => auth.forbidden (08 R7)', { timeout: T }, async () => {
    const pt = await fullPatient('a');
    expect((await createFails(booking('engagement_booking', { patientId: pt.id }), asUser(ALL_USER_PERMS))).code).toBe('auth.forbidden');
    expect((await createFails(booking('home_collection', { patientId: pt.id }), asUser(without(PORT_PERMS.visitAssign)))).code).toBe('auth.forbidden');
    expect(creator('engagement_booking').actor).toBe('system');                                                 // the legitimate caller is the system actor
  });
});
