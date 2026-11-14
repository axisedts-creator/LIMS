// C6-T19 — NotificationPort real implementation: integration + security tests (01-PRD AC-16.1..16.6, AC-08.1/08.2/08.5; 02-TRD §7.2 steps 1-8;
// 07-SECURITY REQ-SEC-005/070/078/136; 03-IC §4.8). Runs on the in-memory SQL fake of notification.helpers.ts (no network, no real DB).
// LD-26 (training tenant -> recording adapter only) cannot be asserted here: no IdentityPort method exposes `tenant.training_mode` (CR needed, see
// .orchestra/notes/C6-T19-tests.md). LD-49 belongs to C6-T29 (provider callbacks), not to this port.
import { describe, expect, it } from 'vitest';
import { makeNotifWorld, rejection, sha256hex, idN, TENANT_A, TENANT_B, STAFF_ORIGIN, PORTAL_ORIGIN, DEFAULT_TEMPLATES, type NotifWorld } from './notification.helpers.js';

const P_ALL = idN(0x101), P_SMS = idN(0x102), P_EMAILONLY = idN(0x103), P_NOPHONE = idN(0x104), P_NOEMAIL = idN(0x105), P_B = idN(0x1b1);
const M_OK = idN(0x211), M_NOEMAIL = idN(0x212);
const CENTRE_1 = idN(0xc1), PARTNER_1 = idN(0xe1);
const PERM = 'analytics.dashboard.read';
const PHONE = (p: number) => `+97798000${String(p).padStart(5, '0')}`;
const SENTINEL_NAME = 'SENTINEL Sita Karki';
const all = { sms: true, whatsapp: true, email: true };
const RUN_URL = `${STAFF_ORIGIN}/analytics/report-runs/${idN(0x777)}`;
const REPORT_URL = `${PORTAL_ORIGIN}/r/AbCdEfGhIjKlMnOpQrStUv`;
const UNIT_CHANNELS = { smsEnabled: true, whatsappEnabled: true, emailEnabled: true };

async function world(over: { channelsA?: Partial<typeof UNIT_CHANNELS>; extra?: Record<string, unknown> } = {}): Promise<NotifWorld> {
  const w = makeNotifWorld();
  const pat = (id: string, tenantId: string, n: number, consent = all, o: Record<string, unknown> = {}) =>
    ({ id, tenantId, kind: 'patient', fullName: SENTINEL_NAME, phoneE164: PHONE(n), email: `patient-${n}@example.com`, consent, ...o });
  await w.seed({
    recipients: [pat(P_ALL, TENANT_A, 1), pat(P_SMS, TENANT_A, 2, { sms: true, whatsapp: false, email: false }), pat(P_EMAILONLY, TENANT_A, 3, { sms: false, whatsapp: false, email: true }),
      pat(P_NOPHONE, TENANT_A, 4, all, { phoneE164: null }), pat(P_NOEMAIL, TENANT_A, 5, all, { email: null }), pat(P_B, TENANT_B, 6)],
    staffContacts: [
      { id: M_OK, tenantId: TENANT_A, membershipId: M_OK, email: 'staff-ok@example.com', status: 'active', actorType: 'user', locked: false, permissions: [PERM] },
      { id: M_NOEMAIL, tenantId: TENANT_A, membershipId: M_NOEMAIL, email: null, status: 'active', actorType: 'user', locked: false, permissions: [PERM] }],
    channels: { [TENANT_A]: { ...UNIT_CHANNELS, ...over.channelsA }, [TENANT_B]: UNIT_CHANNELS },
    ...over.extra,
  });
  return w;
}
const patient = (patientId: string) => ({ kind: 'patient', patientId });
const reg = (patientId: string, key: string, params: Record<string, string> = { lab_name: 'Synthetic Lab', registered_time_hhmm: '09:30' }) =>
  ({ recipient: patient(patientId), templateCode: 'frontdesk.registration_confirmation', purpose: 'registration_confirmation', params, idempotencyKey: key });
// null (not undefined) = "omit": an undefined argument would silently pick the default.
const ready = (recipient: object, key: string, linkUrl: string | null = REPORT_URL, params: Record<string, string> = { lab_name: 'Synthetic Lab' }) =>
  ({ recipient, templateCode: 'reporting.report_ready', purpose: 'report_ready', params, idempotencyKey: key, ...(linkUrl === null ? {} : { linkUrl }) });
const sched = (membershipId: string, key: string, linkUrl: string | null = RUN_URL, requiredPermission: string | null = PERM) =>
  ({ recipient: { kind: 'staff', membershipId, ...(requiredPermission ? { requiredPermission } : {}) }, templateCode: 'analytics.report_ready', purpose: 'scheduled_report_ready',
    params: { schedule_name: 'Weekly collections' }, idempotencyKey: key, ...(linkUrl === null ? {} : { linkUrl }) });
const otp = (phone: string, key: string, code = '123456') => ({ recipient: { kind: 'phone_otp', phoneE164: phone }, templateCode: 'engagement.login_otp', purpose: 'otp', params: { otp_code: code }, idempotencyKey: key });

const code = (e: any) => e?.code;
const everything = (w: NotifWorld) => JSON.stringify({ rows: w.db.deliveries(), jobs: w.db.jobs.map((j) => ({ ...j, tx: undefined })), events: w.db.events(), rate: w.rateCalls,
  stmts: w.db.stmts.map((s) => s.values) }, (_k, v) => (v && v.type === 'Buffer' ? `buf:${Buffer.from(v.data).toString('hex')}` : v));
