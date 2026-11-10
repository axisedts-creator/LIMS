// FD-T11 FrontdeskPort contract, part 2 (real impl, real PG17 under RLS, real fakes): createOrderFromBooking cases (5)-(10), US-FD-12.5, booking defaults (02-TRD §6.1, review C4 #25),
// per-source authorisation (08 R7), consumer cases (11) (12) through service/booking.service.ts, createSelfRegisteredPatient cases (16) (17), and the 07-SECURITY probes.
// Part 1 (reads, demographics, batch): FrontdeskPort.contract.test.ts. Harness and ASSUMED seams: ./helpers.ts. Fails now: ports/FrontdeskPort.impl.ts + service/booking.service.ts do not exist.
import { beforeAll, describe, expect, it } from 'vitest';
import { onBookingCancelled, onBookingConfirmed } from '../../service/booking.service.js';
import { REFERRER } from '../quote/helpers.js';
import { BRANCH_A2 } from '../registration/helpers.js';
import { ALL_USER_PERMS, BRANCH, CENTRE, CENTRE_A2, CONSENT_VERSION, CP, NON_STAFF, NOW, O, PARTNER, PERMS, SOURCES, T, TENANT_A, TENANT_B, accessLogRows, allEventRows, asSystem, asUser, booking, cancelledEvent,
  confirmedEvent, consentInput, consentRows, create, createFails, creator, eventRows, fails, flagRows, fullPatient, itemRows, linkRows, newPatientInput, orderRow, ordersBySource, patientRow, patientsByPhone,
  run, rworld, seedPatient, scopedWrites, uid, without, type Source } from './helpers.js';

beforeAll(async () => { await run(asSystem(), async () => undefined); }, T);
const COLLECTION: Record<Source, string> = { engagement_booking: 'centre', home_collection: 'home', partner_manifest: 'partner' };
const billingCalls = (w: any) => ['issueOrderInvoice', 'recordCreditCharges', 'recordPayment'].flatMap((m) => w.billingFake.calls(m).map((c: any) => ({ m, ...c })));
const portCalls = (w: any) => [...w.catalog.calls('resolveOrderables'), ...w.catalog.calls('priceFor'), ...billingCalls(w)];

