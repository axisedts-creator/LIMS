// C16.T-A2 — E1 getPatientAppConfig + E2 requestPatientOtp (06-PLAN row T-A2; 02-TRD §4.1 step 1, §4.2, §5 E1/E2; 05-SCHEMA otp_challenges, number_counters, settings;
// PRD US-EN-01.1, .6, .7, .8, .9; 07-SECURITY E2 row "phone-existence oracle -> identical responses; SMS pumping -> prefix allowlist, per-phone/IP/tenant caps").
// done_when: challenge stored hashed/encrypted (code_hmac, phone_hmac 32-byte bytea); tenant daily cap. tests: 4th request -> 429; prefix rule; identical response shape with/without account;
//   daily-cap key otp_day:<yyyymmdd> accepted by number_counters__key__ck; log-scan for OTP/phone.
// Fails now: handlers/index.ts maps getPatientAppConfig / requestPatientOtp to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec fixes behaviour, not names; same convention as reminder.handlers.test.ts):
//   handlers[op](req:{params,query,headers,body}, ctx) -> {status, body, headers?}; ctx = pre-auth patient context {tenantId, actor{type:'patient'}, tx, now(), rateLimit, metrics, log, audit, ports{IdentityPort}}.
//   The pipeline owns schema validation / x-permission, but TRD §4.1 step 1 makes the handler validate phone_e164 + prefix itself, so it is tested here (junk never reaches the DB).
//   Rate limit: ctx.rateLimit.consume('otp_request', 'p:<phone_e164>') (core grammar; 3/hour). Daily cap: row (tenant_id, 'otp_day:<yyyymmdd>') of engagement.number_counters, yyyymmdd = TENANT business date
//   (settings timezone Asia/Kathmandu via IdentityPort.getTenantSettings), compared with settings.otp_daily_cap; written via INSERT .. ON CONFLICT .. DO UPDATE (or UPDATE) - the fake accepts both.
//   Token hash = sha256Bytes(<43-char challenge_token string>) (same convention as the queueDisplayToken resolver). Metrics via ctx.metrics.inc('lims_engagement_otp_requests_total',{outcome}) (TRD §13).
//   Job: SELECT app.enqueue_job('engagement.send_login_otp', payload, 'otp:<challenge_id>', ...) (TRD §8.1: job_key otp:<challenge_id>); payload must carry NO phone/code.
//   A throwing handler rolls the whole transaction back (core pipeline; E2 is not commitOnError): world.inTx emulates that.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { sha256Bytes } from '../../../../../../../packages/shared-ts/src/crypto/index.js';
import { APP_INSTANCE, APP_INSTANCE_2, COUNTER_KEY_CK, ID, OUTSIDE, TENANT_A, codeHmac, encKeys, makeOtpWorld, phoneHmac, phoneN, type OtpWorld } from '../../__tests__/otp.world.js';
import { handlers } from '../../handlers/index.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const HOUR = 3_600_000;
const body = (phone: string, over: Record<string, unknown> = {}) => ({ phone_e164: phone, app_instance_id: APP_INSTANCE, app_platform: 'android', ...over });
const request = (w: OtpWorld, b: unknown, over: Record<string, any> = {}) => w.inTx(() => (handlers as any).requestPatientOtp({ params: {}, query: {}, headers: {}, body: b }, w.preAuthCtx(over)));
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'RESOLVED'; };
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected a rejection'); };
const yyyymmdd = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)).replace(/-/g, '');
const shapeOf = (x: any): any => (Array.isArray(x) ? x.map(shapeOf) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, shapeOf(v)])) : typeof x === 'string' ? `string(${x.length})` : typeof x);

describe('contract sanity (the spec is the source of the permission, tier and idempotency)', () => {
  it('E1/E2: pre-auth permission, tiers, no idempotency key (08 A13 P-8 E2)', () => {
    expect(opOf('requestPatientOtp')).toMatchObject({ 'x-permission': 'engagement.auth.challenge', 'x-rate-limit-tier': 'otp_request', 'x-idempotency': 'none' });
    expect(opOf('getPatientAppConfig')).toMatchObject({ 'x-permission': 'engagement.auth.challenge', 'x-rate-limit-tier': 'general' });
  });
});