const nothingPersisted = (w: NotifWorld) => { expect(w.db.deliveries()).toHaveLength(0); expect(w.db.jobs).toHaveLength(0); expect(w.db.events()).toHaveLength(0); };

describe('AC-16.2 — params are validated against the template registry (REQ-SEC-070)', () => {
  it('registration_confirmation {lab_name, registered_time_hhmm} -> queued delivery, job and status_changed event, all in ctx.tx', async () => {
    const w = await world(); const ctx = w.sys();
    const r = await w.impl.sendSms(ctx, reg(P_ALL, 'ac162-a'));
    expect(r).toMatchObject({ status: 'queued', replayed: false });
    const row = w.db.delivery(r.deliveryId)!;
    expect(row).toMatchObject({ tenant_id: TENANT_A, channel: 'sms', purpose: 'registration_confirmation', template_code: 'frontdesk.registration_confirmation', recipient_kind: 'patient',
      recipient_id: P_ALL, status: 'queued', idempotency_key: 'ac162-a', attempt_no: 1, language: 'en' });
    expect(row['params']).toEqual({ lab_name: 'Synthetic Lab', registered_time_hhmm: '09:30' });
    const jobs = w.db.jobsOf('reporting.send_delivery');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ delivery_id: r.deliveryId });          // 02-TRD §7.2 step 7: no address / params in the job
    expect(String(jobs[0]!.jobKey)).toBe(r.deliveryId);
    expect(jobs[0]!.tx).toBe(ctx.tx);
    const ev = w.db.events();
    expect(ev).toHaveLength(1);
    expect(ev[0]!['event_type']).toBe('reporting.delivery.status_changed.v1');
    expect(ev[0]!['envelope'].payload).toMatchObject({ delivery_id: r.deliveryId, channel: 'sms', purpose: 'registration_confirmation', recipient_kind: 'patient', to_status: 'queued', attempt_no: 1 });
    expect(ev[0]!['envelope'].payload.from_status).toBeUndefined();
    expect(w.frontdesk.calls('getPatientDemographics')[0]!.input).toEqual({ patientId: P_ALL, purpose: 'notification' });
  });

  it('a param named test_names (or any PHI-like / undeclared key) -> 422 reporting.notification_params_invalid; nothing persisted; the value never echoes', async () => {
    const w = await world();
    for (const [i, k] of ['test_names', 'test_name', 'result', 'patient_name', 'diagnosis', 'name', 'phone', 'report_id'].entries()) {
      const e = await rejection(w.impl.sendSms(w.sys(), reg(P_ALL, `phi-${i}`, { lab_name: 'Synthetic Lab', registered_time_hhmm: '09:30', [k]: 'SENTINEL-PARAM-VALUE CBC' })));
      expect(code(e), k).toBe('reporting.notification_params_invalid');
      expect(JSON.stringify({ m: e.message, d: e.safeDetail, f: e.fieldErrors })).not.toContain('SENTINEL-PARAM-VALUE');
    }
    nothingPersisted(w);
  });

  it('values must pass their kind validator; non-string, array, null and __proto__ params are rejected without a row', async () => {
    const w = await world();
    const bad: Array<[string, any]> = [
      ['long short_text', { lab_name: 'L'.repeat(41), registered_time_hhmm: '09:30' }], ['markup in short_text', { lab_name: 'Lab <b>', registered_time_hhmm: '09:30' }],
      ['bad time_hhmm', { lab_name: 'Lab', registered_time_hhmm: '9:5' }], ['time_hhmm minutes 99', { lab_name: 'Lab', registered_time_hhmm: '09:99' }],
      ['number value', { lab_name: 5, registered_time_hhmm: '09:30' }], ['object value', { lab_name: { a: 1 }, registered_time_hhmm: '09:30' }],
      ['array params', ['x']], ['null params', null], ['proto key', JSON.parse('{"__proto__":"x","lab_name":"Lab","registered_time_hhmm":"09:30"}')],
    ];
    for (const [i, [label, params]] of bad.entries()) {
      const e = await rejection(w.impl.sendSms(w.sys(), { ...reg(P_ALL, `kind-${i}`), params }));
      expect(['reporting.notification_params_invalid', 'common.validation_failed'], label).toContain(code(e));
    }
    nothingPersisted(w);
  });

  it('params may be a SUBSET of the declared ones (undeclared is the error, missing is not: the sender fills lab_name later)', async () => {
    const w = await world();
    await expect(w.impl.sendSms(w.sys(), reg(P_ALL, 'subset', { registered_time_hhmm: '09:30' }))).resolves.toMatchObject({ status: 'queued' });
  });

  it('AC-16.6 homecollection.visit_scheduled: {window_start_local, window_end_local} queued; a third param (lab_name) or a bad short_text -> params_invalid', async () => {
    const w = await world();
    const send = (key: string, params: Record<string, string>) => w.impl.sendSms(w.sys(), { recipient: patient(P_ALL), templateCode: 'homecollection.visit_scheduled', purpose: 'booking_confirmation', params, idempotencyKey: key });
    await expect(send('vs-1', { window_start_local: '2026-11-07 07:00', window_end_local: '2026-11-07 09:00' })).resolves.toMatchObject({ status: 'queued' });
    expect(code(await rejection(send('vs-2', { window_start_local: '2026-11-07 07:00', window_end_local: '2026-11-07 09:00', lab_name: 'Synthetic Lab' })))).toBe('reporting.notification_params_invalid');
    expect(code(await rejection(send('vs-3', { window_start_local: '07:00 <b>', window_end_local: '09:00' })))).toBe('reporting.notification_params_invalid');
  });

  it('the registry lives in reporting.g_message_templates (not in code): a template seeded there works, an inactive one is unknown', async () => {
    const w = await world({ extra: { templates: [...DEFAULT_TEMPLATES, { code: 'test.custom_one', purpose: 'follow_up_reminder', channels: ['sms'], params: [{ name: 'x', kind: 'short_text' }], default_texts: {}, is_active: true },
      { code: 'test.inactive_one', purpose: 'follow_up_reminder', channels: ['sms'], params: [], default_texts: {}, is_active: false }] } });
    const send = (templateCode: string, key: string, params: Record<string, string>) => w.impl.sendSms(w.sys(), { recipient: patient(P_ALL), templateCode, purpose: 'follow_up_reminder', params, idempotencyKey: key });
    await expect(send('test.custom_one', 'cu-1', { x: 'ok' })).resolves.toMatchObject({ status: 'queued' });
    expect(code(await rejection(send('test.custom_one', 'cu-2', { y: 'no' })))).toBe('reporting.notification_params_invalid');
    expect(code(await rejection(send('test.inactive_one', 'cu-3', {})))).toBe('reporting.notification_template_unknown');
  });

  it('template lookup: wrong purpose, channel the template does not allow, malformed code -> reporting.notification_template_unknown; code is bound as a parameter', async () => {
    const w = await world();
    const unknown = async (p: Promise<unknown>) => expect(code(await rejection(p))).toBe('reporting.notification_template_unknown');
    await unknown(w.impl.sendSms(w.sys(), { ...reg(P_ALL, 'tu-1'), purpose: 'otp' }));
    await unknown(w.impl.sendWhatsAppTemplate(w.sys(), { recipient: patient(P_ALL), templateCode: 'homecollection.visit_assigned', purpose: 'visit_assignment', params: { route_date: '2026-11-07', visit_count: '2' }, idempotencyKey: 'tu-2' }));
    await unknown(w.impl.sendSms(w.sys(), { ...reg(P_ALL, 'tu-3'), templateCode: "x'; DROP TABLE reporting.deliveries;--" }));
    nothingPersisted(w);
    for (const s of w.db.stmts) expect(s.text).not.toContain('DROP TABLE');
  });

  it('purposes added by 08 (booking_cancelled, booking_reminder) work; datetime kind is ISO', async () => {
    const w = await world();
    const send = (t: string, purpose: string, key: string, datetime: string) => w.impl.sendSms(w.sys(), { recipient: patient(P_ALL), templateCode: t, purpose, params: { lab_name: 'Synthetic Lab', datetime, booking_no: 'BK-0001' }, idempotencyKey: key });
    await expect(send('engagement.booking_cancelled', 'booking_cancelled', 'bc-1', '2026-11-07T09:00:00.000Z')).resolves.toMatchObject({ status: 'queued' });
    await expect(send('engagement.booking_reminder', 'booking_reminder', 'br-1', '2026-11-07T09:00:00.000Z')).resolves.toMatchObject({ status: 'queued' });
    expect(code(await rejection(send('engagement.booking_reminder', 'booking_reminder', 'br-2', 'tomorrow morning')))).toBe('reporting.notification_params_invalid');
  });
});