describe('createOrderFromBooking: cases (5)-(10), US-FD-12.5', () => {
  it('(5) replay with the same idempotencyKey -> same orderId and registrationNo, replayed:true; one order, one invoice, one created event', async () => {
    const pt = await fullPatient();
    const w = rworld({ creditList: true });
    const input = booking('home_collection', { patientId: pt.id });
    const first = await create(input, creator('home_collection', { w }));
    const again = await create(input, creator('home_collection', { w }));
    expect(first).toMatchObject({ status: 'registered', replayed: false });
    expect(again).toEqual({ ...first, replayed: true });
    expect(await ordersBySource(TENANT_A, 'home_collection', input.sourceRefId)).toHaveLength(1);
    expect(w.billingFake.calls('issueOrderInvoice')).toHaveLength(1);
    expect(await eventRows('frontdesk.order.created.v1', first.orderId)).toHaveLength(1);
  }, T);

  it('(6) same sourceRefId with a NEW key -> frontdesk.booking_already_converted (US-FD-12.5), original order untouched; the same ref under another source or tenant is independent', async () => {
    const pt = await fullPatient();
    const input = booking('home_collection', { patientId: pt.id });
    const first = await create(input, creator('home_collection'));
    const e = await createFails({ ...input, idempotencyKey: `k-${uid()}` }, creator('home_collection'));
    expect(e.code).toBe('frontdesk.booking_already_converted');
    expect(await ordersBySource(TENANT_A, 'home_collection', input.sourceRefId)).toHaveLength(1);
    expect((await orderRow(first.orderId)).status).toBe('registered');
    const other = await create({ ...input, source: 'engagement_booking', idempotencyKey: `k-${uid()}`, confirmImmediately: false }, creator('engagement_booking'));
    expect(other.orderId).not.toBe(first.orderId);
    const pb = await fullPatient('b');
    const b = await create(booking('home_collection', { patientId: pb.id }, { tenant: 'b', sourceRefId: input.sourceRefId }), creator('home_collection', { tenant: TENANT_B }));
    expect((await orderRow(b.orderId)).tenant_id).toBe(TENANT_B);
  }, T);

  it('(7) confirmImmediately:true -> status registered, frontdesk.order.created.v1 stored ONCE (producer frontdesk, no PHI), invoice issued, no payment recorded', async () => {
    const pt = await fullPatient();
    const w = rworld({ creditList: true });
    const input = booking('home_collection', { patientId: pt.id }, { confirmImmediately: true });
    const r = await create(input, creator('home_collection', { w }));
    expect(r.status).toBe('registered');
    const ev = await eventRows('frontdesk.order.created.v1', r.orderId);
    expect(ev).toHaveLength(1);
    expect(ev[0].producer).toBe('frontdesk');
    expect(ev[0].envelope.payload).toMatchObject({ order_id: r.orderId, patient_id: pt.id, source: 'home_collection', source_ref_id: input.sourceRefId, collection_mode: 'home', billing_mode: 'cash', centre_id: CENTRE.a });
    expect(new Date(ev[0].envelope.payload.registered_at).toISOString()).toBe(NOW.toISOString());
    const text = JSON.stringify(ev[0].envelope.payload);
    for (const phi of [pt.full_name, pt.phone_e164, pt.patient_code, r.registrationNo]) expect(text).not.toContain(phi);
    const inv = w.billingFake.calls('issueOrderInvoice');
    expect(inv).toHaveLength(1);
    expect(inv[0].input).toMatchObject({ orderId: r.orderId, patientId: pt.id, purpose: 'registration' });
    expect((inv[0].input as any).lines.map((l: any) => l.orderableId).sort()).toEqual([O.cbc, O.glu].sort());
    expect(w.billingFake.calls('recordPayment')).toHaveLength(0);
  }, T);

  it('(8) confirmImmediately:false -> pre_registered, registrationNo assigned, NO event of any kind, no invoice / credit charge / payment, registered_at NULL', async () => {
    const pt = await fullPatient();
    const w = rworld({ creditList: true });
    const r = await create(booking('engagement_booking', { patientId: pt.id }, { confirmImmediately: false }), creator('engagement_booking', { w }));
    expect(r).toMatchObject({ status: 'pre_registered', replayed: false });
    const row = await orderRow(r.orderId);
    expect(row).toMatchObject({ status: 'pre_registered', registration_no: r.registrationNo, registered_at: null });
    expect(r.registrationNo).toMatch(/^A-B1R\d{6}$/);
    expect(await allEventRows(r.orderId)).toHaveLength(0);
    expect(billingCalls(w)).toHaveLength(0);
  }, T);

  it('(9) inactive orderable -> catalog.test_inactive; orderable without a price -> catalog.no_price; nothing is written', async () => {
    const pt = await fullPatient();
    const refs = [uid(), uid()];
    const scope = { patientIds: [pt.id], refs };   // FD-T11 ruling: scoped to rows this test could create
    const before = await scopedWrites(TENANT_A, scope);
    expect((await createFails(booking('home_collection', { patientId: pt.id }, { orderableIds: [O.cbc, O.lft], sourceRefId: refs[0] }), creator('home_collection'))).code).toBe('catalog.test_inactive');
    expect((await createFails(booking('home_collection', { patientId: pt.id }, { orderableIds: [O.cul], sourceRefId: refs[1] }), creator('home_collection'))).code).toBe('catalog.no_price');
    expect(await scopedWrites(TENANT_A, scope)).toEqual(before);
  }, T);

  it('(10) a new patient with a consentTextVersion that is not the tenant\'s current one -> frontdesk.consent_required, no patient row; with the current one the patient + consent row are written with the port source', async () => {
    const np = newPatientInput();
    const ref = uid();
    const scope = { phones: [np.phoneE164], refs: [ref] };   // FD-T11 ruling: scoped to rows this test could create
    const before = await scopedWrites(TENANT_A, scope);
    const e = await createFails(booking('home_collection', { newPatient: { ...np, consents: consentInput({ consentTextVersion: 'v0-old' }) } }, { sourceRefId: ref }), creator('home_collection'));
    expect(e.code).toBe('frontdesk.consent_required');
    expect(await scopedWrites(TENANT_A, scope)).toEqual(before);
    const r = await create(booking('partner_manifest', { newPatient: np }, { confirmImmediately: false }), creator('partner_manifest'));
    const [p] = await patientsByPhone(TENANT_A, np.phoneE164);
    expect(p).toMatchObject({ full_name: np.fullName, sex: 'female', birth_on: expect.anything(), source: 'partner_manifest', registered_centre_id: CENTRE.a });
    expect(p.patient_code).toMatch(/^MP\d{8}$/);
    expect((await orderRow(r.orderId)).patient_id).toBe(p.id);
    const [c] = await consentRows(p.id);
    expect(c).toMatchObject({ processing: true, sms: true, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: CONSENT_VERSION, source: 'partner_manifest' });
  }, T);

  it('defaults (TRD §6.1): visit_type opd; collection_mode centre/home/partner by source; cash without creditPartyId; snapshots, server-side prices; booking_links row; partner_id only for partner_manifest', async () => {
    const pt = await fullPatient();
    for (const source of SOURCES) {
      const input = booking(source, { patientId: pt.id }, { confirmImmediately: false, scheduledAt: '2026-11-11T04:00:00.000Z', priority: 'urgent' });
      const r = await create(input, creator(source));
      const o = await orderRow(r.orderId);
      expect(o, source).toMatchObject({ tenant_id: TENANT_A, status: 'pre_registered', visit_type: 'opd', billing_mode: 'cash', collection_mode: COLLECTION[source], source, source_ref_id: input.sourceRefId,
        priority: 'urgent', patient_id: pt.id, centre_id: CENTRE.a, branch_id: BRANCH.a, partner_id: source === 'partner_manifest' ? PARTNER : null, credit_party_id: null });
      expect(new Date(o.scheduled_at).toISOString()).toBe('2026-11-11T04:00:00.000Z');
      const items = await itemRows(r.orderId);
      expect(items).toHaveLength(2);
      const cbc = items.find((i) => i.orderable_id === O.cbc)!;
      expect(cbc).toMatchObject({ unit_price_paisa: '50000', price_source: 'tenant_default', priority: 'urgent', status: 'active', centre_id: CENTRE.a });
      expect(Number(cbc.urgent_surcharge_paisa)).toBe(10000);
      expect(items.find((i) => i.orderable_id === O.glu)).toMatchObject({ unit_price_paisa: '20000', vat_treatment: 'taxable' });
      expect((await linkRows(TENANT_A, source, input.sourceRefId))[0]).toMatchObject({ order_id: r.orderId, idempotency_key: input.idempotencyKey, state: 'converted' });
    }
  }, T);

  it('credit: creditPartyId -> billing_mode credit + referrer stored; confirmImmediately records credit charges (not an invoice); the price comes from the server, never the caller', async () => {
    const pt = await fullPatient();
    const w = rworld({ creditList: true });
    const r = await create(booking('home_collection', { patientId: pt.id }, { creditPartyId: CP.ok, referrerId: REFERRER, orderableIds: [O.cbc] }), creator('home_collection', { w }));
    expect(await orderRow(r.orderId)).toMatchObject({ billing_mode: 'credit', credit_party_id: CP.ok, referrer_id: REFERRER });
    expect(w.billingFake.calls('recordCreditCharges')).toHaveLength(1);
    expect(w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
    expect((await itemRows(r.orderId))[0]).toMatchObject({ price_source: expect.any(String) });
    expect(Number((await itemRows(r.orderId))[0].unit_price_paisa)).toBe(40000);   // credit-party list (world creditList: CBC 40000)
  }, T);

  it('input validation at the trust boundary -> common.validation_failed: unknown source, empty/oversize orderableIds, non-uuid ids, empty key, partner_manifest without partnerId, non-boolean confirmImmediately, no patient', async () => {
    const pt = await fullPatient();
    const base = booking('home_collection', { patientId: pt.id });
    const bad: Record<string, unknown>[] = [{ source: 'front_desk' }, { source: "x'; DROP TABLE frontdesk.orders;--" }, { orderableIds: [] }, { orderableIds: ['not-a-uuid'] },
      { sourceRefId: 'nope' }, { idempotencyKey: '' }, { confirmImmediately: 'yes' }, { patient: {} }, { patient: { patientId: 'nope' } }, { branchId: 'nope' }, { priority: 'asap' }];
    for (const b of bad) expect((await createFails({ ...base, ...b }, creator('home_collection'))).code, JSON.stringify(b)).toBe('common.validation_failed');
    const noPartner = booking('partner_manifest', { patientId: pt.id });
    delete (noPartner as any).partnerId;
    expect((await createFails(noPartner, creator('partner_manifest'))).code).toBe('common.validation_failed');
  }, T);

  it('tenancy: another tenant\'s patientId -> common.not_found; the booking is invisible to the other tenant', async () => {
    const other = await fullPatient('b');
    expect((await createFails(booking('home_collection', { patientId: other.id }), creator('home_collection'))).code).toBe('common.not_found');
  }, T);
});

describe('createOrderFromBooking: per-source authorisation (08 R7), actor guard first', () => {
  const mk = async (source: Source) => booking(source, { patientId: (await fullPatient()).id }, { confirmImmediately: false });
  it('engagement_booking: system actor only; a user holding EVERY permission is auth.forbidden', async () => {
    expect((await create(await mk('engagement_booking'), creator('engagement_booking'))).status).toBe('pre_registered');
    expect((await createFails(await mk('engagement_booking'), asUser(ALL_USER_PERMS))).code).toBe('auth.forbidden');
  }, T);
  it('home_collection: system or a holder of homecollection.visit.assign (dispatcher); billing.invoice.issue is NOT additionally required; other permissions do not help', async () => {
    const w = rworld({ creditList: true });
    const dispatcher = uid();
    const input = booking('home_collection', { patientId: (await fullPatient()).id });
    const r = await create(input, asUser([PERMS.visitAssign], { actorId: dispatcher, w }));
    expect(r.status).toBe('registered');
    expect((w.billingFake.calls('issueOrderInvoice')[0].ctx as any).actorId).toBe(dispatcher);   // the dispatcher is the invoice creator (08 R7, IRD per-user trail)
    expect((await create(await mk('home_collection'), creator('home_collection'))).status).toBe('pre_registered');
    expect((await createFails(await mk('home_collection'), asUser(without(PERMS.visitAssign)))).code).toBe('auth.forbidden');
  }, T);
  it('partner_manifest: the partners system actor or a holder of partners.manifest.receive; homecollection.visit.assign does not help', async () => {
    expect((await create(await mk('partner_manifest'), creator('partner_manifest'))).status).toBe('pre_registered');
    expect((await create(await mk('partner_manifest'), asUser([PERMS.manifestReceive]))).status).toBe('pre_registered');
    expect((await createFails(await mk('partner_manifest'), asUser(without(PERMS.manifestReceive)))).code).toBe('auth.forbidden');
  }, T);
  it('centre scope (03-IC §4.3, review FD-T11 #1): a USER actor scoped to centre A passing centre A2 -> common.not_found (a coded error, not a raw RLS error); nothing is written; scope [A, A2] passes', async () => {
    const pt = await fullPatient();
    for (const [source, perm] of [['home_collection', PERMS.visitAssign], ['partner_manifest', PERMS.manifestReceive]] as const) {
      const input = booking(source, { patientId: pt.id }, { confirmImmediately: false, centreId: CENTRE_A2, branchId: BRANCH_A2 });
      const scope = { patientIds: [pt.id], refs: [input.sourceRefId], keys: [input.idempotencyKey] };
      const before = await scopedWrites(TENANT_A, scope);
      expect((await createFails(input, asUser([perm], { centreIds: [CENTRE.a] }))).code, source).toBe('common.not_found');
      expect(await scopedWrites(TENANT_A, scope), source).toEqual(before);
      expect((await create(input, asUser([perm], { centreIds: [CENTRE.a, CENTRE_A2] }))).status, source).toBe('pre_registered');
    }
  }, T);
  it('patient / portal / partner / device actors are refused for every source and every method, BEFORE any validation, port call or write', async () => {
    const pt = await fullPatient();
    for (const actor of NON_STAFF) {
      for (const source of SOURCES) {
        const w = rworld({ creditList: true });
        const garbage = { ...booking(source, { patientId: pt.id }), orderableIds: ['not-a-uuid'] };   // would be validation_failed if validation ran first
        const scope = { patientIds: [pt.id], refs: [garbage.sourceRefId], keys: [garbage.idempotencyKey] };   // FD-T11 ruling: scoped to rows this test could create
        const before = await scopedWrites(TENANT_A, scope);
        expect((await createFails(garbage, { actor, grants: ALL_USER_PERMS, w })).code, `${actor}/${source}`).toBe('auth.forbidden');
        expect(portCalls(w)).toHaveLength(0);
        expect(await scopedWrites(TENANT_A, scope)).toEqual(before);
      }
      const o = { actor, grants: ALL_USER_PERMS };
      expect((await fails(o, (p, c) => p.getOrderSummary(c, { orderId: uid() }))).code, `${actor}/getOrderSummary`).toBe('auth.forbidden');
      expect((await fails(o, (p, c) => p.createSelfRegisteredPatient(c, { ...newPatientInput(), idempotencyKey: `k-${uid()}` }))).code, `${actor}/self`).toBe('auth.forbidden');
      expect((await fails(o, (p, c) => p.getPatientDemographicsBatch(c, { patientIds: [pt.id], purpose: 'label_print' }))).code, `${actor}/batch`).toBe('auth.forbidden');
    }
  }, 120_000);
});

describe('cases (11) (12): booking consumers over the same booking.service path (X5, 08 R7)', () => {
  const sys = (o: Record<string, unknown> = {}) => ({ actor: 'system' as const, grants: [] as string[], ...o });
  const consume = (fn: typeof onBookingConfirmed, payload: unknown, w = rworld({ creditList: true })) => run(sys({ w }), (_p, c) => fn(c, payload as never));

  it('(11) home_collection booking.confirmed -> NO order, no booking link (C17 creates it at assignment); a centre_visit booking.confirmed -> one pre_registered engagement_booking order, no created event, no invoice', async () => {
    const pt = await fullPatient();
    const w = rworld({ creditList: true });
    const home = confirmedEvent(pt.id, { booking_kind: 'home_collection', home_address_id: uid() });
    await consume(onBookingConfirmed, home, w);
    expect(await ordersBySource(TENANT_A, 'engagement_booking', home.booking_id)).toHaveLength(0);
    expect(await ordersBySource(TENANT_A, 'home_collection', home.booking_id)).toHaveLength(0);
    expect(await linkRows(TENANT_A, 'engagement_booking', home.booking_id)).toHaveLength(0);
    expect(billingCalls(w)).toHaveLength(0);
    const centre = confirmedEvent(pt.id);
    await consume(onBookingConfirmed, centre, w);
    const [o] = await ordersBySource(TENANT_A, 'engagement_booking', centre.booking_id);
    expect(o).toMatchObject({ status: 'pre_registered', collection_mode: 'centre', priority: 'routine', patient_id: pt.id, centre_id: CENTRE.a, branch_id: BRANCH.a });
    expect(new Date(o.scheduled_at).toISOString()).toBe(centre.slot_start);
    expect(await allEventRows(o.id)).toHaveLength(0);
    expect(billingCalls(w)).toHaveLength(0);
  }, T);

  it('(12) booking.cancelled for a home_collection booking whose home_visit_id links a REGISTERED order -> order_flags kind booking_cancelled_after_registration; the order is untouched (no cancel, no cancelled event)', async () => {
    const pt = await fullPatient();
    const visit = uid();
    const input = booking('home_collection', { patientId: pt.id }, { sourceRefId: visit, confirmImmediately: true });
    const made = await create(input, creator('home_collection'));
    await consume(onBookingCancelled, cancelledEvent(pt.id, { booking_kind: 'home_collection', home_visit_id: visit }));
    const flags = await flagRows(made.orderId);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'booking_cancelled_after_registration', order_id: made.orderId, tenant_id: TENANT_A });
    expect(await orderRow(made.orderId)).toMatchObject({ status: 'registered', cancelled_at: null });
    expect(await eventRows('frontdesk.order.cancelled.v1', made.orderId)).toHaveLength(0);
    // no linked order -> nothing happens (inbox only)
    const scope = { patientIds: [pt.id], refs: [visit] };   // FD-T11 ruling: scoped to rows this test could create
    const before = await scopedWrites(TENANT_A, scope);
    await consume(onBookingCancelled, cancelledEvent(pt.id, { booking_kind: 'home_collection', home_visit_id: uid() }));
    expect((await scopedWrites(TENANT_A, scope)).flags).toBe(before.flags);
  }, T);
});