describe('E2 requestPatientOtp: the challenge (US-EN-01.1)', () => {
  it('202 {challenge_token(43), expires_at, resend_after_seconds 60, code_length 6}: exactly these keys, expires_at = now + 300 s', async () => {
    const w = makeOtpWorld(); const res = await request(w, body(phoneN(1)));
    expect(res.status).toBe(202);
    expect(Object.keys(res.body).sort()).toEqual(['challenge_token', 'code_length', 'expires_at', 'resend_after_seconds']);
    expect(res.body.challenge_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body).toMatchObject({ resend_after_seconds: 60, code_length: 6 });
    expect(Date.parse(res.body.expires_at)).toBe(Date.parse(w.now()) + 300_000);
  });
  it('one pending challenge row: tenant-bound, phone/instance/platform kept, attempts 0, TTL <= 600 s (04 A9), id = uuid', async () => {
    const w = makeOtpWorld(); await request(w, body(phoneN(1), { app_platform: 'ios', app_instance_id: APP_INSTANCE_2 }));
    expect(w.challenges()).toHaveLength(1); const c = w.challenges()[0]!;
    expect(c).toMatchObject({ tenant_id: TENANT_A, status: 'pending', phone_e164: phoneN(1), app_instance_id: APP_INSTANCE_2, app_platform: 'ios', attempts: 0 });
    expect(c['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);                       // uuidv7
    expect(Date.parse(c['expires_at']) - Date.parse(c['created_at'])).toBeLessThanOrEqual(600_000);
  });
  it('stored hashed/encrypted: token_sha256 = SHA-256(token); code_hmac / phone_hmac / token_sha256 are raw 32-byte Buffers (08 A5.5, never hex strings); phone_hmac = HMAC(phone key, tenant:phone)', async () => {
    const w = makeOtpWorld(); const res = await request(w, body(phoneN(1))); const c = w.challenges()[0]!;
    for (const col of ['token_sha256', 'code_hmac', 'phone_hmac']) { expect(c[col], col).toBeInstanceOf(Uint8Array); expect((c[col] as Uint8Array).length, col).toBe(32); }
    expect(Buffer.from(c['token_sha256']).equals(Buffer.from(sha256Bytes(res.body.challenge_token)))).toBe(true);
    expect(Buffer.from(c['phone_hmac']).equals(phoneHmac(TENANT_A, phoneN(1)))).toBe(true);
    expect(JSON.stringify(w.stmts)).not.toContain(res.body.challenge_token);                                            // the plaintext token never reaches SQL
  });
  it('the code is only stored as an AES-256-GCM ciphertext under the newest key (code_key_id) and decrypts to a 6-digit CSPRNG code whose HMAC is code_hmac', async () => {
    const w = makeOtpWorld(); await request(w, body(phoneN(1))); const c = w.challenges()[0]!;
    expect(c['code_ciphertext']).toBeInstanceOf(Uint8Array); expect((c['code_ciphertext'] as Uint8Array).length).toBeGreaterThanOrEqual(6 + 16);   // >= plaintext + GCM tag
    const keys = encKeys(); expect(Object.keys(keys)).toContain(c['code_key_id']);
    // layout of the ciphertext is the writer's choice; the contract is "decryptable with the named key and aad = challenge_id": try the usual iv(12)|ct|tag(16) layout.
    const buf = Buffer.from(c['code_ciphertext']); const key = Buffer.from(keys[c['code_key_id']]!, 'base64');
    const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12)); d.setAAD(Buffer.from(c['id'])); d.setAuthTag(buf.subarray(buf.length - 16));
    const plain = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
    expect(plain).toMatch(/^[0-9]{6}$/);
    expect(Buffer.from(c['code_hmac']).equals(codeHmac(c['id'], plain))).toBe(true);
  });
  it('enqueues exactly one engagement.send_login_otp, job_key otp:<challenge_id>; the payload holds no phone, code or token; earlier challenges are NOT touched here (supersession is the task, TRD §4.1 step 2)', async () => {
    const w = makeOtpWorld(); const old = w.seedChallenge({ phone_e164: phoneN(1) });
    const res = await request(w, body(phoneN(1)));
    const fresh = w.challenges().find((c) => c['id'] !== old['id'])!; const jobs = w.jobs('engagement.send_login_otp');
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ jobKey: `otp:${fresh['id']}`, payload: { challenge_id: fresh['id'] } });
    const raw = JSON.stringify(jobs[0]!.payload); expect(raw).not.toContain(phoneN(1)); expect(raw).not.toContain(res.body.challenge_token); expect(raw).not.toMatch(/ciphertext|otp_code|"code"/);
    expect(w.challenge(old['id'])['status']).toBe('pending');
    expect(w.notif.calls).toEqual([]);                                                                                   // the handler never sends: the task does
  });
  it('two requests -> two different tokens and ids (>= 128-bit tokens, 04 A10); every write binds the session tenant', async () => {
    const w = makeOtpWorld(); const a = await request(w, body(phoneN(1))); const b = await request(w, body(phoneN(2)));
    expect(a.body.challenge_token).not.toBe(b.body.challenge_token); expect(new Set(w.challenges().map((c) => c['id'])).size).toBe(2);
    for (const c of w.challenges()) expect(c['tenant_id']).toBe(TENANT_A);
  });
});

