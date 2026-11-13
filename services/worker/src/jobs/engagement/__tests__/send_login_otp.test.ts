// C16.T-A2 — task engagement.send_login_otp (06-PLAN row T-A2; 02-TRD §4.1 step 2, §8.1 max 3, §9 sendSms row, access log row `auth.otp_sent`; PRD US-EN-01.2, .9; 07-SECURITY OTP rows).
// done_when: ciphertext nulled after send; supersession as the system actor. tests: log-scan for OTP/phone.
// Fails now: manifest task 'engagement.send_login_otp' is the T-01 fail-closed stub (tasks/send_login_otp.ts does not exist).
//
// SEAMS (spec fixes behaviour, not names; same convention as reminders.test.ts):
//   tasks/send_login_otp.ts exports createSendLoginOtp() -> TaskHandler; ctx = worker JobContext (system actor, tx, now(), ports{NotificationPort, IdentityPort}, audit.access, log).
//   The payload is whatever the REAL requestPatientOtp handler enqueued (job 'engagement.send_login_otp', key otp:<challenge_id>): the challenge is created by the E2 handler, so the ciphertext layout stays the writer's.
//   Order (TRD §4.1 step 2): (1) mark earlier pending/sent challenges of the same phone_hmac + app_instance_id (tenant) `superseded`; (2) load the challenge (status pending, not expired); (3) decrypt with code_key_id;
//   (4) sendSms({recipient:{kind:'phone_otp',phoneE164}, templateCode:'engagement.login_otp', purpose:'otp', params:{otp_code,lab_name,minutes}, idempotencyKey:'otp:<id>', related: undefined});
//   (5) code_ciphertext = NULL, status = 'sent', send_delivery_id; access log {action:'auth.otp_sent', entityType:'otp_challenge', entityId, outcome:'success'}.
//   lab_name = IdentityPort.getTenantSettings(...).branding.displayName; minutes = TTL minutes as a string ('5'). Port common.rate_limited -> challenge `failed`, no throw. Any other port error THROWS (tx rolls back, retry reuses the key).
//   NOTE for the writer: packages/fakes NotificationPort fake's template `engagement.login_otp` declares params { otp_code } only; add lab_name (short_text) and minutes (short_text) to the fake's default seed when wiring.
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { handlers } from '../../../../../api/src/modules/engagement/handlers/index.js';
import { APP_INSTANCE, APP_INSTANCE_2, ID, LAB_NAME, TENANT_A, TENANT_B, codeHmac, makeOtpWorld, phoneHmac, phoneN, type OtpWorld } from '../../../../../api/src/modules/engagement/__tests__/otp.world.js';

const send = async () => (await import('../tasks/send_login_otp.js')).createSendLoginOtp() as (p: any, c: any) => Promise<void>;
const ask = (w: OtpWorld, phone = phoneN(1), over: Record<string, unknown> = {}) =>
  w.inTx(() => (handlers as any).requestPatientOtp({ params: {}, query: {}, headers: {}, body: { phone_e164: phone, app_instance_id: APP_INSTANCE, app_platform: 'android', ...over } }, w.preAuthCtx()));
const lastJob = (w: OtpWorld) => w.jobs('engagement.send_login_otp').at(-1)!;
async function setup() {
  const w = makeOtpWorld(); const task = await send();
  const run = (payload: any, over: Record<string, any> = {}) => w.inTx(() => task(payload, w.jobCtx(over)));
  return { w, run };
}
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } return undefined; };

describe('manifest (TRD §8.1)', () => {
  it('engagement.send_login_otp is implemented (no longer the fail-closed stub), max_attempts 3, manifest still validates', async () => {
    expect(() => validateManifests([manifest])).not.toThrow();
    expect(manifest.maxAttempts?.['engagement.send_login_otp']).toBe(3);
    const { w } = await setup(); await ask(w);
    const r = await rejection(manifest.tasks!['engagement.send_login_otp']!(lastJob(w).payload as any, w.jobCtx() as any));
    expect(String(r?.message ?? '')).not.toMatch(/not implemented/);
  });
});