describe('AC-16.3 — atomic with the caller transaction', () => {
  it('rolled-back ctx.tx leaves no delivery row, no job and no event', async () => {
    const w = await world(); const ctx = w.sys();
    await w.impl.sendSms(ctx, reg(P_ALL, 'rb-1'));
    await w.impl.sendSms(ctx, reg(P_EMAILONLY, 'rb-2'));       // a suppressed row in the same tx also disappears
    expect(w.db.deliveries().length).toBeGreaterThan(0);
    w.rollback(ctx.tx);
    nothingPersisted(w);
  });
  it('a dependency failure mid-call (Frontdesk down) propagates and persists nothing', async () => {
    const w = await world(); w.frontdesk.failNext('getPatientDemographics', 'common.dependency_unavailable');
    expect(code(await rejection(w.impl.sendSms(w.sys(), reg(P_ALL, 'dep-1'))))).toBe('common.dependency_unavailable');
    nothingPersisted(w);
  });
});

describe('AC-08.1 / AC-08.2 / AC-08.5 — report_ready messages per channel and consent (REQ-SEC-005, 04 R4/R6)', () => {
  it('AC-08.1 WhatsApp consent + enabled channel -> one whatsapp delivery, purpose report_ready, params only lab_name + link, no PHI anywhere', async () => {
    const w = await world();
    const r = await w.impl.sendWhatsAppTemplate(w.sys(), { ...ready(patient(P_ALL), 'rr-wa'), related: { entityType: 'report', entityId: idN(0xaa1) } } as any);
    expect(r).toMatchObject({ status: 'queued', replayed: false });
    const row = w.db.delivery(r.deliveryId)!;
    expect(row).toMatchObject({ channel: 'whatsapp', purpose: 'report_ready', template_code: 'reporting.report_ready', recipient_kind: 'patient', recipient_id: P_ALL, status: 'queued',
      related_entity_type: 'report', related_entity_id: idN(0xaa1) });
    expect(Object.keys(row['params']).sort()).toEqual(['lab_name', 'url']);   // link kept in params.url only until a terminal status (02-TRD §7.2 closing para)
    expect(row['params']['url']).toBe(REPORT_URL);
    const blob = everything(w);
    for (const secret of [SENTINEL_NAME, 'Sita', 'Karki', PHONE(1), 'patient-1@example.com']) expect(blob, secret).not.toContain(secret);
    expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(1);
  });

  it('AC-08.1 the link must be the portal origin: other origin, look-alike prefix, http, userinfo -> params_invalid and no row', async () => {
    const w = await world();
    for (const [i, u] of ['https://evil.invalid/r/AbCd', `${PORTAL_ORIGIN}.evil.invalid/r/AbCd`, PORTAL_ORIGIN.replace('https', 'http') + '/r/AbCd', `https://u:p@portal.lims.invalid/r/AbCd`, 'javascript:alert(1)', `${STAFF_ORIGIN}/r/AbCd`].entries())
      expect(code(await rejection(w.impl.sendWhatsAppTemplate(w.sys(), ready(patient(P_ALL), `lk-${i}`, u)))), u).toBe('reporting.notification_params_invalid');
    nothingPersisted(w);
  });

  it('AC-08.2 SMS-only consent: the SMS delivery is queued, the WhatsApp and e-mail calls are suppressed_no_consent (a suppressed row is kept for audit)', async () => {
    const w = await world();
    await expect(w.impl.sendSms(w.sys(), ready(patient(P_SMS), 'sc-sms'))).resolves.toMatchObject({ status: 'queued' });
    const wa = await w.impl.sendWhatsAppTemplate(w.sys(), ready(patient(P_SMS), 'sc-wa'));
    const em = await w.impl.sendEmailLink(w.sys(), ready(patient(P_SMS), 'sc-em') as any);
    expect(wa.status).toBe('suppressed_no_consent'); expect(em.status).toBe('suppressed_no_consent');
    expect(w.db.delivery(wa.deliveryId)).toMatchObject({ status: 'suppressed', failure_code: 'no_consent', channel: 'whatsapp' });
    expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(1);           // only the queued SMS has a send task
  });

  it('AC-08.5 e-mail consent + address -> an email delivery carrying the link (no attachment); no consent / no address / missing link are handled', async () => {
    const w = await world();
    const r = await w.impl.sendEmailLink(w.sys(), ready(patient(P_ALL), 'em-1') as any);
    expect(r.status).toBe('queued');
    const row = w.db.delivery(r.deliveryId)!;
    expect(row).toMatchObject({ channel: 'email', purpose: 'report_ready', status: 'queued' });
    expect(JSON.stringify(row)).not.toMatch(/attachment|pdf|content_snapshot/i);
    expect((await w.impl.sendEmailLink(w.sys(), ready(patient(P_NOEMAIL), 'em-2') as any)).status).toBe('suppressed_no_contact');
    expect((await w.impl.sendEmailLink(w.sys(), ready(patient(P_SMS), 'em-3') as any)).status).toBe('suppressed_no_consent');
    expect(code(await rejection(w.impl.sendEmailLink(w.sys(), ready(patient(P_ALL), 'em-4', null) as any)))).toBe('reporting.notification_params_invalid');
    expect(Object.keys(w.db.delivery(r.deliveryId)!['params'])).not.toContain('email');
  });

  it('consent is per channel; no contact on file -> suppressed_no_contact; consent with no phone is not "queued"', async () => {
    const w = await world();
    expect((await w.impl.sendSms(w.sys(), reg(P_EMAILONLY, 'cn-1'))).status).toBe('suppressed_no_consent');
    expect((await w.impl.sendSms(w.sys(), reg(P_NOPHONE, 'cn-2'))).status).toBe('suppressed_no_contact');
    expect((await w.impl.sendWhatsAppTemplate(w.sys(), ready(patient(P_NOPHONE), 'cn-3'))).status).toBe('suppressed_no_contact');
    expect(w.db.deliveries().every((d) => d['status'] === 'suppressed')).toBe(true);
    expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(0);          // suppressed => no provider task, ever (REQ-SEC-136 spirit)
  });

  it('the tenant channel switch wins over consent and over a missing contact (step 4 before step 5) and is read through IdentityPort.getTenantSettings', async () => {
    const w = await world({ channelsA: { whatsappEnabled: false, emailEnabled: false } });
    expect((await w.impl.sendWhatsAppTemplate(w.sys(), ready(patient(P_SMS), 'ch-1'))).status).toBe('suppressed_channel_disabled');   // no consent either
    expect((await w.impl.sendEmailLink(w.sys(), ready(patient(P_NOEMAIL), 'ch-2') as any)).status).toBe('suppressed_channel_disabled');
    expect(w.db.deliveries().map((d) => d['failure_code'])).toEqual(['channel_disabled', 'channel_disabled']);
    expect(w.identityCalls.some((c) => c.method === 'getTenantSettings' && JSON.stringify(c.input?.keys ?? ['channels']).includes('channels'))).toBe(true);
  });

  it('non-system caller (C4 registration handler, CR-C6-015): consents + contactPresence only; presence decides queued vs suppressed_no_contact; raw contact never stored', async () => {
    const w = await world(); const user = () => w.ctxFor('A');
    const r = await w.impl.sendSms(user(), reg(P_ALL, 'us-1'));
    expect(r.status).toBe('queued');
    expect((await w.impl.sendSms(user(), reg(P_NOPHONE, 'us-2'))).status).toBe('suppressed_no_contact');
    expect((await w.impl.sendSms(user(), reg(P_EMAILONLY, 'us-3'))).status).toBe('suppressed_no_consent');
    expect(everything(w)).not.toContain(PHONE(1));
  });
});