describe('E2 phone-existence oracle (US-EN-01.1 "byte-identical in shape", 07-SECURITY E2)', () => {
  it('a phone WITH an account and a phone WITHOUT one get the same status, headers, key set, value types/lengths and TTL; the handler never reads engagement.accounts', async () => {
    const w = makeOtpWorld(); w.seedAccount(phoneN(1));
    const known = await request(w, body(phoneN(1))); const unknown = await request(w, body(phoneN(2)));
    expect(shapeOf(known)).toEqual(shapeOf(unknown));
    expect(Date.parse(known.body.expires_at) - Date.parse(w.now())).toBe(Date.parse(unknown.body.expires_at) - Date.parse(w.now()));
    expect(w.touched(/engagement\.accounts/i)).toBe(false);
    const [c1, c2] = w.challenges(); expect(shapeOf({ ...c1, id: 0, phone_e164: 0, phone_hmac: 0, token_sha256: 0, code_hmac: 0, code_ciphertext: 0 })).toEqual(shapeOf({ ...c2, id: 0, phone_e164: 0, phone_hmac: 0, token_sha256: 0, code_hmac: 0, code_ciphertext: 0 }));
    expect(w.jobs('engagement.send_login_otp')).toHaveLength(2);                                                          // both are queued; the task decides nothing about accounts either
  });
});

