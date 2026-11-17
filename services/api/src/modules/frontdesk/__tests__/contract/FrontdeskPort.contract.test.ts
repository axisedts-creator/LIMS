// FD-T11 FrontdeskPort contract on the REAL impl (ports/FrontdeskPort.impl.ts + service/booking.service.ts) over a real PG17 tx under RLS, real Catalog/BillingCommand/Lab fakes.
// Cases: 03-IC §4.3 (1)-(10), 08 (11)-(18), C4 (19)-(20) [02-TRD §6.1]; purpose allowlist + permission table (TRD §6.1); per-source authorisation of createOrderFromBooking (08 R7);
// booking defaults (TRD §6.1, review C4 #25); self-registration shape (PLAN FD-T11); US-FD-12.5; 07-SECURITY (port probes, actor guard first, no access_log, no PHI in errors, injection, races).
// Part 2 (createOrderFromBooking, consumers, self-registration, security): FrontdeskPort.booking.contract.test.ts. Harness + ASSUMED seams: ./helpers.ts.
// Fails now: ports/FrontdeskPort.impl.ts (imported by ./helpers.ts) does not exist, so the import cannot resolve.
// Not covered (see .orchestra/notes/FD-T11-tests.md): consumer inbox/seq/duplicate-event handling and centre_visit cancel (FD-T12), portal/partner/device positive paths (RLS makes C4 tables invisible to them, 08 R8),
//   frontdesk.patient_duplicate_suspected on createOrderFromBooking (in the IC @throws, in no contract case), performance budgets.
import { beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../integration/helpers.js';
import { ALL_USER_PERMS, CENTRE, CENTRE_A2, CONSENT_VERSION, PARTNER, PERMS, T, TENANT_A, TENANT_B, asSystem, asUser, booking, create, creator, fails, fullPatient, run, scenario, seedPatient, uid, without } from './helpers.js';

beforeAll(async () => { await run(asSystem(), async () => undefined); }, T);   // seeds settings (consent v1) + task registry once
const SYS_ALL = asSystem(ALL_USER_PERMS);

describe('getOrderSummary: cases (1) (2) (19) (20), shape, derived status', () => {
  it('(1) an order of another tenant -> common.not_found (a tenant-b order id under tenant-a ctx; and the reverse)', async () => {
    const b = await scenario({ side: 'b', items: ['not_started'] });
    expect((await fails(asUser([PERMS.orderRead]), (p, c) => p.getOrderSummary(c, { orderId: b.order.id }))).code).toBe('common.not_found');
    const a = await scenario({ items: ['not_started'] });
    expect((await fails(asUser([PERMS.orderRead], { tenant: TENANT_B }), (p, c) => p.getOrderSummary(c, { orderId: a.order.id }))).code).toBe('common.not_found');
    expect((await fails(SYS_ALL, (p, c) => p.getOrderSummary(c, { orderId: uid() }))).code).toBe('common.not_found');
  }, T);

  it('(2) a centre-scoped user cannot read another centre\'s order (common.not_found); a user scoped to both can', async () => {
    const s = await scenario({ items: ['not_started'], centre: CENTRE_A2 });
    const o = (centreIds: string[]) => asUser([PERMS.orderRead], { centreIds, lab: s.lab });
    expect((await fails(o([CENTRE.a]), (p, c) => p.getOrderSummary(c, { orderId: s.order.id }))).code).toBe('common.not_found');
    expect((await run(o([CENTRE.a, CENTRE_A2]), (p, c) => p.getOrderSummary(c, { orderId: s.order.id }))).orderId).toBe(s.order.id);
  }, T);

  it('returns the OrderSummary of 03-IC §4.3: ids, branch/centre, visitType, billingMode, priority, source front_desk without sourceRefId, active items with testIds, version, registeredAt', async () => {
    const s = await scenario({ items: ['not_started', 'not_started'], order: { priority: 'urgent' } });
    const r = await run(asUser([PERMS.orderRead], { lab: s.lab }), (p, c) => p.getOrderSummary(c, { orderId: s.order.id }));
    expect(r).toMatchObject({ orderId: s.order.id, registrationNo: s.order.registration_no, patientId: s.patient.id, branchId: s.order.branch_id, centreId: CENTRE.a, visitType: 'opd',
      billingMode: 'cash', priority: 'urgent', status: 'registered', source: 'front_desk', version: 1 });
    expect(r).not.toHaveProperty('sourceRefId');
    expect(r).not.toHaveProperty('partnerId');
    expect(new Date(r.registeredAt).toISOString()).toBe('2026-11-07T00:00:00.000Z');
    expect(r.items).toHaveLength(2);
    for (const it of r.items) expect(it).toMatchObject({ orderableKind: 'test', status: 'active', priority: 'routine', outsourced: expect.any(Boolean) });
    expect(r.items.map((i: any) => i.orderItemId).sort()).toEqual(s.items.map((i) => i.id).sort());
    expect(r.items[0].testIds).toEqual(expect.any(Array));
    for (const k of Object.keys(r)) expect(['orderId', 'registrationNo', 'patientId', 'branchId', 'centreId', 'visitType', 'billingMode', 'creditPartyId', 'referrerId', 'priority', 'status', 'source', 'sourceRefId', 'items', 'registeredAt', 'version', 'partnerId']).toContain(k);
  }, T);

  it('(19) C14 caller: patientId, centreId, registrationNo, status; works for a system actor and for a user holding frontdesk.order.read', async () => {
    const s = await scenario({ items: ['in_progress'] });
    for (const o of [asSystem([], { lab: s.lab }), asUser([PERMS.orderRead], { lab: s.lab })]) {
      const r = await run(o, (p, c) => p.getOrderSummary(c, { orderId: s.order.id }));
      expect(r).toMatchObject({ patientId: s.patient.id, centreId: CENTRE.a, registrationNo: s.order.registration_no, status: 'in_progress' });
    }
  }, T);

  it('(20) C15 caller: a cancelled order -> status cancelled WITHOUT a LabPort call, under the payments system actor and a front_desk user; other-tenant order -> not_found', async () => {
    const s = await scenario({ stored: 'cancelled', items: ['not_started'] });
    for (const o of [asSystem([], { lab: s.lab }), asUser([PERMS.orderRead], { lab: s.lab })]) {
      expect((await run(o, (p, c) => p.getOrderSummary(c, { orderId: s.order.id }))).status).toBe('cancelled');
    }
    expect(s.labPortCalls()).toHaveLength(0);
    const other = await scenario({ side: 'b', items: ['not_started'] });
    expect((await fails(asSystem([]), (p, c) => p.getOrderSummary(c, { orderId: other.order.id }))).code).toBe('common.not_found');
  }, T);

  it('stored registered -> derived per 03-IC §10.4 / 08 A13 D-5: reported -> completed, received -> in_progress, via LabPort.getOrderItemProcessingState({orderId}); pre_registered is stored and not derived', async () => {
    const done = await scenario({ items: ['reported', 'cancelled'] });
    expect((await run(asSystem([], { lab: done.lab }), (p, c) => p.getOrderSummary(c, { orderId: done.order.id }))).status).toBe('completed');
    expect(done.labPortCalls().map((x) => x.input.orderId)).toEqual([done.order.id]);
    const wip = await scenario({ items: ['in_progress'] });
    expect((await run(asSystem([], { lab: wip.lab }), (p, c) => p.getOrderSummary(c, { orderId: wip.order.id }))).status).toBe('in_progress');
    const pre = await scenario({ stored: 'pre_registered', items: ['not_started'], order: { registered_at: null } });
    expect((await run(asSystem([], { lab: pre.lab }), (p, c) => p.getOrderSummary(c, { orderId: pre.order.id }))).status).toBe('pre_registered');
    expect(pre.labPortCalls()).toHaveLength(0);
  }, T);

  it('R25: partnerId is returned for a partner_manifest order and sourceRefId for every booking source', async () => {
    const pt = await fullPatient();
    const input = booking('partner_manifest', { patientId: pt.id }, { confirmImmediately: false });
    const made = await create(input, creator('partner_manifest'));
    const r = await run(asSystem([]), (p, c) => p.getOrderSummary(c, { orderId: made.orderId }));
    expect(r).toMatchObject({ source: 'partner_manifest', sourceRefId: input.sourceRefId, partnerId: PARTNER, status: 'pre_registered', registrationNo: made.registrationNo });
  }, T);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const ALLOW: Record<string, string[]> = {
  report_render: ['fullName', 'sex', 'ageAtOrder', 'birthOn', 'patientCode'], label_print: ['fullName', 'sex', 'ageAtOrder', 'patientCode'], notification: ['phoneE164', 'email', 'consents'],
  instrument_host_query: ['sex', 'ageAtOrder'], portal_display: ['fullName', 'sex', 'ageAtOrder'], partner_display: ['fullName', 'sex', 'ageAtOrder'], smart_report: ['sex', 'ageAtOrder'],
  home_visit: ['fullName', 'phoneE164', 'consents', 'birthOn', 'sex'], result_evaluation: ['sex', 'ageAtOrder', 'birthOn'], lab_display: ['fullName', 'sex', 'ageAtOrder', 'patientCode'],
  patient_app_link: ['fullName', 'sex', 'birthOn', 'phoneE164'],
};
/** purposes whose user actors need a specific permission (any ONE of the alternatives), 02-TRD §6.1 table */
const USER_PERM: Record<string, string[]> = {
  report_render: [PERMS.reportRead], label_print: [PERMS.labelPrint], smart_report: [PERMS.smartSummary], home_visit: [PERMS.visitRead], result_evaluation: [PERMS.resultEnter, PERMS.resultVerify],
  lab_display: [PERMS.worklist, PERMS.statusBoard], patient_app_link: [PERMS.linkIssue],
};
const demo = (id: string, purpose: string, o = SYS_ALL) => run(o, (p, c) => p.getPatientDemographics(c, { patientId: id, purpose }));

describe('getPatientDemographics: allowlist by purpose, permissions, cases (3) (4) (14) (15) (18)', () => {
  it('every purpose returns EXACTLY its allowlist (+ patientId, status): nothing outside the table leaks (REQ-SEC-081), consents carry no `processing`', async () => {
    const pt = await fullPatient('a', { full_name: 'Asha Maya Sharma' });
    for (const [purpose, fields] of Object.entries(ALLOW)) {
      const r = await demo(pt.id, purpose);
      expect(Object.keys(r).sort(), purpose).toEqual(['patientId', 'status', ...fields].sort());
      expect(r.patientId).toBe(pt.id);
      expect(r.status).toBe('active');
    }
    const n = await demo(pt.id, 'notification');
    expect(n).toMatchObject({ phoneE164: pt.phone_e164, email: pt.email });
    expect(n.consents).toEqual({ sms: true, whatsapp: false, email: true, shareWithReferrer: false, consentTextVersion: CONSENT_VERSION });
    expect(n).not.toHaveProperty('contactPresence');
    expect(await demo(pt.id, 'report_render')).toMatchObject({ fullName: 'Asha Maya Sharma', sex: 'female', birthOn: '1983-11-10', patientCode: pt.patient_code, ageAtOrder: { years: 43, months: 0, days: 0 } });
  }, T);

  it('portal_display / partner_display: fullName is masked to initials ("A. M. S."), never a full word', async () => {
    const pt = await fullPatient('a', { full_name: 'Asha Maya Sharma' });
    for (const purpose of ['portal_display', 'partner_display']) {
      const r = await demo(pt.id, purpose);
      expect(r.fullName, purpose).toMatch(/^A\.\s?M\.\s?S\.$/);
      expect(JSON.stringify(r)).not.toMatch(/sha|aya|rma/i);
      expect(r).not.toHaveProperty('phoneE164');
    }
  }, T);

  it('(3) instrument_host_query returns no name / phone / email / birth date / code (sex + ageAtOrder only)', async () => {
    const pt = await fullPatient();
    const r = await demo(pt.id, 'instrument_host_query');
    for (const k of ['fullName', 'phoneE164', 'email', 'birthOn', 'patientCode', 'consents']) expect(r).not.toHaveProperty(k);
    expect(r).toMatchObject({ sex: 'female', ageAtOrder: { years: 43, months: 0, days: 0 } });
    expect((await fails(asUser(ALL_USER_PERMS), (p, c) => p.getPatientDemographics(c, { patientId: pt.id, purpose: 'instrument_host_query' }))).code).toBe('auth.forbidden');   // device/system only
  }, T);

  it('(4) notification (system): phoneE164, email and consents of the CURRENT consent row (append-only: the newest wins)', async () => {
    const pt = await fullPatient();
    await seed('frontdesk.patient_consents', { id: uid(), tenant_id: TENANT_A, patient_id: pt.id, processing: true, sms: false, whatsapp: true, email: false, share_with_referrer: true,
      consent_text_version: CONSENT_VERSION, source: 'front_desk', captured_at: '2026-11-09T00:00:00Z' });
    const r = await demo(pt.id, 'notification');
    expect(r.consents).toEqual({ sms: false, whatsapp: true, email: false, shareWithReferrer: true, consentTextVersion: CONSENT_VERSION });
    expect(r.phoneE164).toBe(pt.phone_e164);
  }, T);

  it('(14) lab_display returns no phone / email / birth date / consents, for a worklist.read holder, a status_board.read holder and the system; a user with neither -> auth.forbidden', async () => {
    const pt = await fullPatient();
    for (const o of [asUser([PERMS.worklist]), asUser([PERMS.statusBoard]), asSystem()]) {
      const r = await demo(pt.id, 'lab_display', o);
      expect(Object.keys(r).sort()).toEqual(['ageAtOrder', 'fullName', 'patientCode', 'patientId', 'sex', 'status']);
      expect(JSON.stringify(r)).not.toContain(pt.phone_e164);
    }
    expect((await fails(asUser(without(PERMS.worklist, PERMS.statusBoard)), (p, c) => p.getPatientDemographics(c, { patientId: pt.id, purpose: 'lab_display' }))).code).toBe('auth.forbidden');
  }, T);

  it('(15) notification by a USER actor: consents + contactPresence only, no phoneE164 / email; presence reflects what is on file; a system actor keeps the full set', async () => {
    const both = await fullPatient();
    const phoneOnly = await seedPatient('a', {}, { sms: true });
    const u = asUser(ALL_USER_PERMS);
    const a = await demo(both.id, 'notification', u);
    expect(Object.keys(a).sort()).toEqual(['consents', 'contactPresence', 'patientId', 'status']);
    expect(a.contactPresence).toEqual({ phone: true, email: true });
    expect(JSON.stringify(a)).not.toContain(both.phone_e164);
    expect((await demo(phoneOnly.id, 'notification', u)).contactPresence).toEqual({ phone: true, email: false });
    expect(await demo(both.id, 'notification')).toHaveProperty('phoneE164');
  }, T);

  it('(18) patient_app_link is refused without engagement.link.issue (auth.forbidden) and allowed with it and for the engagement system actor', async () => {
    const pt = await fullPatient();
    expect((await fails(asUser(without(PERMS.linkIssue)), (p, c) => p.getPatientDemographics(c, { patientId: pt.id, purpose: 'patient_app_link' }))).code).toBe('auth.forbidden');
    for (const o of [asUser([PERMS.linkIssue]), asSystem()]) expect(await demo(pt.id, 'patient_app_link', o)).toMatchObject({ fullName: pt.full_name, phoneE164: pt.phone_e164, birthOn: '1983-11-10', status: 'active' });
  }, T);

  it('user actors need the purpose permission (TRD §6.1 table): each alternative alone passes; holding every OTHER permission (incl. frontdesk.patient.read) is forbidden', async () => {
    const pt = await fullPatient();
    for (const [purpose, alts] of Object.entries(USER_PERM)) {
      for (const g of alts) expect(Object.keys(await demo(pt.id, purpose, asUser([g]))).sort(), `${purpose}/${g}`).toEqual(['patientId', 'status', ...ALLOW[purpose]!].sort());
      expect((await fails(asUser(without(...alts)), (p, c) => p.getPatientDemographics(c, { patientId: pt.id, purpose }))).code, purpose).toBe('auth.forbidden');
    }
  }, T);

  it('ageAtOrder: the most recent order\'s age snapshot wins over birth_on; with no order it is computed from birth_on at ctx.now()', async () => {
    const withOrder = await scenario({ items: ['not_started'], order: { age_years: 30 } });
    expect((await demo(withOrder.patient.id, 'lab_display')).ageAtOrder).toMatchObject({ years: 30 });
    const none = await fullPatient('a', { birth_on: '2000-01-15' });
    expect((await demo(none.id, 'lab_display')).ageAtOrder).toEqual({ years: 26, months: 9, days: 26 });   // 2000-01-15 -> 2026-11-10 (NOW)
  }, T);

  it('anonymised patient: fullName omitted, consents all false, status anonymised; hostile purpose / unknown patient / other tenant are refused cleanly', async () => {
    const anon = await seedPatient('a', { full_name: null, name_search: null, phone_e164: null, anonymised_at: '2026-11-01T00:00:00Z' },
      { source: 'anonymisation', processing: false, sms: false, whatsapp: false, email: false });
    const r = await demo(anon.id, 'notification');
    expect(r.status).toBe('anonymised');
    expect(r.consents).toMatchObject({ sms: false, whatsapp: false, email: false, shareWithReferrer: false });
    expect(await demo(anon.id, 'label_print')).not.toHaveProperty('fullName');
    const pt = await fullPatient();
    expect((await fails(SYS_ALL, (p, c) => p.getPatientDemographics(c, { patientId: pt.id, purpose: 'bogus' }))).code).toBe('common.validation_failed');
    expect((await fails(SYS_ALL, (p, c) => p.getPatientDemographics(c, { patientId: pt.id, purpose: "report_render'; DROP TABLE frontdesk.patients;--" }))).code).toBe('common.validation_failed');
    expect((await fails(SYS_ALL, (p, c) => p.getPatientDemographics(c, { patientId: uid(), purpose: 'report_render' }))).code).toBe('common.not_found');
    const other = await fullPatient('b');
    expect((await fails(SYS_ALL, (p, c) => p.getPatientDemographics(c, { patientId: other.id, purpose: 'report_render' }))).code).toBe('common.not_found');
    expect((await fails(SYS_ALL, (p, c) => p.getPatientDemographics(c, { patientId: 'not-a-uuid', purpose: 'report_render' }))).code).toBe('common.validation_failed');
  }, T);
});

describe('getPatientDemographicsBatch: cases (13) (19)', () => {
  it('(13) missing, invalid-to-the-tenant and other-tenant ids are omitted; the rest come back with the same field set as the single call', async () => {
    const a1 = await fullPatient(), a2 = await fullPatient(), b = await fullPatient('b');
    const r = await run(SYS_ALL, (p, c) => p.getPatientDemographicsBatch(c, { patientIds: [a1.id, b.id, uid(), a2.id], purpose: 'label_print' }));
    expect(r.map((x: any) => x.patientId).sort()).toEqual([a1.id, a2.id].sort());
    for (const x of r) expect(Object.keys(x).sort()).toEqual(['ageAtOrder', 'fullName', 'patientCode', 'patientId', 'sex', 'status']);
    expect(await run(SYS_ALL, (p, c) => p.getPatientDemographicsBatch(c, { patientIds: [], purpose: 'label_print' }))).toEqual([]);
    expect(await run(asSystem(ALL_USER_PERMS, { tenant: TENANT_B }), (p, c) => p.getPatientDemographicsBatch(c, { patientIds: [a1.id], purpose: 'label_print' }))).toEqual([]);
  }, T);

  it('at most 200 ids: 200 pass, 201 -> common.validation_failed; a purpose the caller does not hold -> auth.forbidden for the whole call', async () => {
    const pt = await fullPatient();
    const ids = (n: number) => [pt.id, ...Array.from({ length: n - 1 }, () => uid())];
    expect(await run(SYS_ALL, (p, c) => p.getPatientDemographicsBatch(c, { patientIds: ids(200), purpose: 'lab_display' }))).toHaveLength(1);
    expect((await fails(SYS_ALL, (p, c) => p.getPatientDemographicsBatch(c, { patientIds: ids(201), purpose: 'lab_display' }))).code).toBe('common.validation_failed');
    expect((await fails(asUser(without(PERMS.worklist, PERMS.statusBoard)), (p, c) => p.getPatientDemographicsBatch(c, { patientIds: [pt.id], purpose: 'lab_display' }))).code).toBe('auth.forbidden');
  }, T);

  it('(19) C14 caller: lab_display by worklist.read / status_board.read holders returns fullName, sex, ageAtOrder, patientCode and never phoneE164; neither permission -> auth.forbidden; other-tenant ids omitted', async () => {
    const a = await fullPatient(), b = await fullPatient('b');
    for (const g of [PERMS.worklist, PERMS.statusBoard]) {
      const r = await run(asUser([g]), (p, c) => p.getPatientDemographicsBatch(c, { patientIds: [a.id, b.id], purpose: 'lab_display' }));
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ patientId: a.id, fullName: a.full_name, sex: 'female', patientCode: a.patient_code });
      expect(r[0]).toHaveProperty('ageAtOrder');
      expect(r[0]).not.toHaveProperty('phoneE164');
    }
    expect((await fails(asUser([PERMS.patientRead, PERMS.orderRead]), (p, c) => p.getPatientDemographicsBatch(c, { patientIds: [a.id], purpose: 'lab_display' }))).code).toBe('auth.forbidden');
  }, T);
});
