// C6-T20 worker task reporting.send_portal_otp (02-TRD §9 + 08 A13 D-31; 01-PRD AC-11.1, AC-11.4; 07-SECURITY T4, A4, A21, 8g, 9).
// ASSUMED: tasks/send_portal_otp.ts exports createSendPortalOtp() -> TaskHandler; payload { tenant_id, challenge_id }; ctx = JobContext (+ ports, audit, tx);
// reads/writes reporting.otp_challenges / portal_links / reports via ctx.tx.query (parameterised, tenant-scoped, UPDATE guarded by status = 'pending_send');
// patient contact = ctx.ports.FrontdeskPort.getPatientDemographics(ctx, { patientId, purpose: 'notification' }) as the system actor; send =
// ctx.ports.NotificationPort.sendSms(ctx, { recipient: { kind: 'patient', patientId }, templateCode: 'reporting.portal_otp', purpose: 'otp',
//   params: { otp_code, lab_name, minutes }, idempotencyKey: contains the challenge id }); HMAC key file = process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE (read at call time).
// destination_sha256 = SHA-256 of the E.164 string. Manifest (jobs/reporting/index.ts) registers the task with maxAttempts 8, and also `reporting.reissue_portal_link`.
import '../../../../../api/src/__tests__/setup-env.js';   // test env defaults (LIMS_CORE_ENV, OTP HMAC key file) - the API module manifest is imported by the end-to-end case
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });

const H = () => import('../../../../../api/src/modules/reporting/__tests__/portal.helpers.js');
async function setup() {
  const h = await H(); const w = h.makePortalWorld();
  const { createSendPortalOtp } = await import('../tasks/send_portal_otp.js'); const task = createSendPortalOtp() as (p: any, c: any) => Promise<void>;
  const pending = (link: Record<string, any>, over: Record<string, any> = {}) => {
    const id = w.db.newId(); w.db.insert('otp_challenges', { id, tenant_id: link['tenant_id'], link_id: link['id'], channel: 'sms', status: 'pending_send', expires_at: new Date(Date.parse(w.now()) + 600_000).toISOString(), created_by: link['id'], ...over });
    return { id, row: w.db.store['otp_challenges']!.find((c) => c['id'] === id)! };
  };
  const go = (id: string, over: Record<string, any> = {}) => w.runTask(task, { tenant_id: h.TENANT_A, challenge_id: id }, over);
  return { h, w, task, pending, go };
}

describe('send_portal_otp: success path (AC-11.1, D-31 (b))', () => {
  it('no stored destination -> patient phone on file: destination hash + code HMAC stored, status pending, SMS through NotificationPort as the system actor', async () => {
    const { h, w, pending, go } = await setup(); const l = w.mkLink(); const ch = pending(l.row);
    await go(ch.id);
    expect(ch.row['status']).toBe('pending'); expect(Buffer.from(ch.row['destination_sha256']).toString('hex')).toBe(h.sha256hex(h.PHONE)); expect(ch.row['code_hmac'].length).toBe(32);
    expect(w.sent).toHaveLength(1); const s = w.sent[0]!;
    expect(s.method).toBe('sendSms'); expect(s.ctxActor).toBe('system');
    expect(s.input).toMatchObject({ recipient: { kind: 'patient', patientId: h.PATIENT_A }, templateCode: 'reporting.portal_otp', purpose: 'otp' });
    expect(s.code).toMatch(/^[0-9]{6}$/); expect(String(s.input.idempotencyKey)).toContain(ch.id);
    expect(Buffer.from(ch.row['code_hmac']).equals(w.hmacOf(ch.id, s.code!))).toBe(true);           // the stored HMAC verifies the sent code (domain/otp.ts format)
    expect(Object.keys(s.input.params).sort()).toEqual(expect.arrayContaining(['otp_code']));
    expect(JSON.stringify(s.input.params)).not.toMatch(/Test Patient|0001SY|report|portal\.lims/i);   // REQ-SEC-070: code, lab name, minutes only
    expect(w.audit.some((e) => e['action'] === 'auth.otp_sent')).toBe(true);
  });
  it('known destination that still matches the contact on file -> sent', async () => {
    const { h, w, pending, go } = await setup(); const l = w.mkLink({ destination_sha256: h.sha256buf(h.PHONE) }); const ch = pending(l.row);
    await go(ch.id); expect(w.sent).toHaveLength(1); expect(ch.row['status']).toBe('pending');
  });
  it('the sent code is random per challenge (>= 18 distinct of 20 challenges, each in its own world)', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) { const { w, pending, go } = await setup(); await go(pending(w.mkLink().row).id); codes.add(w.sent[0]!.code!); }
    expect(codes.size).toBeGreaterThanOrEqual(18);
  });
  it('end to end with P2: the code in the SMS opens the session; a wrong code does not', async () => {
    const { w, pending, go } = await setup(); const l = w.mkLink(); const ch = pending(l.row); await go(ch.id);
    const code = w.sent[0]!.code!;
    await expect(w.call.p2(l.cred, ch.id, w.wrongCode(code))).rejects.toMatchObject({ code: 'auth.otp_invalid' });
    expect((await w.call.p2(l.cred, ch.id, code)).status).toBe(200);
  });
});