describe('E2 phone validation + prefix rule (US-EN-01.7)', () => {
  it('a phone outside allowed_phone_prefixes -> 400 common.validation_failed at /phone_e164, no row, no job, no SMS, metric prefix_denied', async () => {
    const w = makeOtpWorld(); const e = await rejection(request(w, body(OUTSIDE)));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(e.errors?.map((x: any) => x.path)).toContain('/phone_e164');
    expect(w.challenges()).toEqual([]); expect(w.jobs()).toEqual([]); expect(w.notif.calls).toEqual([]);
    expect(w.metricCalls).toContainEqual({ name: 'lims_engagement_otp_requests_total', labels: { outcome: 'prefix_denied' } });
    expect(JSON.stringify(e)).not.toContain(OUTSIDE);                                                                     // never echo the number
  });
  it('textual prefix match against ANY listed prefix: +99 and +977 allowed -> +977... passes, +9779... passes, +9 prefix of a longer other prefix does not', async () => {
    const w = makeOtpWorld({ prefixes: ['+990', '+977'] });
    expect((await request(w, body('+97798000000'))).status).toBe(202); expect((await request(w, body(phoneN(5)))).status).toBe(202);
    expect(await code(request(w, body('+97698000000')))).toBe('common.validation_failed');
    expect(await code(request(w, body('+99198000000')))).toBe('common.validation_failed');                                 // '+991' does not start with '+990'
  });
  it.each([['no plus', '99012345678'], ['letters', '+99012345abc'], ['too short (7 digits)', '+9901234'], ['too long (16 digits)', '+9901234567890123'], ['leading zero country', '+0123456789'], ['empty', ''],
    ['spaces', '+990 1234 5678'], ['dashes', '+990-1234-5678'], ['trailing newline', `${phoneN(1)}\n`], ['sql-ish', "+990'; DROP TABLE x;--"], ['unicode digits', '+９９０12345678'], ['array', ['+99012345678']], ['number', 99012345678], ['null', null]])(
    'junk phone (%s) -> 400 common.validation_failed, zero writes, no limiter hit', async (_n, phone) => {
      const w = makeOtpWorld({ prefixes: ['+990', '+1'] }); const e = await rejection(request(w, body(phone as any)));
      expect(e.code).toBe('common.validation_failed'); expect(w.writes()).toEqual([]); expect(w.rateCalls).toEqual([]); expect(w.jobs()).toEqual([]);
    });
  it('app_instance_id must be a uuid and app_platform android|ios, unknown keys refused -> 400, zero writes', async () => {
    const w = makeOtpWorld();
    for (const b of [body(phoneN(1), { app_instance_id: 'not-a-uuid' }), body(phoneN(1), { app_platform: 'windows' }), { ...body(phoneN(1)), extra: 1 }, { phone_e164: phoneN(1) }, undefined, null, 'x'])
      expect(await code(request(w, b as any))).toBe('common.validation_failed');
    expect(w.writes()).toEqual([]);
  });
});

describe('E2 feature flag', () => {
  it('app_enabled = false -> 403 common.feature_disabled, nothing written, no limiter hit', async () => {
    const w = makeOtpWorld({ appEnabled: false }); const e = await rejection(request(w, body(phoneN(1))));
    expect(e.code).toBe('common.feature_disabled'); expect(w.writes()).toEqual([]); expect(w.jobs()).toEqual([]);
  });
});

describe('E2 per-phone rate limit (US-EN-01.6; 04 §4: 3 per hour, tier otp_request key p:<phone_e164>)', () => {
  it('3 requests pass, the 4th -> 429 common.rate_limited with Retry-After >= 1; only 3 challenges and 3 jobs exist; no SMS', async () => {
    const w = makeOtpWorld();
    for (let i = 0; i < 3; i++) { expect((await request(w, body(phoneN(1)))).status).toBe(202); w.advance(1000); }
    const e = await rejection(request(w, body(phoneN(1))));
    expect(e.code).toBe('common.rate_limited'); expect(e.statusCode).toBe(429); expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(w.challenges()).toHaveLength(3); expect(w.jobs('engagement.send_login_otp')).toHaveLength(3); expect(w.notif.calls).toEqual([]);
    expect(w.rateCalls.every((c) => c.tier === 'otp_request' && c.key === `p:${phoneN(1)}`)).toBe(true);
    expect(w.metricCalls).toContainEqual({ name: 'lims_engagement_otp_requests_total', labels: { outcome: 'rate_limited' } });
  });
  it('the limit is per phone: another phone is unaffected; after the hour the first phone may ask again', async () => {
    const w = makeOtpWorld();
    for (let i = 0; i < 3; i++) await request(w, body(phoneN(1)));
    expect(await code(request(w, body(phoneN(1))))).toBe('common.rate_limited');
    expect((await request(w, body(phoneN(2)))).status).toBe(202);
    w.advance(HOUR + 1000); expect((await request(w, body(phoneN(1)))).status).toBe(202);
  });
  it('an unchanged phone cannot dodge the limit by changing app_instance_id or the platform', async () => {
    const w = makeOtpWorld();
    for (let i = 0; i < 3; i++) await request(w, body(phoneN(1), { app_instance_id: ID(0xa00 + i) }));
    expect(await code(request(w, body(phoneN(1), { app_instance_id: ID(0xaff), app_platform: 'ios' })))).toBe('common.rate_limited');
  });
  it('accepted queued requests count as metric outcome queued', async () => {
    const w = makeOtpWorld(); await request(w, body(phoneN(1)));
    expect(w.metricCalls).toContainEqual({ name: 'lims_engagement_otp_requests_total', labels: { outcome: 'queued' } });
  });
});