describe('suppression audit trail (02-TRD §7.2 step 5)', () => {
  it('every suppressed result inserts a status=suppressed row (suppressed_at, failure_code) and publishes status_changed -> suppressed; no job', async () => {
    const w = await world({ channelsA: { whatsappEnabled: false } });
    const cases: Array<[string, any, string, string]> = [
      ['no_consent', w.impl.sendSms(w.sys(), reg(P_EMAILONLY, 's-1')), 'suppressed_no_consent', 'no_consent'],
      ['no_contact', w.impl.sendSms(w.sys(), reg(P_NOPHONE, 's-2')), 'suppressed_no_contact', 'no_contact'],
      ['channel_disabled', w.impl.sendWhatsAppTemplate(w.sys(), reg(P_ALL, 's-3')), 'suppressed_channel_disabled', 'channel_disabled'],
    ];
    for (const [fc, p, status, failure] of cases) {
      const r = await p; expect(r.status, fc).toBe(status);
      const row = w.db.delivery(r.deliveryId)!;
      expect(row).toMatchObject({ status: 'suppressed', failure_code: failure });
      expect(row['suppressed_at']).toBeTruthy(); expect(row['queued_at'] ?? null).toBeNull();
      const ev = w.db.events().find((e) => e['envelope'].payload.delivery_id === r.deliveryId)!;
      expect(ev['envelope'].payload).toMatchObject({ to_status: 'suppressed', failure_code: failure });
    }
    expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(0);
  });
});