describe('send_portal_otp: failure paths (A21, D-31, AC-11.4)', () => {
  it('A21: patient without a phone -> challenge failed (no_contact), nothing sent, task returns normally; P2 then answers auth.otp_invalid like any wrong code', async () => {
    const { h, w, pending, go } = await setup(); w.frontdesk.__seed({ patients: [{ id: h.idN(0x999), tenantId: h.TENANT_A, patientCode: 'P-A-0999', fullName: 'Test Patient 0999', sex: 'female',
      consents: { sms: true, whatsapp: false, email: false, shareWithReferrer: false, consentTextVersion: 'v1' }, status: 'active' }] });
    w.db.store['reports']!.find((r) => r['id'] === h.REPORT_A)!['patient_id'] = h.idN(0x999);
    const l = w.mkLink(); const ch = pending(l.row); await go(ch.id);
    expect(ch.row).toMatchObject({ status: 'failed', failure_code: 'no_contact' }); expect(w.sent).toEqual([]);
    expect((await h.rejection(w.call.p2(l.cred, ch.id, '123456'))).code).toBe('auth.otp_invalid');
  });
  it('known destination that no longer matches the contact on file -> failed (no_contact), nothing sent', async () => {
    const { h, w, pending, go } = await setup(); const l = w.mkLink({ destination_sha256: h.sha256buf('+9779811111111') }); const ch = pending(l.row);
    await go(ch.id); expect(ch.row).toMatchObject({ status: 'failed', failure_code: 'no_contact' }); expect(w.sent).toEqual([]);
  });
  it('AC-11.4: 4th OTP to the same phone through different links -> challenge superseded (send_rate_limited), no 4th SMS, task does not throw', async () => {
    const { w, pending, go } = await setup(); const rows = [];
    for (let i = 0; i < 4; i++) { const ch = pending(w.mkLink().row); rows.push(ch); await go(ch.id); }
    expect(w.sent).toHaveLength(3); expect(rows.slice(0, 3).every((r) => r.row['status'] === 'pending')).toBe(true);
    expect(rows[3]!.row).toMatchObject({ status: 'superseded', failure_code: 'send_rate_limited' });
  });
  it('a transient NotificationPort failure throws (queue retry) and leaves the challenge retryable, never pending with a code nobody got', async () => {
    const { w, pending, go } = await setup(); const ch = pending(w.mkLink().row); w.notif.send = async () => { throw new Error('provider down'); };
    await expect(go(ch.id)).rejects.toThrow(); expect(ch.row['status']).toBe('pending_send'); expect(ch.row['code_hmac']).toBeNull();
  });
  it('runs once: a second run for the same challenge sends nothing; expired / unknown / other-tenant / non-pending_send challenges are skipped silently', async () => {
    const { h, w, task, pending, go } = await setup(); const ch = pending(w.mkLink().row); await go(ch.id); await go(ch.id); expect(w.sent).toHaveLength(1);
    const old = pending(w.mkLink().row); w.advance(11 * 60_000); await go(old.id); expect(old.row['status']).toBe('pending_send'); expect(w.sent).toHaveLength(1);
    await go(h.idN(0xdead)); const sup = pending(w.mkLink().row, { status: 'superseded' }); await go(sup.id); expect(w.sent).toHaveLength(1);
    const other = pending(w.mkLink().row); await w.runTask(task, { tenant_id: h.TENANT_B, challenge_id: other.id }, { tenantId: h.TENANT_B });
    expect(other.row['status']).toBe('pending_send'); expect(w.sent).toHaveLength(1);
  });
  it('N + 1 parallel runs for one challenge send exactly once (guarded UPDATE / row lock)', async () => {
    const { w, pending, go } = await setup(); const ch = pending(w.mkLink().row);
    await Promise.all([go(ch.id), go(ch.id), go(ch.id)]); expect(w.sent).toHaveLength(1);
  });
  it('no phone, code, destination hash or link token reaches logs or the audit row (T17, 07-SECURITY 9)', async () => {
    const { h, w, pending, go } = await setup(); const l = w.mkLink(); const ch = pending(l.row); await go(ch.id);
    const text = w.logs.join('') + JSON.stringify(w.audit);
    for (const s of [h.PHONE, w.sent[0]!.code!, l.token, 'Test Patient 0001']) expect(text, s).not.toContain(s);
  });
  it('never calls BillingPort / PaymentProviderPort / SmartReportPort', async () => {
    const { w, pending, go } = await setup(); await go(pending(w.mkLink().row).id); expect(w.forbiddenCalls).toEqual([]);
  });
});

describe('worker manifest wiring', () => {
  it('registers reporting.send_portal_otp (maxAttempts 8) and reporting.reissue_portal_link (enqueue_job rejects unregistered tasks)', async () => {
    const { manifest } = await import('../index.js');
    expect(typeof manifest.tasks!['reporting.send_portal_otp']).toBe('function'); expect(typeof manifest.tasks!['reporting.reissue_portal_link']).toBe('function');
    expect(manifest.maxAttempts!['reporting.send_portal_otp']).toBe(8);
  });
});