describe('E2 tenant daily cap (US-EN-01.8; TRD §4.1: engagement.number_counters row otp_day:<yyyymmdd> of the TENANT business date)', () => {
  it('otp_daily_cap = 100: request 101 -> 429 common.rate_limited, no challenge/job for it, metric cap_reached; the counter row key is accepted by number_counters__key__ck', async () => {
    const w = makeOtpWorld({ dailyCap: 100 });
    for (let i = 1; i <= 100; i++) expect((await request(w, body(phoneN(i)))).status, `request ${i}`).toBe(202);
    const e = await rejection(request(w, body(phoneN(101))));
    expect(e.code).toBe('common.rate_limited'); expect(e.statusCode).toBe(429); expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(w.challenges()).toHaveLength(100); expect(w.jobs('engagement.send_login_otp')).toHaveLength(100);
    expect(w.metricCalls).toContainEqual({ name: 'lims_engagement_otp_requests_total', labels: { outcome: 'cap_reached' } });
    const row = w.t['counters']!.find((c) => String(c['counter_key']).startsWith('otp_day:'))!;
    expect(row['counter_key']).toBe(`otp_day:${yyyymmdd(w.now())}`); expect(row['counter_key']).toMatch(COUNTER_KEY_CK); expect(row).toMatchObject({ tenant_id: TENANT_A, last_value: 100 });
    expect(row['expires_at']).not.toBeNull(); expect(Date.parse(row['expires_at'])).toBeGreaterThan(Date.parse(w.now()));    // a rate key: purged after expiry (05-SCHEMA §2 number_counters)
  });
  it('the day key is the tenant business date (Asia/Kathmandu), not UTC: 2026-03-01T19:00Z is already 2026-03-02 in Kathmandu; the next business day starts a fresh counter', async () => {
    const w = makeOtpWorld({ dailyCap: 100 }); w.setNow('2026-03-01T19:00:00.000Z');
    await request(w, body(phoneN(1)));
    expect(w.t['counters']!.map((c) => c['counter_key'])).toEqual(['otp_day:20260302']);
    for (let i = 2; i <= 100; i++) await request(w, body(phoneN(i)));
    expect(await code(request(w, body(phoneN(200))))).toBe('common.rate_limited');
    w.setNow('2026-03-02T19:00:00.000Z');                                                                                   // 2026-03-03 00:45 in Kathmandu
    expect((await request(w, body(phoneN(300)))).status).toBe(202);
    expect(w.t['counters']!.map((c) => c['counter_key']).sort()).toEqual(['otp_day:20260302', 'otp_day:20260303']);
  });
  it('requests refused for prefix or per-phone limit do not burn the tenant cap (rolled back / never counted)', async () => {
    const w = makeOtpWorld({ dailyCap: 100 });
    await code(request(w, body(OUTSIDE)));
    for (let i = 0; i < 3; i++) await request(w, body(phoneN(1)));
    await code(request(w, body(phoneN(1))));                                                                                // 4th: 429
    const row = w.t['counters']!.find((c) => String(c['counter_key']).startsWith('otp_day:'))!; expect(row['last_value']).toBe(3);
  });
  it('the counter belongs to the session tenant only (RLS WITH CHECK tenant_id = session tenant)', async () => {
    const w = makeOtpWorld({ dailyCap: 100 }); await request(w, body(phoneN(1)));
    for (const c of w.t['counters']!) expect(c['tenant_id']).toBe(TENANT_A);
  });
});