describe('AC-16.4 / AC-16.5 / contract 9-11 — staff recipients (08 A4.2, A13 D-29, D-34)', () => {
  it('scheduled_report_ready + eligible staff: contact resolved ONLY via IdentityPort.getStaffNotificationContact(system), email delivery queued, address not stored', async () => {
    const w = await world(); const ctx = w.sys();
    const r = await w.impl.sendEmailLink(ctx, sched(M_OK, 'st-1') as any);
    expect(r.status).toBe('queued');
    const calls = w.identityCalls.filter((c) => c.method === 'getStaffNotificationContact');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ actorType: 'system', input: { membershipId: M_OK, requiredPermission: PERM } });
    expect(w.frontdesk.calls('getPatientDemographics')).toHaveLength(0);       // never FrontdeskPort for staff
    const row = w.db.delivery(r.deliveryId)!;
    expect(row).toMatchObject({ channel: 'email', purpose: 'scheduled_report_ready', template_code: 'analytics.report_ready', recipient_kind: 'staff', recipient_id: M_OK, centre_id: null });
    expect(row['params']['url']).toBe(RUN_URL);
    expect(JSON.stringify(row)).not.toContain('staff-ok@example.com');
    expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(1);
  });

  it('staff without requiredPermission, with email null, or unknown membership -> suppressed_no_contact (row kept, no job)', async () => {
    const w = await world();
    expect((await w.impl.sendEmailLink(w.sys(), sched(M_OK, 'st-2', RUN_URL, null) as any)).status).toBe('suppressed_no_contact');
    expect((await w.impl.sendEmailLink(w.sys(), sched(M_NOEMAIL, 'st-3') as any)).status).toBe('suppressed_no_contact');
    expect((await w.impl.sendEmailLink(w.sys(), sched(idN(0x2ff), 'st-4') as any)).status).toBe('suppressed_no_contact');
    expect(w.db.deliveries().map((d) => d['status'])).toEqual(['suppressed', 'suppressed', 'suppressed']);
    expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(0);
  });

  it('AC-16.5 visit_assigned to staff: success with suppressed_no_contact (no error), no staff lookup, no Frontdesk call', async () => {
    const w = await world();
    const r = await w.impl.sendSms(w.sys(), { recipient: { kind: 'staff', membershipId: M_OK }, templateCode: 'homecollection.visit_assigned', purpose: 'visit_assignment', params: { route_date: '2026-11-05', visit_count: '4' }, idempotencyKey: 'st-5' });
    expect(r.status).toBe('suppressed_no_contact');
    expect(w.db.delivery(r.deliveryId)).toMatchObject({ status: 'suppressed', failure_code: 'no_contact', recipient_kind: 'staff', recipient_id: M_OK });
    expect(w.identityCalls.filter((c) => c.method === 'getStaffNotificationContact')).toHaveLength(0);
    expect(w.frontdesk.calls('getPatientDemographics')).toHaveLength(0);
    expect((await w.impl.sendSms(w.sys(), { ...reg(P_ALL, 'st-6'), recipient: { kind: 'staff', membershipId: M_OK, requiredPermission: PERM } })).status).toBe('suppressed_no_contact');   // permission does not lift it for other purposes
  });

  it('AC-16.4 staff_url: only {LIMS_ORIGIN_STAFF_WEB}/<staff route> passes; portal URL, other origin, look-alike host, http, userinfo, query, fragment, non-route path, missing link -> params_invalid', async () => {
    const w = await world();
    const bad = [`${PORTAL_ORIGIN}/r/AbCd`, `https://evil.invalid/analytics/report-runs/${idN(1)}`, `https://staff.lims.invalid.evil.invalid/analytics/report-runs/${idN(1)}`,
      `http://staff.lims.invalid/analytics/report-runs/${idN(1)}`, `https://u:p@staff.lims.invalid/analytics/report-runs/${idN(1)}`, `${RUN_URL}?next=//evil.invalid`, `${RUN_URL}#x`,
      `${STAFF_ORIGIN}/admin/secret`, `${STAFF_ORIGIN}/analytics/report-runs/${idN(1)}/../../admin`, '/analytics/report-runs/x', null];
    for (const [i, u] of bad.entries()) expect(code(await rejection(w.impl.sendEmailLink(w.sys(), sched(M_OK, `su-${i}`, u) as any))), String(u)).toBe('reporting.notification_params_invalid');
    nothingPersisted(w);
    expect((await w.impl.sendEmailLink(w.sys(), sched(M_OK, 'su-ok') as any)).status).toBe('queued');
  });

  it('staff_url is only for purpose scheduled_report_ready to a staff recipient: a patient recipient on analytics.report_ready is rejected, nothing persisted', async () => {
    const w = await world();
    const e = await rejection(w.impl.sendEmailLink(w.sys(), { ...sched(M_OK, 'su-pat'), recipient: patient(P_ALL) } as any));
    expect(['reporting.notification_params_invalid', 'reporting.notification_template_unknown']).toContain(code(e));
    nothingPersisted(w);
  });

  it('label_text (schedule_name): <=80 chars, no control characters, no "://" / "www." in any case', async () => {
    const w = await world();
    const send = (name: string, key: string) => w.impl.sendEmailLink(w.sys(), { ...sched(M_OK, key), params: { schedule_name: name } } as any);
    for (const [i, bad] of ['x'.repeat(81), 'a\nb', 'a\u0000b', 'HTTPS://x.invalid', 'visit WWW.lab', 'ftp://x'].entries()) expect(code(await rejection(send(bad, `lt-${i}`))), bad).toBe('reporting.notification_params_invalid');
    await expect(send('x'.repeat(80), 'lt-ok')).resolves.toMatchObject({ status: 'queued' });
  });
});