describe('createSelfRegisteredPatient: cases (16) (17), shape, authorisation', () => {
  const eng = (o: Record<string, unknown> = {}) => asSystem([], o);
  const selfReg = (input: any, o = eng()) => run(o, (p, c) => p.createSelfRegisteredPatient(c, input));
  const input = (o: Record<string, unknown> = {}) => ({ ...newPatientInput(), idempotencyKey: `selfreg:${uid()}`, ...o });

  it('creates a NEW patient: source self_service, no centre, patient code, consent row source self_service with processing=true, the given channel consents and the current consent version', async () => {
    const i = input({ consents: consentInput({ sms: true, whatsapp: true, email: false }) });
    const r = await selfReg(i);
    expect(r).toMatchObject({ duplicateSuspected: false, replayed: false, patientCode: expect.stringMatching(/^MP\d{8}$/) });
    expect(await patientRow(r.patientId)).toMatchObject({ tenant_id: TENANT_A, source: 'self_service', registered_centre_id: null, full_name: i.fullName, phone_e164: i.phoneE164, patient_code: r.patientCode, sex: 'female' });
    const cs = await consentRows(r.patientId);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ processing: true, sms: true, whatsapp: true, email: false, share_with_referrer: false, consent_text_version: CONSENT_VERSION, source: 'self_service' });
  }, T);

  it('ageYears instead of birthOn -> estimated birth date; a consentTextVersion that is not the current one -> frontdesk.consent_required and no row', async () => {
    const r = await selfReg(input({ birthOn: undefined, ageYears: 30 }));
    expect(await patientRow(r.patientId)).toMatchObject({ is_birth_on_estimated: true, birth_on: expect.anything() });
    const i = input({ consents: consentInput({ consentTextVersion: 'app-1' }) });
    expect((await fails(eng(), (p, c) => p.createSelfRegisteredPatient(c, i))).code).toBe('frontdesk.consent_required');
    expect(await patientsByPhone(TENANT_A, i.phoneE164)).toHaveLength(0);
  }, T);

  it('(16) replay with the same idempotencyKey -> same patientId and patientCode, replayed:true, still ONE patient and ONE consent row', async () => {
    const i = input();
    const a = await selfReg(i);
    const b = await selfReg(i);
    expect(b).toEqual({ ...a, replayed: true });
    expect(await patientsByPhone(TENANT_A, i.phoneE164)).toHaveLength(1);
    expect(await consentRows(a.patientId)).toHaveLength(1);
  }, T);

  it('(17) a suspected duplicate (same name, phone, birth date, sex) is flagged duplicateSuspected:true but STILL gets a new patientId; the existing patient is untouched', async () => {
    const existing = await seedPatient('a', { full_name: 'Maya Fdt Duplicate', birth_on: '1990-05-05', sex: 'female' });
    const before = await patientRow(existing.id);
    const r = await selfReg(input({ fullName: 'Maya Fdt Duplicate', birthOn: '1990-05-05', phoneE164: existing.phone_e164, sex: 'female' }));
    expect(r.duplicateSuspected).toBe(true);
    expect(r.patientId).not.toBe(existing.id);
    expect(await patientRow(existing.id)).toEqual(before);
    expect((await patientsByPhone(TENANT_A, existing.phone_e164)).length).toBe(2);
  }, T);

  it('engagement system actor only: a USER holding every permission (even engagement.link.issue) -> auth.forbidden; tenancy follows ctx (tenant b creates in tenant b)', async () => {
    expect((await fails(asUser(ALL_USER_PERMS), (p, c) => p.createSelfRegisteredPatient(c, input()))).code).toBe('auth.forbidden');
    const i = input();
    const r = await selfReg(i, eng({ tenant: TENANT_B }));
    expect((await patientRow(r.patientId)).tenant_id).toBe(TENANT_B);
    expect(await patientsByPhone(TENANT_A, i.phoneE164)).toHaveLength(0);
  }, T);

  it('validation + injection: missing phone / key / name -> common.validation_failed; a hostile name is stored verbatim by parameterised SQL (table intact)', async () => {
    for (const b of [{ phoneE164: undefined }, { phoneE164: '12345' }, { idempotencyKey: '' }, { fullName: '' }, { sex: 'robot' }])
      expect((await fails(eng(), (p, c) => p.createSelfRegisteredPatient(c, input(b)))).code, JSON.stringify(b)).toBe('common.validation_failed');
    const hostile = "Robert'); DROP TABLE frontdesk.patients;-- <script>x</script>";
    const r = await selfReg(input({ fullName: hostile }));
    expect((await patientRow(r.patientId)).full_name).toBe(hostile);
  }, T);
});

