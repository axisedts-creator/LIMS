// C13 T10 (part 1/2) — conversion task `partners.convert_manifest_line` + service/conversion.service.ts (06-IMPLEMENTATION-PLAN row T10).
// ACs (01-PRD): US-06.3 (BookingOrderInput + success), US-06.4 (replay), US-06.5 (patient_duplicate_suspected -> conversion_failed, no retry), US-06.6 (retry with patient_id, key v2), US-06.7 (catalog.* -> same failure again),
//               US-06.8 (infra failure -> throw/retry, line stays converting), US-06.10 (tenant isolation of the job); 07-SECURITY ST18 (savepoint marker test, 08 A19 P-44), ST3 (job is system-wide but binds by line id), no PHI in logs.
// Spec: 02-TRD §6.2 (BookingOrderInput table, buildBookingOrderInput), §8.1 (task row), 03-APP-FLOW §2.2 LS5/LS6/LS7, §4.2 (conversion task steps 1-6, retry SI4, atomicity note); 05-SCHEMA manifest_lines + order_tracking.
// Tests: unit (builder) + integration over the in-memory SQL world (conversion.world.ts) with the REAL FrontdeskPort fake of packages/fakes (failNext per code, recorded calls). LD-140 (UI) does not apply: backend task.
//
// Interface expected from the writer (SEAM = not fixed by the spec; the writer follows it or raises a dispute):
//   services/api/src/modules/partners/service/conversion.service.ts   export function buildBookingOrderInput(line, partner, manifest, referrerDoctorId?: string | null): BookingOrderInput
//        PURE; line / partner / manifest are the raw snake_case rows (as selected from partners.manifest_lines / partners.partners / partners.manifests), referrerDoctorId = the mapped catalog_doctor_id of line.referrer_id (4th arg because
//        TRD §6.2 gives only three: the table says `referrerId` = mapped catalog_doctor_id, else omitted). Keys that have no value are OMITTED (not `undefined`): referrerId, scheduledAt, birthOn/ageYears (exactly one), phoneE164.
//        patient_birth_on is a 'YYYY-MM-DD' string in these rows. clinical_note / collected_at / manifest notes are NOT sent (TRD §6.2 D-102).
//   services/worker/src/jobs/partners/tasks/partners.convert_manifest_line.ts   export const convertManifestLine: TaskHandler = (payload {tenant_id, line_id, attempt}, ctx) => Promise<void>; wired as
//        manifest.tasks['partners.convert_manifest_line'] in services/worker/src/jobs/partners/index.ts. The port is reached as ctx.ports.FrontdeskPort (as ctx.ports.EngagementPort in the homecollection consumers). The task runs inside ONE
//        transaction (ctx.tx); the port call runs inside ctx.db.tx(...) (the savepoint). Everything is bound by (ctx.tenantId, payload.line_id); partner / centre / credit party come from the LOCKED rows, never from the payload.
//   Business failure = a thrown object whose `.code` starts with frontdesk. or catalog., or equals common.validation_failed (classified by CODE, not instanceof: the fake throws the contracts LimsError, not core's) -> savepoint
//        rolled back by the callback's throw, line conversion_failed (failure_code, failed_at = ctx.now()), the task RESOLVES. Infra failure = anything else (common.dependency_unavailable, common.internal, plain Error) -> the task REJECTS
//        with the original error, nothing committed (the job transaction rolls back), line stays converting.
//   Success: line converted (order_id, registration_no, converted_at = ctx.now(), failure_code null, failed_at null, version + 1) and ONE partners.order_tracking row (tenant_id, order_id, partner_id, line_id, manifest_id,
//        receiving_centre_id = manifest centre, registration_no, tracking_status 'registered', registered_at = last_event_at = ctx.now(), created_by = updated_by = system actor id). The manifest row is not touched by the task.
//   payload.tenant_id !== ctx.tenantId -> no-op (like the frontdesk consumers); unknown / foreign line id -> no-op (resolves). SQL: the single-table subset of manifest-drafting.world.ts (no JOIN / sub-select; read the line, then the manifest,
//        the partner (partners.partners), the settings row and the referrer (partners.partner_referrers) with separate statements); line / manifest / partner reads bind tenant_id = ctx.tenantId; the line is read FOR UPDATE FIRST.
//   Retry (SI4) enqueues `SELECT app.enqueue_job('partners.convert_manifest_line', $payload::jsonb, $key)` with payload {tenant_id, line_id, attempt} and key convert:<line_id>:<attempt> (decoded by jobsOf), see staff-receipt.test.ts.
//   referrer rule (03-APP-FLOW §4.2 step 2): settings.require_mapped_referrer && the line has a referrer that is not mapped -> LS6 `partners.referrer_not_mapped`, no port call. Otherwise a mapped referrer -> referrerId, else omitted.
import { describe, expect, it } from 'vitest';
import { manifest as workerManifest } from '../../../../../worker/src/jobs/partners/index.js';
import { convertManifestLine } from '../../../../../worker/src/jobs/partners/tasks/partners.convert_manifest_line.js';
import { retryManifestLineConversion } from '../handlers/retryManifestLineConversion.js';
import { buildBookingOrderInput } from '../service/conversion.service.js';
import { BR, CE, CP, DOC, id, jobsOf, makeFrontdesk, makeStaffCtx, makeWorld10, markerPort, OR, P, PT, RF, release, runJob, STAFF_ID, SYS, T_A, T_B, USERS, type Row, type World10 } from './conversion.world.js';