describe('centre and partner recipients (review fix #30)', () => {
  const contact = (id: string, over: Record<string, unknown> = {}) => ({ id, tenant_id: TENANT_A, centre_id: CENTRE_1, channel: 'sms', address: `+977980010${id.slice(-4)}`, created_at: '2026-11-01T00:00:00.000Z', is_active: true, ...over });
  const send = (w: NotifWorld, key: string, ctx = w.sys()) => w.impl.sendSms(ctx, { recipient: { kind: 'centre', centreId: CENTRE_1 }, templateCode: 'reporting.report_ready', purpose: 'report_ready', params: { lab_name: 'Synthetic Lab', url: REPORT_URL }, idempotencyKey: key });

  it('external centre call uses the OLDEST ACTIVE contact of the channel (created_at, then id): inactive, other-channel and other-tenant contacts are ignored', async () => {
    const w = await world({ extra: { centreContacts: [
      contact(idN(0x9001), { created_at: '2026-10-01T00:00:00.000Z', is_active: false }), contact(idN(0x9002), { created_at: '2026-10-05T00:00:00.000Z', channel: 'email', address: 'c@example.com' }),
      contact(idN(0x9003), { created_at: '2026-10-09T00:00:00.000Z', tenant_id: TENANT_B }), contact(idN(0x9005), { created_at: '2026-10-10T00:00:00.000Z' }),
      contact(idN(0x9004), { created_at: '2026-10-10T00:00:00.000Z' }), contact(idN(0x9006), { created_at: '2026-10-20T00:00:00.000Z' })] } });
    const r = await send(w, 'ce-1');
    expect(r.status).toBe('queued');
    expect(w.db.delivery(r.deliveryId)).toMatchObject({ recipient_kind: 'centre', recipient_id: idN(0x9004), centre_id: CENTRE_1, channel: 'sms' });    // tie on created_at -> lowest id
    expect(JSON.stringify(w.db.delivery(r.deliveryId))).not.toContain('+977980010');
  });
  it('no active contact for the channel (or only another tenant\'s) -> suppressed_no_contact', async () => {
    const w = await world({ extra: { centreContacts: [contact(idN(0x9010), { is_active: false }), contact(idN(0x9011), { tenant_id: TENANT_B })] } });
    expect((await send(w, 'ce-2')).status).toBe('suppressed_no_contact');
    expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(0);
  });
  it('partner -> suppressed_no_contact in Phase 1 without asking any port; unknown recipient kind -> rejected, no row', async () => {
    const w = await world();
    const r = await w.impl.sendSms(w.sys(), { recipient: { kind: 'partner', partnerId: PARTNER_1 }, templateCode: 'reporting.report_ready', purpose: 'report_ready', params: { lab_name: 'Synthetic Lab', url: REPORT_URL }, idempotencyKey: 'pa-1' });
    expect(r.status).toBe('suppressed_no_contact');
    expect(w.db.delivery(r.deliveryId)).toMatchObject({ recipient_kind: 'partner', recipient_id: PARTNER_1, status: 'suppressed' });
    expect(w.frontdesk.calls('getPatientDemographics')).toHaveLength(0);
    const before = w.db.deliveries().length;
    expect(code(await rejection(w.impl.sendSms(w.sys(), { ...reg(P_ALL, 'pa-2'), recipient: { kind: 'alien', id: P_ALL } })))).toBe('common.validation_failed');
    expect(w.db.deliveries()).toHaveLength(before);
  });
});