describe('test-world guard: UNIQUE (tenant_id, token_sha256) (05-SCHEMA :254; arbiter ruling T-A2)', () => {
  const bump = (w: OtpWorld, id: string) => w.jobCtx().tx.query('UPDATE engagement.otp_challenges SET attempts = 1 WHERE id = $1', [id]);
  it('an UPDATE of a row that keeps its own token_sha256 is NOT a collision', async () => {
    const w = makeOtpWorld(); const c = w.seedChallenge();
    await expect(bump(w, c['id'])).resolves.toMatchObject({ rowCount: 1 });
  });
  it('two distinct ids with the same tenant + token_sha256 DO collide (23505)', async () => {
    const w = makeOtpWorld(); const tok = Buffer.alloc(32, 7); w.seedChallenge({ token_sha256: tok }); const b = w.seedChallenge({ token_sha256: tok });
    await expect(bump(w, b['id'])).rejects.toMatchObject({ code: '23505' });
  });
});

describe('send: US-EN-01.2', () => {
  it('sends ONCE as the system actor with recipient {phone_otp, phoneE164}, purpose otp, templateCode engagement.login_otp, params EXACTLY {otp_code, lab_name, minutes}, idempotencyKey otp:<id>', async () => {
    const { w, run } = await setup(); await ask(w); const ch = w.challenges()[0]!;
    await run(lastJob(w).payload);
    expect(w.notif.calls).toHaveLength(1); const call = w.notif.calls[0]!; expect(call.method).toBe('sendSms'); expect(call.actor).toBe('system');
    expect(call.input).toMatchObject({ recipient: { kind: 'phone_otp', phoneE164: phoneN(1) }, purpose: 'otp', templateCode: 'engagement.login_otp', idempotencyKey: `otp:${ch['id']}` });
    expect(call.input['related']).toBeUndefined();
    const params = call.input['params'] as Record<string, string>; expect(Object.keys(params).sort()).toEqual(['lab_name', 'minutes', 'otp_code']);
    expect(params['otp_code']).toMatch(/^[0-9]{6}$/); expect(params['lab_name']).toBe(LAB_NAME); expect(params['minutes']).toBe('5');
    expect(JSON.stringify(call.input)).not.toMatch(/token|ciphertext|hmac/i);
  });
  it('the decrypted code is the one the challenge verifies against: HMAC(otp key, challenge_id:code) = stored code_hmac (code_hmac survives the send)', async () => {
    const { w, run } = await setup(); await ask(w); const ch = w.challenges()[0]!; await run(lastJob(w).payload);
    const code = (w.notif.calls[0]!.input['params'] as any).otp_code as string;
    expect(Buffer.from(w.challenge(ch['id'])['code_hmac']).equals(codeHmac(ch['id'], code))).toBe(true);
  });
  it('afterwards: code_ciphertext NULL, status sent, send_delivery_id = the port delivery; access log auth.otp_sent on otp_challenge; phone/hmac/token columns intact', async () => {
    const { w, run } = await setup(); await ask(w); const before = { ...w.challenges()[0]! }; await run(lastJob(w).payload);
    const c = w.challenge(before['id']); expect(c['code_ciphertext']).toBeNull(); expect(c['status']).toBe('sent'); expect(c['send_delivery_id']).toBe(w.notif.byKey.get(`otp:${before['id']}`));
    expect(Buffer.from(c['token_sha256']).equals(Buffer.from(before['token_sha256']))).toBe(true); expect(c['phone_e164']).toBe(phoneN(1)); expect(c['attempts']).toBe(0);
    expect(w.audit).toEqual([expect.objectContaining({ action: 'auth.otp_sent', entityType: 'otp_challenge', entityId: before['id'], outcome: 'success' })]);
  });
  it('redelivery of the same job after success is a quiet no-op: one SMS in total, no second audit row', async () => {
    const { w, run } = await setup(); await ask(w); await run(lastJob(w).payload);
    await expect(run(lastJob(w).payload)).resolves.toBeUndefined();
    expect(w.notif.calls).toHaveLength(1); expect(w.audit).toHaveLength(1);
  });
});