describe('07-SECURITY probes on the port', () => {
  it('REQ-SEC-096/097: the port writes NO audit.access_log row itself (the calling user-facing action logs), for reads and writes alike', async () => {
    const pt = await fullPatient();
    const requestId = uid();
    const o = { ...asSystem(ALL_USER_PERMS), requestId };
    await run(o, async (p, c) => {
      await p.getPatientDemographics(c, { patientId: pt.id, purpose: 'report_render' });
      await p.getPatientDemographicsBatch(c, { patientIds: [pt.id], purpose: 'lab_display' });
      await p.createOrderFromBooking(c, booking('home_collection', { patientId: pt.id }, { confirmImmediately: false }));
      await p.createSelfRegisteredPatient(c, { ...newPatientInput(), idempotencyKey: `k-${uid()}` });
    });
    expect(await accessLogRows(requestId)).toHaveLength(0);
  }, T);

  it('errors carry a code and no PHI: not_found / forbidden / validation errors never echo the patient\'s name, phone or the hostile input', async () => {
    const pt = await fullPatient('b');
    const errs = [await fails(asSystem(ALL_USER_PERMS), (p, c) => p.getPatientDemographics(c, { patientId: pt.id, purpose: 'report_render' })),
      await fails(asUser([]), (p, c) => p.getPatientDemographics(c, { patientId: pt.id, purpose: 'label_print' })),
      await createFails(booking('home_collection', { patientId: pt.id }), creator('home_collection'))];
    for (const e of errs) {
      expect(e.code).toMatch(/^(common|auth)\./);
      const text = JSON.stringify({ m: e.message, d: e.safeDetail, f: e.fieldErrors });
      for (const phi of [pt.full_name, pt.phone_e164, pt.email, pt.patient_code]) expect(text).not.toContain(phi);
    }
  }, T);

  it('race: 6 parallel calls with the SAME key -> every one succeeds with ONE orderId and exactly one replayed:false', async () => {
    const pt = await fullPatient();
    const input = booking('home_collection', { patientId: pt.id }, { confirmImmediately: false });
    const rs = await Promise.all(Array.from({ length: 6 }, () => create(input, creator('home_collection', { w: rworld({ creditList: true }) }))));
    expect(new Set(rs.map((r) => r.orderId)).size).toBe(1);
    expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await ordersBySource(TENANT_A, 'home_collection', input.sourceRefId)).toHaveLength(1);
  }, T);

  it('race: 6 parallel calls for the same sourceRefId with DIFFERENT keys -> exactly one order; the losers get frontdesk.booking_already_converted (never a raw unique-violation / 500)', async () => {
    const pt = await fullPatient();
    const ref = uid();
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () =>
      create(booking('home_collection', { patientId: pt.id }, { sourceRefId: ref, confirmImmediately: false }), creator('home_collection', { w: rworld({ creditList: true }) }))));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of rs) if (r.status === 'rejected') expect((r.reason as any).code).toBe('frontdesk.booking_already_converted');
    expect(await ordersBySource(TENANT_A, 'home_collection', ref)).toHaveLength(1);
  }, T);
});