describe('OTP (contract 6; 04 A9; review fix #41; 08 A13 D-31)', () => {
  it('stores phone_otp destination (E.164 until terminal, sha256 bytea, masked) and limits via ctx.rateLimit tier otp_request key p:<sha256 hex of the E.164> once per NEW send', async () => {
    const w = await world(); const phone = PHONE(31);
    const r = await w.impl.sendSms(w.sys(), otp(phone, 'o-1'));
    expect(r.status).toBe('queued');
    expect(w.rateCalls).toEqual([{ tier: 'otp_request', key: `p:${sha256hex(phone)}` }]);    // core limiter grammar: otp_request accepts prefix `p:` only
    const row = w.db.delivery(r.deliveryId)!;
    expect(row).toMatchObject({ recipient_kind: 'phone_otp', channel: 'sms', purpose: 'otp', template_code: 'engagement.login_otp', destination_e164: phone, centre_id: null, recipient_id: null });
    expect(Buffer.from(row['destination_sha256']).toString('hex')).toBe(sha256hex(phone));
    expect(String(row['destination_masked']).length).toBeLessThanOrEqual(40);
    expect(String(row['destination_masked'])).not.toContain(phone); expect(String(row['destination_masked'])).not.toContain(phone.slice(1));
    for (let i = 0; i < 5; i++) await expect(w.impl.sendSms(w.sys(), otp(phone, 'o-1'))).resolves.toMatchObject({ deliveryId: r.deliveryId, replayed: true });
    expect(w.rateCalls).toHaveLength(1);                                                      // replays never consume the quota
  });
  it('4th send to one phone -> common.rate_limited with no 4th row/job/event; other phones and other purposes are unaffected', async () => {
    const w = await world(); const phone = PHONE(32);
    for (const k of ['a', 'b', 'c']) await w.impl.sendSms(w.sys(), otp(phone, k));
    expect(code(await rejection(w.impl.sendSms(w.sys(), otp(phone, 'd'))))).toBe('common.rate_limited');
    expect(w.db.deliveries()).toHaveLength(3); expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(3); expect(w.db.events()).toHaveLength(3);
    await expect(w.impl.sendSms(w.sys(), otp(PHONE(33), 'e'))).resolves.toMatchObject({ status: 'queued' });
    for (let i = 0; i < 5; i++) await w.impl.sendSms(w.sys(), reg(P_ALL, `nr-${i}`));
    expect(w.rateCalls.every((c) => c.key.startsWith('p:'))).toBe(true); expect(w.rateCalls).toHaveLength(5);   // 3 + rejected 4th + other phone; registration sends never consume
  });
  it('tenant SMS channel disabled -> suppressed_channel_disabled before any quota is consumed', async () => {
    const w = await world({ channelsA: { smsEnabled: false } });
    expect((await w.impl.sendSms(w.sys(), otp(PHONE(34), 'o-d'))).status).toBe('suppressed_channel_disabled');
    expect(w.rateCalls).toHaveLength(0);
  });
  it('invalid E.164, wrong purpose for phone_otp, malformed otp_code -> rejected, no row', async () => {
    const w = await world();
    for (const [i, p] of ['9800000031', '+0123456789', '+977', '+97798000003112345678', '+977 9800000031', ''].entries()) {
      const e = await rejection(w.impl.sendSms(w.sys(), otp(p, `bp-${i}`)));
      expect(['common.validation_failed', 'reporting.notification_params_invalid'], p).toContain(code(e));
    }
    expect(code(await rejection(w.impl.sendSms(w.sys(), { ...reg(P_ALL, 'bp-x'), recipient: { kind: 'phone_otp', phoneE164: PHONE(35) } })))).toBe('common.validation_failed');
    for (const [i, c] of ['12345', '1234567', 'abcdef', '12 456', ''].entries()) expect(code(await rejection(w.impl.sendSms(w.sys(), otp(PHONE(36), `bc-${i}`, c)))), c).toBe('reporting.notification_params_invalid');
    nothingPersisted(w);
  });
  it('the OTP code and the phone never reach events, jobs, limiter keys or errors', async () => {
    const w = await world(); const phone = PHONE(37);
    await w.impl.sendSms(w.sys(), otp(phone, 'lk-1', '246810'));
    for (const k of ['q', 'r', 's']) await w.impl.sendSms(w.sys(), otp(phone, k, '246810')).catch(() => undefined);
    const e = await rejection(w.impl.sendSms(w.sys(), otp(phone, 'lk-z', '246810')));
    const blob = JSON.stringify({ ev: w.db.events(), jobs: w.db.jobs.map((j) => j.payload), rate: w.rateCalls, err: [e.message, e.safeDetail] });
    expect(blob).not.toContain('246810'); expect(blob).not.toContain(phone);
  });
});