describe('supersession as the system actor (TRD §4.1 step 2)', () => {
  it('earlier pending/sent challenges of the SAME phone and app instance become superseded; other phones, other app instances, verified/failed rows stay; the new one is sent', async () => {
    const { w, run } = await setup();
    const sameP = w.seedChallenge({ phone_e164: phoneN(1), status: 'pending' }); const sameS = w.seedChallenge({ phone_e164: phoneN(1), status: 'sent' });
    const otherInst = w.seedChallenge({ phone_e164: phoneN(1), app_instance_id: APP_INSTANCE_2, status: 'pending' }); const otherPhone = w.seedChallenge({ phone_e164: phoneN(2), status: 'pending' });
    const verified = w.seedChallenge({ phone_e164: phoneN(1), status: 'verified' }); const failed = w.seedChallenge({ phone_e164: phoneN(1), status: 'failed' });
    await ask(w); const fresh = w.challenges().at(-1)!; await run(lastJob(w).payload);
    expect(w.challenge(sameP['id'])['status']).toBe('superseded'); expect(w.challenge(sameS['id'])['status']).toBe('superseded');
    expect(w.challenge(otherInst['id'])['status']).toBe('pending'); expect(w.challenge(otherPhone['id'])['status']).toBe('pending');
    expect(w.challenge(verified['id'])['status']).toBe('verified'); expect(w.challenge(failed['id'])['status']).toBe('failed');
    expect(w.challenge(fresh['id'])['status']).toBe('sent');
    expect(Buffer.from(fresh['phone_hmac']).equals(phoneHmac(TENANT_A, phoneN(1)))).toBe(true);
  });
  it('another tenant\'s challenge of the same phone is never touched (tenant-scoped statements)', async () => {
    const { w, run } = await setup(); const foreign = w.seedChallenge({ phone_e164: phoneN(1), status: 'pending', tenant_id: TENANT_B, phone_hmac: phoneHmac(TENANT_B, phoneN(1)) });
    await ask(w); await run(lastJob(w).payload);
    expect(w.challenge(foreign['id'])['status']).toBe('pending');
  });
});

describe('guards: nothing is sent for a challenge that is not live', () => {
  it.each([['superseded'], ['verified'], ['failed'], ['sent']])('status %s -> no SMS, no error, nothing changes', async (status) => {
    const { w, run } = await setup(); await ask(w); const id = w.challenges()[0]!['id']; w.challenge(id)['status'] = status;
    await expect(run(lastJob(w).payload)).resolves.toBeUndefined(); expect(w.notif.calls).toEqual([]); expect(w.challenge(id)['status']).toBe(status);
  });
  it('expired challenge (TTL 300 s passed) -> no SMS, no error', async () => {
    const { w, run } = await setup(); await ask(w); w.advance(301_000);
    await expect(run(lastJob(w).payload)).resolves.toBeUndefined(); expect(w.notif.calls).toEqual([]); expect(w.audit).toEqual([]);
  });
  it('unknown challenge id, malformed payload, and a challenge of another tenant -> no SMS (cross-tenant job cannot trigger a send)', async () => {
    const { w, run } = await setup(); const foreign = w.seedChallenge({ tenant_id: TENANT_B, phone_hmac: phoneHmac(TENANT_B, phoneN(1)), code_ciphertext: Buffer.alloc(40, 1), code_key_id: 'k-test-1' });
    for (const payload of [{ challenge_id: ID(0xdead) }, { challenge_id: foreign['id'] }, {}, { challenge_id: 'nope' }, { challenge_id: { $ne: null } }, null]) await rejection(run(payload));
    expect(w.notif.calls).toEqual([]); expect(w.challenge(foreign['id'])['status']).toBe('pending');
  });
});