describe('E2 log scan (US-EN-01.9; 02-CV §9.2)', () => {
  it('no phone number, challenge token, token hash, code HMAC or ciphertext appears in logs, audit rows or metric labels - on success, 400, 429 and cap paths', async () => {
    const w = makeOtpWorld({ dailyCap: 100 }); const secrets: string[] = [];
    for (let i = 1; i <= 3; i++) { const r = await request(w, body(phoneN(1))); secrets.push(r.body.challenge_token); }
    await code(request(w, body(phoneN(1)))); await code(request(w, body(OUTSIDE))); await code(request(w, body('+990abc')));
    const seen = w.observed(); const digits = (p: string) => p.replace('+', '');
    for (const p of [phoneN(1), OUTSIDE]) { expect(seen, p).not.toContain(p); expect(seen, p).not.toContain(digits(p)); }
    for (const s of secrets) expect(seen).not.toContain(s);
    for (const c of w.challenges()) for (const col of ['token_sha256', 'code_hmac', 'phone_hmac', 'code_ciphertext']) for (const enc of ['hex', 'base64', 'base64url'] as const) expect(seen).not.toContain(Buffer.from(c[col]).toString(enc));
    expect(seen).not.toMatch(/Bearer |eyJ[A-Za-z0-9_-]{10,}\./);                                                          // no JWT
  });
});

describe('E1 getPatientAppConfig (TRD §5 E1; tenant from the pre-auth credential only)', () => {
  const config = (w: OtpWorld, over: Record<string, any> = {}) => w.inTx(() => (handlers as any).getPatientAppConfig({ params: {}, query: {}, headers: {}, body: undefined }, w.preAuthCtx(over)));
  it('200 AppConfig: schema-valid, mirrors the tenant settings (features, min_app_version, allowed_phone_prefixes, calendar_display, timezone, order_poll_seconds); no tenant_id, lab name or secret', async () => {
    const w = makeOtpWorld({ prefixes: ['+990', '+977'] }); const res = await config(w);
    expect(res.status).toBe(200); expect(schemaErrors('AppConfig', res.body)).toEqual([]);
    expect(res.body.features).toMatchObject({ app: true, bookings: true, home_collection: false, membership: false, enquiries: false, smart_report: true });
    expect(res.body.min_app_version).toEqual({ android: '1.2.3', ios: '1.2.4' });
    expect(res.body.allowed_phone_prefixes).toEqual(['+990', '+977']);
    expect(res.body).toMatchObject({ calendar_display: 'AD_BS', timezone: 'Asia/Kathmandu', order_poll_seconds: 30 });
    const raw = JSON.stringify(res.body); expect(raw).not.toContain(TENANT_A); expect(raw).not.toContain('Synthetic Lab'); expect(res.body).not.toHaveProperty('lab_display_name');
  });
  it('reads patient-visible tenant settings only: getTenantSettings keys are a subset of {timezone, calendarDisplay} (08 A19 D-119)', async () => {
    const w = makeOtpWorld(); await config(w);
    expect(w.identity.settingsKeys.length).toBeGreaterThan(0);
    for (const keys of w.identity.settingsKeys) for (const k of keys) expect(['timezone', 'calendarDisplay']).toContain(k);
  });
  it('is read-only: no write, no job, no limiter use beyond the general tier', async () => {
    const w = makeOtpWorld(); await config(w); expect(w.writes()).toEqual([]); expect(w.jobs()).toEqual([]); expect(w.notif.calls).toEqual([]);
  });
  it('app switched off -> features.app = false is still reported (the app must show "not available"), never a stale true', async () => {
    const w = makeOtpWorld({ appEnabled: false }); const res = await config(w); expect(res.status).toBe(200); expect(res.body.features.app).toBe(false);
  });
});