describe('idempotency, tenant isolation, concurrency (REQ-SEC-024, P-40)', () => {
  it('replay of a SUPPRESSED send returns the same suppressed_* status and deliveryId, replayed:true, and writes nothing more', async () => {
    const w = await world(); const a = await w.impl.sendSms(w.sys(), reg(P_EMAILONLY, 'rp-1'));
    const before = { d: w.db.deliveries().length, e: w.db.events().length, j: w.db.jobs.length };
    const b = await w.impl.sendSms(w.sys(), reg(P_EMAILONLY, 'rp-1'));
    expect(b).toEqual({ ...a, replayed: true }); expect(a.status).toBe('suppressed_no_consent');
    expect({ d: w.db.deliveries().length, e: w.db.events().length, j: w.db.jobs.length }).toEqual(before);
  });
  it('replay wins before validation of the new call and never mutates the stored row', async () => {
    const w = await world(); const a = await w.impl.sendSms(w.sys(), reg(P_ALL, 'rp-2'));
    const snap = JSON.stringify(w.db.delivery(a.deliveryId));
    const b = await w.impl.sendSms(w.sys(), reg(P_ALL, 'rp-2', { lab_name: 'Other Lab', registered_time_hhmm: '10:00' }));
    expect(b.deliveryId).toBe(a.deliveryId); expect(JSON.stringify(w.db.delivery(a.deliveryId))).toBe(snap);
  });
  it('the same key in another tenant is a different delivery; a tenant-A caller cannot see or replay tenant B\'s row; a tenant-B patient is common.not_found for tenant A', async () => {
    const w = await world();
    const a = await w.impl.sendSms(w.sys('A'), reg(P_ALL, 'iso-1'));
    expect(code(await rejection(w.impl.sendSms(w.sys('A'), reg(P_B, 'iso-2'))))).toBe('common.not_found');
    const b = await w.impl.sendSms(w.sys('B'), reg(P_B, 'iso-1'));
    expect(b.deliveryId).not.toBe(a.deliveryId); expect(b.replayed).toBe(false);
    expect(w.db.delivery(b.deliveryId)!['tenant_id']).toBe(TENANT_B);
    expect(w.db.deliveries().filter((d) => d['idempotency_key'] === 'iso-2')).toHaveLength(0);     // not_found leaves nothing behind
  });
  it('every statement on reporting.deliveries / centre_contacts is tenant-scoped explicitly (defence in depth next to RLS)', async () => {
    const w = await world({ extra: { centreContacts: [{ id: idN(0x9100), tenant_id: TENANT_A, centre_id: CENTRE_1, channel: 'sms', address: '+97798001099', created_at: '2026-11-01T00:00:00.000Z' }] } });
    await w.impl.sendSms(w.sys(), reg(P_ALL, 'tn-1')); await w.impl.sendSms(w.sys(), reg(P_ALL, 'tn-1'));
    await w.impl.sendSms(w.sys(), { recipient: { kind: 'centre', centreId: CENTRE_1 }, templateCode: 'reporting.report_ready', purpose: 'report_ready', params: { lab_name: 'Lab', url: REPORT_URL }, idempotencyKey: 'tn-2' });
    const scoped = w.db.stmts.filter((s) => /\b(from|into|update)\s+reporting\.(deliveries|centre_contacts)\b/i.test(s.text));
    expect(scoped.length).toBeGreaterThan(2);
    for (const s of scoped) { expect(s.text, s.text).toMatch(/tenant_id/i); expect(s.values, s.text).toContain(TENANT_A); }
  });
  it('invalid idempotency keys (missing, empty, 201 chars, control chars) -> common.validation_failed; 200 chars is accepted', async () => {
    const w = await world();
    for (const k of [undefined, '', 'k'.repeat(201), 'a\nb', 5 as any]) expect(code(await rejection(w.impl.sendSms(w.sys(), { ...reg(P_ALL, k as any), idempotencyKey: k as any }))), String(k)).toBe('common.validation_failed');
    nothingPersisted(w);
    await expect(w.impl.sendSms(w.sys(), reg(P_ALL, 'k'.repeat(200)))).resolves.toMatchObject({ status: 'queued' });
  });
  it('10 concurrent calls with one key: one row, one job, one event, one replayed:false, all return the same deliveryId, none rejects', async () => {
    const w = await world();
    const rs = await Promise.all(Array.from({ length: 10 }, () => w.impl.sendSms(w.sys(), reg(P_ALL, 'cc-1'))));
    expect(new Set(rs.map((r: any) => r.deliveryId)).size).toBe(1);
    expect(rs.filter((r: any) => r.replayed === false)).toHaveLength(1);
    expect(w.db.deliveries()).toHaveLength(1); expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(1); expect(w.db.events()).toHaveLength(1);
  });
  it('no network, no provider: the call completes with fetch/net disabled (REQ-SEC-136, outbox only)', async () => {
    const w = await world(); const realFetch = globalThis.fetch;
    (globalThis as any).fetch = () => { throw new Error('network call from NotificationPort'); };
    try { await expect(w.impl.sendSms(w.sys(), reg(P_ALL, 'nn-1'))).resolves.toMatchObject({ status: 'queued' }); } finally { globalThis.fetch = realFetch; }
  });
});

describe('PHI / secrets (07-SECURITY P2, REQ-SEC-070)', () => {
  it('after sends to patient/staff/centre/partner/otp, patient name, raw phone/email and OTP never appear in rows (except the OTP E.164 and the declared params), events, jobs, limiter keys, statements text', async () => {
    const w = await world({ extra: { centreContacts: [{ id: idN(0x9200), tenant_id: TENANT_A, centre_id: CENTRE_1, channel: 'sms', address: '+97798001100', created_at: '2026-11-01T00:00:00.000Z' }] } });
    await w.impl.sendSms(w.sys(), reg(P_ALL, 'ph-1')); await w.impl.sendWhatsAppTemplate(w.sys(), ready(patient(P_ALL), 'ph-2')); await w.impl.sendEmailLink(w.sys(), ready(patient(P_ALL), 'ph-3') as any);
    await w.impl.sendEmailLink(w.sys(), sched(M_OK, 'ph-4') as any);
    await w.impl.sendSms(w.sys(), { recipient: { kind: 'centre', centreId: CENTRE_1 }, templateCode: 'reporting.report_ready', purpose: 'report_ready', params: { lab_name: 'Lab', url: REPORT_URL }, idempotencyKey: 'ph-5' });
    const blob = everything(w) + w.db.stmts.map((s) => s.text).join('\n');
    for (const secret of [SENTINEL_NAME, 'Karki', PHONE(1), 'patient-1@example.com', 'staff-ok@example.com', '+97798001100']) expect(blob, secret).not.toContain(secret);
    for (const row of w.db.deliveries()) expect(Object.keys(row['params'])).not.toEqual(expect.arrayContaining(['phone', 'email', 'name']));
  });
  it('SQL is parameterised: no value (key, template code, params) is interpolated into statement text', async () => {
    const w = await world(); const marker = 'k-marker-77';
    await w.impl.sendSms(w.sys(), reg(P_ALL, marker));
    for (const s of w.db.stmts) expect(s.text).not.toContain('marker');
  });
});