const PHI = ['Synthetic Patient Zed', '+15555550177', '1991-03-09', 'SYN-REF-77', 'Synthetic note for the lab'];
const BUSINESS = ['frontdesk.patient_duplicate_suspected', 'catalog.test_inactive', 'catalog.no_price', 'frontdesk.consent_required', 'frontdesk.booking_already_converted', 'common.validation_failed'] as const;
const INFRA = ['common.dependency_unavailable', 'common.internal'] as const;
const NOW = '2026-11-13T00:00:00.000Z';

function setup(lineOver: Row = {}, manifestOver: Row = {}, fdOver: Parameters<typeof makeFrontdesk>[0] = {}) {
  const w = makeWorld10(); const fd = makeFrontdesk(fdOver); const depths: number[] = []; const port = markerPort(fd, depths);
  const m = w.mkManifest({ state: 'partially_received', version: 5, line_count: 1, submitted_by: USERS.x1.actor, ...manifestOver });
  const l = w.mkLine(m['id'], { state: 'converting', conversion_attempt: 1, sample_received_at: new Date('2026-11-12T10:00:00Z'), received_by: STAFF_ID, partner_sample_ref: 'SYN-1', ...lineOver });
  const line = () => w.lines.find((x) => x['id'] === l['id'])!;
  const payload = (over: Row = {}) => ({ tenant_id: T_A, line_id: l['id'], attempt: 1, ...over });
  const run = (p: Row = payload(), o: { tenant?: string; attempt?: number } = {}) => runJob(w, convertManifestLine, p, { port, ...o });
  const input = () => fd.calls('createOrderFromBooking').map((c: any) => c.input);
  return { w, fd, depths, m, l, line, payload, run, input };
}
const writes = (w: World10, n: number) => w.log.slice(n).filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text));
const noPhi = (...xs: unknown[]) => { const s = xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n'); for (const p of PHI) expect(s).not.toContain(p); };

describe('T10 wiring', () => {
  it('the worker manifest runs the real task for partners.convert_manifest_line (T01 stub replaced), 10 attempts', () => {
    expect(workerManifest.tasks?.['partners.convert_manifest_line']).toBe(convertManifestLine);
    expect(workerManifest.maxAttempts?.['partners.convert_manifest_line']).toBe(10);
  });
});

describe('T10 buildBookingOrderInput (unit) — exactly TRD §6.2', () => {
  const partner = { id: P.x, credit_party_id: CP.x, tenant_id: T_A };
  const mf = { id: id(950), receiving_branch_id: BR.a1, receiving_centre_id: CE.a1 };
  const base = { id: id(951), conversion_attempt: 1, resolved_patient_id: null, patient_full_name: 'Synthetic Patient Zed', patient_sex: 'male', patient_birth_on: null, patient_age_years: 41, patient_phone_e164: null,
    consent_sms: false, consent_whatsapp: false, consent_email: false, consent_share_with_referrer: false, consent_text_version: 'partner-v1', orderable_ids: [OR.glu], priority: 'routine', referrer_id: null,
    clinical_note: 'Synthetic note for the lab', collected_at: new Date('2026-11-12T09:30:00Z') };

  it('new patient, minimal: every field of the table, nothing else (no referrerId / scheduledAt / phoneE164 / birthOn keys; clinical_note and collected_at are not sent)', () => {
    expect(buildBookingOrderInput(base, partner, mf)).toStrictEqual({
      source: 'partner_manifest', sourceRefId: base.id,
      patient: { newPatient: { fullName: 'Synthetic Patient Zed', sex: 'male', ageYears: 41, consents: { sms: false, whatsapp: false, email: false, shareWithReferrer: false, consentTextVersion: 'partner-v1' } } },
      branchId: BR.a1, centreId: CE.a1, creditPartyId: CP.x, partnerId: P.x, orderableIds: [OR.glu], priority: 'routine', confirmImmediately: true, idempotencyKey: `partners:${base.id}:v1`,
    });
  });
  it('new patient, full: birthOn (not ageYears), phoneE164, true consents, urgent, several orderables in order, mapped referrer doctor id', () => {
    const line = { ...base, patient_birth_on: '1991-03-09', patient_age_years: null, patient_phone_e164: '+15555550177', consent_sms: true, consent_whatsapp: true, consent_email: true, consent_share_with_referrer: true, priority: 'urgent',
      orderable_ids: [OR.cbc, OR.glu, OR.tsh], referrer_id: RF.x1 };
    expect(buildBookingOrderInput(line, partner, mf, DOC.x1)).toStrictEqual({
      source: 'partner_manifest', sourceRefId: base.id,
      patient: { newPatient: { fullName: 'Synthetic Patient Zed', sex: 'male', birthOn: '1991-03-09', phoneE164: '+15555550177', consents: { sms: true, whatsapp: true, email: true, shareWithReferrer: true, consentTextVersion: 'partner-v1' } } },
      branchId: BR.a1, centreId: CE.a1, referrerId: DOC.x1, creditPartyId: CP.x, partnerId: P.x, orderableIds: [OR.cbc, OR.glu, OR.tsh], priority: 'urgent', confirmImmediately: true, idempotencyKey: `partners:${base.id}:v1`,
    });
  });
  it('a line with a referrer that is not mapped (referrerDoctorId null/undefined) sends no referrerId', () => {
    for (const d of [null, undefined]) expect('referrerId' in buildBookingOrderInput({ ...base, referrer_id: RF.x1 }, partner, mf, d)).toBe(false);
  });
  it('existing patient (resolved_patient_id): patient = { patientId } and no newPatient (retry with patient_id, US-06.6)', () => {
    const r: any = buildBookingOrderInput({ ...base, resolved_patient_id: PT, conversion_attempt: 2 }, partner, mf);
    expect(r.patient).toStrictEqual({ patientId: PT }); expect(r.idempotencyKey).toBe(`partners:${base.id}:v2`);
  });
  it('idempotencyKey = partners:<line id>:v<conversion_attempt>, grammar ^[A-Za-z0-9_.:-]{1,200}$ and <= 50 chars, for every attempt 1..100', () => {
    for (const n of [1, 2, 9, 10, 100]) { const k = (buildBookingOrderInput({ ...base, conversion_attempt: n }, partner, mf) as any).idempotencyKey; expect(k).toBe(`partners:${base.id}:v${n}`); expect(k).toMatch(/^[A-Za-z0-9_.:-]{1,200}$/); expect(k.length).toBeLessThanOrEqual(50); }
  });
  it('branch / centre come from the MANIFEST, credit party and partnerId from the PARTNER row; pure (inputs unchanged)', () => {
    const line = { ...base, receiving_centre_id: CE.a2 }; const before = JSON.stringify([line, partner, mf]);
    const r: any = buildBookingOrderInput(line, partner, { ...mf, receiving_branch_id: BR.a2, receiving_centre_id: CE.a2 });
    expect([r.branchId, r.centreId, r.creditPartyId, r.partnerId]).toEqual([BR.a2, CE.a2, CP.x, P.x]);
    buildBookingOrderInput(line, partner, mf); expect(JSON.stringify([line, partner, mf])).toBe(before);
  });
});

describe('T10 task — success (US-06.3)', () => {
  it('port called once as the system actor with exactly the §6.2 input (snapshot of the fake\'s recorded call), inside a savepoint', async () => {
    const s = setup();
    const r = await s.run();
    expect(r.threw).toBeUndefined();
    expect(s.input()).toStrictEqual([{
      source: 'partner_manifest', sourceRefId: s.l['id'],
      patient: { newPatient: { fullName: 'Synthetic Patient 1', sex: 'female', ageYears: 30, consents: { sms: false, whatsapp: false, email: false, shareWithReferrer: false, consentTextVersion: 'partner-v1' } } },
      branchId: BR.a1, centreId: CE.a1, creditPartyId: CP.x, partnerId: P.x, orderableIds: [OR.glu], priority: 'routine', confirmImmediately: true, idempotencyKey: `partners:${s.l['id']}:v1`,
    }]);
    expect(s.fd.calls('createOrderFromBooking')[0].ctx).toEqual({ tenantId: T_A, actorId: SYS });
    expect(s.depths).toEqual([1]); expect(r.sp.opened).toBe(1);
  });
  it('rich line: birth date, phone, true consents, urgent, panel + tests, mapped referrer -> referrerId = catalog doctor; branch/centre of the manifest (not of the line)', async () => {
    const s = setup({ patient_full_name: 'Synthetic Patient Zed', patient_sex: 'male', patient_birth_on: '1991-03-09', patient_age_years: null, patient_phone_e164: '+15555550177', consent_sms: true, consent_whatsapp: true,
      consent_email: true, consent_share_with_referrer: true, priority: 'urgent', orderable_ids: [OR.cbc, OR.glu, OR.tsh], referrer_id: RF.x1, receiving_centre_id: CE.a1 }, { receiving_branch_id: BR.a2, receiving_centre_id: CE.a2 });
    Object.assign(s.w.referrers.find((x) => x['id'] === RF.x1)!, { mapping_state: 'mapped', catalog_doctor_id: DOC.x1 });
    expect((await s.run()).threw).toBeUndefined();
    expect(s.input()[0]).toStrictEqual({
      source: 'partner_manifest', sourceRefId: s.l['id'],
      patient: { newPatient: { fullName: 'Synthetic Patient Zed', sex: 'male', birthOn: '1991-03-09', phoneE164: '+15555550177', consents: { sms: true, whatsapp: true, email: true, shareWithReferrer: true, consentTextVersion: 'partner-v1' } } },
      branchId: BR.a2, centreId: CE.a2, referrerId: DOC.x1, creditPartyId: CP.x, partnerId: P.x, orderableIds: [OR.cbc, OR.glu, OR.tsh], priority: 'urgent', confirmImmediately: true, idempotencyKey: `partners:${s.l['id']}:v1`,
    });
    expect(s.w.tracking[0]).toMatchObject({ receiving_centre_id: CE.a2 });
  });
  it('line converted (order_id, registration_no, converted_at now, no failure), one order_tracking row registered, manifest untouched, nothing enqueued, marker kept (savepoint released)', async () => {
    const s = setup(); const mBefore = JSON.stringify(s.m); const v0 = s.line()['version'];
    const r = await s.run(); expect(r.threw).toBeUndefined();
    const created = await s.fd.getOrderSummary({ tenantId: T_A, actor: { type: 'system', id: SYS }, now: () => NOW }, { orderId: s.line()['order_id'] });
    expect(s.line()).toMatchObject({ state: 'converted', registration_no: created.registrationNo, failure_code: null, failed_at: null, conversion_attempt: 1 });
    expect(s.line()['version']).toBeGreaterThan(v0);
    expect(new Date(s.line()['converted_at']).toISOString()).toBe(NOW);
    expect(created).toMatchObject({ partnerId: P.x, source: 'partner_manifest', sourceRefId: s.l['id'], status: 'registered', billingMode: 'credit', creditPartyId: CP.x, centreId: CE.a1 });
    expect(s.w.tracking).toHaveLength(1);
    expect(s.w.tracking[0]).toMatchObject({ tenant_id: T_A, order_id: s.line()['order_id'], partner_id: P.x, line_id: s.l['id'], manifest_id: s.m['id'], receiving_centre_id: CE.a1, registration_no: created.registrationNo,
      tracking_status: 'registered', created_by: SYS, updated_by: SYS });
    expect(new Date(s.w.tracking[0]!['registered_at']).toISOString()).toBe(NOW); expect(new Date(s.w.tracking[0]!['last_event_at']).toISOString()).toBe(NOW);
    expect(JSON.stringify(s.m)).toBe(mBefore); expect(s.w.jobs).toEqual([]); expect(s.w.markers).toHaveLength(1);
  });
  it('a suspended partner\'s manifest converts all the same (credit party regardless, 03-APP-FLOW §4.2 SI3 step 2)', async () => {
    const s = setup({}, { partner_id: P.s, receiving_centre_id: CE.a1 });
    expect((await s.run()).threw).toBeUndefined(); expect(s.line()['state']).toBe('converted'); expect(s.input()[0]).toMatchObject({ partnerId: P.s, creditPartyId: id(32) });
  });
});

describe('T10 task — duplicate / stale delivery is a no-op (US-06.4, TRD §8.1 "state must be converting")', () => {
  it('the same job delivered twice: second run calls nothing, writes nothing', async () => {
    const s = setup(); await s.run(); const n = s.w.log.length; const snap = JSON.stringify([s.w.lines, s.w.tracking]);
    const r = await s.run(); expect(r.threw).toBeUndefined();
    expect(s.fd.calls('createOrderFromBooking')).toHaveLength(1); expect(writes(s.w, n)).toEqual([]); expect(JSON.stringify([s.w.lines, s.w.tracking])).toBe(snap);
  });
  it.each([['attempt mismatch (payload 2, line 1)', {}, { attempt: 2 }], ['line already converted', { state: 'converted', order_id: id(7100), registration_no: '0001SY000100', converted_at: new Date(NOW) }, {}],
    ['line conversion_failed', { state: 'conversion_failed', failure_code: 'catalog.no_price' }, {}], ['line submitted', { state: 'submitted', sample_received_at: null, received_by: null, conversion_attempt: 0 }, {}],
    ['line not_received', { state: 'not_received', not_received_reason_code: 'sample_missing' }, {}], ['line withdrawn', { state: 'withdrawn' }, {}]] as const)(
    'stale: %s -> resolves, no port call, no write', async (_n, lineOver, payloadOver) => {
      const s = setup(lineOver as Row); const n = s.w.log.length; const snap = JSON.stringify(s.w.lines);
      const r = await s.run(s.payload(payloadOver as Row)); expect(r.threw).toBeUndefined();
      expect(s.fd.calls('createOrderFromBooking')).toHaveLength(0); expect(writes(s.w, n)).toEqual([]); expect(JSON.stringify(s.w.lines)).toBe(snap); expect(s.w.tracking).toEqual([]);
    });
  it('unknown line id and a line of another tenant (payload tenant != ctx tenant, or foreign id): no-op, no port call, tenant B untouched (US-06.10 for the job)', async () => {
    const s = setup(); const bm = s.w.mkManifest({ partner_id: P.b, state: 'partially_received', version: 3 }); const bl = s.w.mkLine(bm['id'], { state: 'converting', conversion_attempt: 1 });
    const snap = JSON.stringify([s.w.manifests, s.w.lines]);
    for (const p of [s.payload({ line_id: id(7999) }), s.payload({ line_id: bl['id'] }), { tenant_id: T_B, line_id: bl['id'], attempt: 1 }, { tenant_id: T_B, line_id: s.l['id'], attempt: 1 }]) {
      const r = await s.run(p); expect(r.threw).toBeUndefined();
    }
    expect(s.fd.calls('createOrderFromBooking')).toHaveLength(0); expect(JSON.stringify([s.w.manifests, s.w.lines])).toBe(snap); expect(s.w.tracking).toEqual([]);
  });
  it('replay (US-06.4): the port call committed before (same key) but the line is still converting -> the port replays, the line becomes converted with the SAME order, no second order', async () => {
    const s = setup(); const sysCtx = { tenantId: T_A, actor: { type: 'system', id: SYS }, now: () => NOW, tx: {} };
    const first = await s.fd.createOrderFromBooking(sysCtx, { source: 'partner_manifest', sourceRefId: s.l['id'], partnerId: P.x, patient: { patientId: PT }, branchId: BR.a1, centreId: CE.a1, orderableIds: [OR.glu], priority: 'routine',
      confirmImmediately: true, idempotencyKey: `partners:${s.l['id']}:v1` });
    expect((await s.run()).threw).toBeUndefined();
    expect(s.fd.calls('createOrderFromBooking')).toHaveLength(2);
    expect(s.line()).toMatchObject({ state: 'converted', order_id: first.orderId, registration_no: first.registrationNo });
    expect(s.w.tracking).toHaveLength(1); expect(s.w.tracking[0]).toMatchObject({ order_id: first.orderId });
  });
  it('two deliveries running at once: the row lock serialises them -> exactly one port call, one tracking row', async () => {
    const s = setup(); const [a, b] = await Promise.all([s.run(), s.run()]);
    expect([a.threw, b.threw]).toEqual([undefined, undefined]); expect(s.fd.calls('createOrderFromBooking')).toHaveLength(1); expect(s.w.tracking).toHaveLength(1); expect(s.line()['state']).toBe('converted');
  });
});

describe('T10 task — business failure (US-06.5, 06.7, ST18 / P-44): savepoint rolled back, line conversion_failed, NO throw, no retry', () => {
  it.each(BUSINESS)('%s -> conversion_failed with that code; marker written by C4 before it threw is ABSENT after commit; no tracking row; no job', async (code) => {
    const s = setup();
    if (code === 'frontdesk.booking_already_converted') {   // natural case: an order for this line exists under ANOTHER key
      await s.fd.createOrderFromBooking({ tenantId: T_A, actor: { type: 'system', id: SYS }, now: () => NOW, tx: {} }, { source: 'partner_manifest', sourceRefId: s.l['id'], partnerId: P.x, patient: { patientId: PT }, branchId: BR.a1,
        centreId: CE.a1, orderableIds: [OR.glu], priority: 'routine', confirmImmediately: true, idempotencyKey: 'someone-else:1' });
    } else s.fd.failNext('createOrderFromBooking', code);
    const r = await s.run();
    expect(r.threw).toBeUndefined();                                                 // no retry storm: the job completes
    expect(s.line()).toMatchObject({ state: 'conversion_failed', failure_code: code, order_id: null, registration_no: null, converted_at: null, conversion_attempt: 1 });
    expect(new Date(s.line()['failed_at']).toISOString()).toBe(NOW);
    expect(s.w.markers).toEqual([]);                                                 // P-44: nothing C4 wrote before throwing is committed
    expect(s.w.tracking).toEqual([]); expect(s.w.jobs).toEqual([]); expect(s.depths).toEqual([1]);
    expect(s.line()['failure_code']).toMatch(/^[a-z_]+\.[a-z_]+$/);                  // manifest_lines__failure_code__ck
  });
  it('P-44 control: the same marker IS committed when the port succeeds (so its absence above proves the rollback)', async () => {
    const s = setup(); await s.run(); expect(s.w.markers).toEqual([{ id: `marker:${s.l['id']}` }]);
  });
  it('natural failures through the fake\'s own rules: inactive test -> catalog.test_inactive, unpriced test -> catalog.no_price', async () => {
    const mk = (extra: Row) => [{ id: OR.glu, tenantId: T_A, kind: 'test', testIds: [id(9001)], isActive: true, ...extra }];
    const a = setup({}, {}, { orderables: mk({ isActive: false }) }); await a.run(); expect(a.line()).toMatchObject({ state: 'conversion_failed', failure_code: 'catalog.test_inactive' });
    const b = setup({}, {}, { orderables: mk({ hasPrice: false }) }); await b.run(); expect(b.line()).toMatchObject({ state: 'conversion_failed', failure_code: 'catalog.no_price' });
  });
  it('a failed line is untouched by anything else: other lines of the manifest keep their state, manifest row unchanged', async () => {
    const s = setup(); const other = s.w.mkLine(s.m['id'], { state: 'converting', conversion_attempt: 1 }); const mBefore = JSON.stringify(s.m); const oBefore = JSON.stringify(other);
    s.fd.failNext('createOrderFromBooking', 'catalog.no_price'); await s.run();
    expect(JSON.stringify(s.m)).toBe(mBefore); expect(JSON.stringify(other)).toBe(oBefore);
  });
  it('referrer unmapped while the tenant requires a mapped referrer -> conversion_failed partners.referrer_not_mapped, the port is never called; with the rule off the order is created without referrerId', async () => {
    const a = setup({ referrer_id: RF.x1 }); a.w.setSettings(T_A, { require_mapped_referrer: true });
    expect((await a.run()).threw).toBeUndefined(); expect(a.line()).toMatchObject({ state: 'conversion_failed', failure_code: 'partners.referrer_not_mapped' }); expect(a.fd.calls('createOrderFromBooking')).toHaveLength(0);
    const b = setup({ referrer_id: RF.x1 }); expect((await b.run()).threw).toBeUndefined(); expect(b.line()['state']).toBe('converted'); expect('referrerId' in b.input()[0]).toBe(false);
    const c = setup({ referrer_id: RF.x1 }); c.w.setSettings(T_A, { require_mapped_referrer: true });
    Object.assign(c.w.referrers.find((x) => x['id'] === RF.x1)!, { mapping_state: 'mapped', catalog_doctor_id: DOC.x1 }); await c.run(); expect(c.line()['state']).toBe('converted'); expect(c.input()[0].referrerId).toBe(DOC.x1);
  });
});

describe('T10 task — infrastructure failure (US-06.8): throws (queue retries with backoff), nothing committed, line stays converting', () => {
  it.each(INFRA)('%s -> the task rejects with that error; line converting, marker absent, no tracking row', async (code) => {
    const s = setup(); s.fd.failNext('createOrderFromBooking', code);
    const r = await s.run();
    expect(r.threw).toBeDefined(); expect((r.threw as any).code).toBe(code);
    expect(s.line()).toMatchObject({ state: 'converting', failure_code: null, order_id: null, conversion_attempt: 1 }); expect(s.w.markers).toEqual([]); expect(s.w.tracking).toEqual([]);
  });
  it('a connection error (plain Error) is rethrown as is; the retry of the same job then converts with the SAME idempotency key (the attempt is the C13 conversion attempt, not the queue attempt)', async () => {
    const s = setup(); const down = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
    const flaky = { async createOrderFromBooking(c: any, i: any) { if (!flaky.up) throw down; return s.fd.createOrderFromBooking(c, i); }, up: false };
    const first = await runJob(s.w, convertManifestLine, s.payload(), { port: flaky }); expect(first.threw).toBe(down); expect(s.line()['state']).toBe('converting');
    flaky.up = true; const second = await runJob(s.w, convertManifestLine, s.payload(), { port: flaky, attempt: 2 }); expect(second.threw).toBeUndefined();
    expect(s.line()['state']).toBe('converted'); expect(s.input().map((i: any) => i.idempotencyKey)).toEqual([`partners:${s.l['id']}:v1`]);
  });
});

describe('T10 task — probes: ids only, line row is the source of truth, no PHI in logs', () => {
  it('a planted payload (partner_id, centre_id, credit_party_id, patient_id, order_id) changes nothing: the line\'s own partner / centre / credit party are sent', async () => {
    const s = setup(); await s.run(s.payload({ partner_id: P.y, centre_id: CE.a2, branch_id: BR.a2, credit_party_id: CP.y, patient_id: PT, order_id: id(7777), orderable_ids: [OR.a1c] }));
    expect(s.input()[0]).toMatchObject({ partnerId: P.x, centreId: CE.a1, branchId: BR.a1, creditPartyId: CP.x, orderableIds: [OR.glu] }); expect(s.input()[0].patient).toHaveProperty('newPatient'); expect(s.line()['order_id']).not.toBe(id(7777));
  });
  it('the system job serves every centre: a line of centre C2 (partner Y, on_submit) converts the same as one of C1', async () => {
    const s = setup({}, { partner_id: P.y, receiving_branch_id: BR.a2, receiving_centre_id: CE.a2, conversion_mode: 'on_submit' }); await s.run();
    expect(s.line()['state']).toBe('converted'); expect(s.input()[0]).toMatchObject({ partnerId: P.y, centreId: CE.a2, branchId: BR.a2, creditPartyId: CP.y });
  });
  it('success, business failure and infra failure leave no patient data in the log lines or error details', async () => {
    const mk = () => setup({ patient_full_name: 'Synthetic Patient Zed', patient_birth_on: '1991-03-09', patient_age_years: null, patient_phone_e164: '+15555550177', partner_sample_ref: 'SYN-REF-77', clinical_note: 'Synthetic note for the lab' });
    const a = mk(); const ra = await a.run(); noPhi(ra.logs);
    const b = mk(); b.fd.failNext('createOrderFromBooking', 'frontdesk.patient_duplicate_suspected', 'Synthetic Patient Zed matches'); const rb = await b.run(); noPhi(rb.logs, b.line()['failure_code']);
    const c = mk(); c.fd.failNext('createOrderFromBooking', 'common.dependency_unavailable'); const rc = await c.run(); noPhi(rc.logs, (rc.threw as any)?.message);
  });
});

describe('T10 retry end to end (SI4 -> task, US-06.6 / US-06.7)', () => {
  const retry = async (s: ReturnType<typeof setup>, body: Row, version?: number) => {
    const st = makeStaffCtx(s.w, { centres: [CE.a1] });
    try { return await retryManifestLineConversion({ params: { line_id: s.l['id'] }, query: {}, headers: { 'if-match': `"${version ?? s.line()['version']}"` }, body } as any, st.ctx); } finally { release(st.ctx); }
  };
  const jobPayload = (s: ReturnType<typeof setup>) => { const j = jobsOf(s.w).at(-1)!; expect(j.task).toBe('partners.convert_manifest_line'); return j.payload as Row; };

  it('duplicate suspected -> staff picks an existing patient -> retry: attempt 2, patient { patientId }, key …:v2, new job convert:<line>:2, line converted', async () => {
    const s = setup(); s.fd.failNext('createOrderFromBooking', 'frontdesk.patient_duplicate_suspected'); await s.run();
    expect(s.line()).toMatchObject({ state: 'conversion_failed', failure_code: 'frontdesk.patient_duplicate_suspected' });
    const res: any = await retry(s, { patient_id: PT });
    expect(res.status).toBe(202); expect(res.body).toMatchObject({ id: s.l['id'], state: 'converting' });
    expect(s.line()).toMatchObject({ state: 'converting', conversion_attempt: 2, resolved_patient_id: PT, failure_code: null, failed_at: null });
    expect(jobsOf(s.w).at(-1)).toMatchObject({ key: `convert:${s.l['id']}:2`, payload: { tenant_id: T_A, line_id: s.l['id'], attempt: 2 } });
    expect((await s.run(jobPayload(s))).threw).toBeUndefined();
    expect(s.input()).toHaveLength(2); expect(s.input()[1]).toMatchObject({ patient: { patientId: PT }, idempotencyKey: `partners:${s.l['id']}:v2`, sourceRefId: s.l['id'], partnerId: P.x });
    expect(s.input()[1].patient).not.toHaveProperty('newPatient');
    expect(s.line()).toMatchObject({ state: 'converted', conversion_attempt: 2 }); expect(s.line()['order_id']).toBeTruthy(); expect(s.w.tracking).toHaveLength(1); expect(s.w.markers).toHaveLength(1);
  });
  it('catalog.no_price: retrying without changes fails again with the same code, attempt 3 key v3 (US-06.7)', async () => {
    const s = setup({}, {}, { orderables: [{ id: OR.glu, tenantId: T_A, kind: 'test', testIds: [id(9001)], isActive: true, hasPrice: false }] });
    await s.run(); expect(s.line()).toMatchObject({ state: 'conversion_failed', failure_code: 'catalog.no_price' });
    await retry(s, {}); expect(s.line()).toMatchObject({ state: 'converting', conversion_attempt: 2, resolved_patient_id: null });
    expect((await s.run(jobPayload(s))).threw).toBeUndefined();
    expect(s.line()).toMatchObject({ state: 'conversion_failed', failure_code: 'catalog.no_price', conversion_attempt: 2 });
    await retry(s, {}); await s.run(jobPayload(s)); expect(s.input().map((i: any) => i.idempotencyKey)).toEqual([`partners:${s.l['id']}:v1`, `partners:${s.l['id']}:v2`, `partners:${s.l['id']}:v3`]);
  });
  it('a stale job of attempt 1 delivered after the retry bumped the line to attempt 2 is ignored (no second order for the old key)', async () => {
    const s = setup(); s.fd.failNext('createOrderFromBooking', 'catalog.no_price'); await s.run(); await retry(s, {});
    const r = await s.run(s.payload({ attempt: 1 })); expect(r.threw).toBeUndefined(); expect(s.fd.calls('createOrderFromBooking')).toHaveLength(1); expect(s.line()['state']).toBe('converting');
  });
});