describe('port outcomes', () => {
  it('C6 common.rate_limited -> challenge failed, no throw (the app\'s resend timer shows the generic message), no auth.otp_sent audit', async () => {
    const { w, run } = await setup(); await ask(w); w.notif.failNext = new LimsError('common.rate_limited');
    await expect(run(lastJob(w).payload)).resolves.toBeUndefined();
    expect(w.challenges()[0]!['status']).toBe('failed'); expect(w.audit).toEqual([]);
  });
  it('transient port error -> the task THROWS and the challenge rolls back to pending with its ciphertext; the retry sends with the SAME key and ends sent/NULL ciphertext', async () => {
    const { w, run } = await setup(); await ask(w); const id = w.challenges()[0]!['id']; w.notif.failNext = new Error('provider down');
    await expect(run(lastJob(w).payload)).rejects.toThrow();
    const c = w.challenge(id); expect(c['status']).toBe('pending'); expect(c['code_ciphertext']).not.toBeNull();
    await run(lastJob(w).payload);
    expect(w.notif.calls).toHaveLength(2); expect(w.notif.calls[1]!.input['idempotencyKey']).toBe(w.notif.calls[0]!.input['idempotencyKey']);
    expect(w.challenge(id)).toMatchObject({ status: 'sent', code_ciphertext: null });
    expect((w.notif.calls[1]!.input['params'] as any).otp_code).toBe((w.notif.calls[0]!.input['params'] as any).otp_code);   // same code both times
  });
  it('transient port error on the LAST attempt (attempt = maxAttempts = 3) -> no throw, challenge failed, code_ciphertext NULL (TRD §8.1: after 3 failures the challenge is failed)', async () => {
    const { w, run } = await setup(); await ask(w); const id = w.challenges()[0]!['id']; w.notif.failNext = new Error('provider down');
    await expect(run(lastJob(w).payload, { attempt: 3, maxAttempts: 3 })).resolves.toBeUndefined();
    expect(w.challenge(id)).toMatchObject({ status: 'failed', code_ciphertext: null }); expect(w.audit).toEqual([]);
  });
  it('transient port error on an EARLIER attempt (attempt 2 of 3) still throws and keeps the challenge pending with its ciphertext', async () => {
    const { w, run } = await setup(); await ask(w); const id = w.challenges()[0]!['id']; w.notif.failNext = new Error('provider down');
    await expect(run(lastJob(w).payload, { attempt: 2, maxAttempts: 3 })).rejects.toThrow();
    expect(w.challenge(id)['status']).toBe('pending'); expect(w.challenge(id)['code_ciphertext']).not.toBeNull();
  });
});

describe('log scan (US-EN-01.9; 02-CV §9.2)', () => {
  it('no phone number, OTP code, challenge material or ciphertext in logs/audit/metrics across send, no-op and failure paths', async () => {
    const { w, run } = await setup(); const r = await ask(w); await run(lastJob(w).payload);
    const code = (w.notif.calls[0]!.input['params'] as any).otp_code as string;
    await run(lastJob(w).payload); await ask(w, phoneN(2)); w.notif.failNext = new Error(`provider rejected ${phoneN(2)}`); await rejection(run(lastJob(w).payload));
    const seen = w.observed();
    for (const s of [phoneN(1), phoneN(2).replace('+', ''), r.body.challenge_token]) expect(seen).not.toContain(s);
    expect(seen).not.toContain(`"${code}"`); expect(seen).not.toMatch(new RegExp(`(?<![0-9])${code}(?![0-9])`));
    for (const c of w.challenges()) for (const col of ['token_sha256', 'code_hmac', 'phone_hmac']) expect(seen).not.toContain(Buffer.from(c[col]).toString('hex'));
  });
});
