// C16.T-A3 - E3 verifyPatientOtp + accounts + IdentityPort provisioning/session (06-PLAN row T-A3; 02-TRD §4.1 step 3, §4.2, §6.2 "provisionPatientMembership / openPatientSession" row,
// §9.4 audit row auth.otp_failure; 05-SCHEMA otp_challenges, accounts + PRE_ACC; PRD US-EN-01.3 / .4 / .5; 07-SECURITY E3 row, REQ-SEC-074; 08 A19 P-42; CR-C16-004).
// done_when: PRE_ACC insert works only for the verified phone (needs the CR-C16-004 C2 fake: packages/fakes IdentityPort.fake.ts, used here for real).
// Fails now: handlers/index.ts maps verifyPatientOtp to the T-01 placeholder (common.service_unavailable); auth.service has no verify.
//
// SEAMS (spec fixes behaviour, not names; same convention as auth.handlers.test.ts):
//   handlers.verifyPatientOtp({params,query,headers,body:{code}}, ctx) -> {status:200, body, headers:{cache-control:no-store}}; ctx = world.verifyCtx(token, challengeId): actor {type:'patient', id: challenge_id},
//   claims {patient_stage:'pre_auth', otp_token_sha256: <lowercase hex of sha256(token)>} (resolver output, TRD §4.2). The challenge is read/written through ctx.tx only
//   (the world emulates RLS PRE_TOK on otp_challenges and PRE_ACC on accounts, so a service that reads the wrong rows fails, not the fake).
//   Rate limit: ctx.rateLimit.consume('otp_verify', 'o:<challenge_id>') (04 §4: 5 per OTP). commitOnError: ctx.commitOnError() (08 A19 P-42) - the world keeps the writes of a throwing handler only when it was called.
//   Port errors: ctx.ports.IdentityPort = the REAL C2 fake (createFakeIdentityPort) wrapped to keep E1's getTenantSettings; failNext('openPatientSession', code) injects a C2 failure.
//   SQL the service writes must stay inside the world's grammar (plain AND-of-predicates WHERE, INSERT (cols) VALUES (...), UPDATE .. SET col = $n | now() | col + n).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { sha256Bytes } from '../../../../../../../packages/shared-ts/src/crypto/index.js';
import { createFakeIdentityPort } from '../../../../../../../packages/fakes/src/IdentityPort.fake';
import { APP_INSTANCE, ID, T0, codeHmac, makeOtpWorld, phoneHmac, phoneN, type OtpWorld } from '../../__tests__/otp.world.js';
import { handlers } from '../../handlers/index.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const CODE = '123456', WRONG = '654321';
const PHONE = phoneN(1), OTHER_PHONE = phoneN(2);
const tokenOf = (n: number) => `tok${String(n).padStart(40, '0')}`; // 43 chars, base64url alphabet
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected a rejection'); };

interface Fx { w: OtpWorld; c2: ReturnType<typeof createFakeIdentityPort>; id: string; token: string; ctx: () => any; verify: (code?: string, over?: Record<string, any>) => Promise<any> }
/** One tenant-A world with one `sent` challenge (code 123456, TTL 300 s) and the real C2 fake behind IdentityPort. */
function setup(o: { phone?: string; status?: string; n?: number; w?: OtpWorld; c2?: Fx['c2'] } = {}): Fx {
  const w = o.w ?? makeOtpWorld(); const c2 = o.c2 ?? createFakeIdentityPort({ seed: 7 });
  const id = w.newId(); const token = tokenOf(o.n ?? 1); const phone = o.phone ?? PHONE;
  w.seedChallenge({ id, token_sha256: sha256Bytes(token), phone_e164: phone, phone_hmac: phoneHmac(w.tenantId, phone), code_hmac: codeHmac(id, CODE), status: o.status ?? 'sent' });
  const ports = { ...w.ports, IdentityPort: { getTenantSettings: w.identity.getTenantSettings, provisionPatientMembership: (c: any, i: any) => (c2 as any).provisionPatientMembership(c, i), openPatientSession: (c: any, i: any) => (c2 as any).openPatientSession(c, i) } };
  const ctx = () => w.verifyCtx(token, id, { ports });
  const verify = (code: string = CODE, over: Record<string, any> = {}) => w.inTx(() => (handlers as any).verifyPatientOtp({ params: {}, query: {}, headers: {}, body: { code }, ...over }, ctx()));
  return { w, c2, id, token, ctx, verify };
}
const patientCtx = (w: OtpWorld) => w.preAuthCtx(); // for direct C2 calls in assertions (actor.type patient)
const failures = (w: OtpWorld) => w.audit.filter((a) => a['action'] === 'auth.otp_failure');

describe('contract sanity (the spec is the source of the permission, tier and idempotency)', () => {
  it('E3: pre-auth challenge permission, otp_verify tier, no idempotency (08 A13 P-8)', () => {
    expect(opOf('verifyPatientOtp')).toMatchObject({ 'x-permission': 'engagement.auth.challenge', 'x-rate-limit-tier': 'otp_verify', 'x-idempotency': 'none' });
  });
});

describe('US-EN-01.3 correct code -> session', () => {
  it('200 {session_token, access_token, access_expires_at, session_expires_at, account}, Cache-Control: no-store; challenge becomes verified and consumed', async () => {
    const f = setup(); const r = await f.verify();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['access_expires_at', 'access_token', 'account', 'session_expires_at', 'session_token']);
    expect(r.headers?.['cache-control'] ?? r.headers?.['Cache-Control']).toBe('no-store');
    const opened = f.c2.calls('openPatientSession');
    expect(opened).toHaveLength(1);
    expect(r.body.session_token).toMatch(/^fake-session-/); expect(r.body.access_token).toMatch(/^fake-access-/); // passed through from C2 unchanged (the fake's tokens are not 43 chars: C2 fake gap, see notes)
    expect(r.body.access_expires_at).toBe(new Date(Date.parse(T0) + 15 * 60_000).toISOString());
    expect(r.body.session_expires_at).toBe(new Date(Date.parse(T0) + 30 * 86_400_000).toISOString());
    expect(opened[0]!.input).toMatchObject({ appInstanceId: APP_INSTANCE, appPlatform: 'android' });
    const ch = f.w.challenge(f.id);
    expect(ch['status']).toBe('verified'); expect(ch['consumed_at']).not.toBeNull(); expect(ch['attempts']).toBe(1);
  });

  it('first sign-in inserts the account with id = challenge id (deterministic retry id) for exactly the verified phone, with C2 ids and last_login_at / last_app_platform', async () => {
    const f = setup(); const r = await f.verify();
    expect(f.w.accounts()).toHaveLength(1);
    const a = f.w.accounts()[0]!;
    expect(a['id']).toBe(f.id); expect(r.body.account.id).toBe(f.id);
    expect(a).toMatchObject({ tenant_id: f.w.tenantId, phone_e164: PHONE, status: 'active', reminders_opt_out: false, last_app_platform: 'android' });
    expect(Buffer.from(a['phone_hmac']).equals(phoneHmac(f.w.tenantId, PHONE))).toBe(true);
    expect(Date.parse(a['last_login_at'])).toBe(Date.parse(T0));
    expect(a['created_by']).toBeTruthy(); expect(a['updated_by']).toBeTruthy();
    const prov = f.c2.calls('provisionPatientMembership');
    expect(prov).toHaveLength(1); expect(prov[0]!.input).toEqual({ accountId: f.id });
    expect(opened(f).input.membershipId).toBe(a['membership_id']); expect(a['membership_id']).toBeTruthy(); expect(a['user_id']).toBeTruthy();
  });

  it('Account wire shape: schema-valid, phone masked (never the full number), no internal columns', async () => {
    const f = setup(); const r = await f.verify();
    expect(schemaErrors('Account', r.body.account)).toEqual([]);
    expect(r.body.account.phone_masked).not.toContain(PHONE); expect(r.body.account.phone_masked).not.toBe(PHONE);
    expect(JSON.stringify(r.body.account)).not.toContain(PHONE.slice(1));
    for (const k of ['phone_e164', 'phone_hmac', 'membership_id', 'user_id', 'tenant_id', 'created_by']) expect(r.body.account).not.toHaveProperty(k);
  });

  it('also accepts a challenge still `pending` (the send task has not marked it `sent` yet)', async () => {
    const f = setup({ status: 'pending' }); expect((await f.verify()).status).toBe(200);
    expect(f.w.challenge(f.id)['status']).toBe('verified');
  });

  it('works right up to expiry (expires_at - 1 s)', async () => {
    const f = setup(); f.w.advance(299_000); expect((await f.verify()).status).toBe(200);
  });

  it('existing account (same phone, membership already provisioned): reused - no second account, no second provisioning, session for the stored membership, last_login_at refreshed', async () => {
    const w = makeOtpWorld(); const c2 = createFakeIdentityPort({ seed: 7 });
    const accId = w.newId(); const m = await (c2 as any).provisionPatientMembership(patientCtx(w), { accountId: accId });
    const acc = w.seedAccount(PHONE, { id: accId, membership_id: m.membershipId, user_id: m.userId, last_login_at: '2026-01-01T00:00:00.000Z' });
    const f = setup({ w, c2 }); w.advance(60_000);
    const r = await f.verify();
    expect(r.status).toBe(200); expect(r.body.account.id).toBe(acc['id']);
    expect(w.accounts()).toHaveLength(1);
    expect(c2.calls('provisionPatientMembership')).toHaveLength(1);                        // the seeding call only
    expect(c2.calls('openPatientSession')[0]!.input).toMatchObject({ membershipId: m.membershipId });
    expect(Date.parse(w.account(accId)!['last_login_at'])).toBe(Date.parse(T0) + 60_000);
    expect(w.account(accId)!['id']).not.toBe(f.id);                                       // the challenge id is used only for NEW accounts
  });

  it('existing account without membership yet (a half-created account): provisioned for THAT account id, not the challenge id', async () => {
    const w = makeOtpWorld(); const acc = w.seedAccount(PHONE); const f = setup({ w });
    const r = await f.verify();
    expect(r.status).toBe(200); expect(w.accounts()).toHaveLength(1);
    expect(f.c2.calls('provisionPatientMembership')[0]!.input).toEqual({ accountId: acc['id'] });
    expect(w.account(acc['id'])!['membership_id']).toBeTruthy();
  });

  it('a `deleted` account of the same phone is NOT reused: a new account (id = challenge id) is created (06-PLAN T-AC1: re-sign-in -> new account)', async () => {
    const w = makeOtpWorld();
    const old = w.seedAccount(PHONE, { status: 'deleted', phone_e164: null, phone_hmac: null, deleted_at: '2026-02-01T00:00:00.000Z' });
    const f = setup({ w }); const r = await f.verify();
    expect(r.status).toBe(200); expect(w.accounts()).toHaveLength(2);
    expect(r.body.account.id).toBe(f.id); expect(r.body.account.id).not.toBe(old['id']);
    expect(w.account(old['id'])).toMatchObject({ status: 'deleted', phone_e164: null });
  });

  it('other accounts are untouched; the verify writes only otp_challenges + accounts', async () => {
    const w = makeOtpWorld(); const other = w.seedAccount(OTHER_PHONE, { last_login_at: null });
    const snap = JSON.stringify(other); const f = setup({ w }); await f.verify();
    expect(JSON.stringify(w.account(other['id']))).toBe(snap);
    const tables = new Set(w.writes().map((s) => /(?:insert into|update|delete from)\s+([\w.]+)/i.exec(s.text.replace(/\s+/g, ' '))?.[1]));
    expect([...tables].sort()).toEqual(['engagement.accounts', 'engagement.otp_challenges']);
  });

  it('nothing secret is logged, audited or labelled: no code, phone, challenge token, session/access token', async () => {
    const f = setup(); const r = await f.verify(); const seen = w_obs(f.w);
    for (const secret of [CODE, PHONE, PHONE.slice(1), f.token, r.body.session_token, r.body.access_token]) expect(seen).not.toContain(secret);
  });
});

describe('US-EN-01.4 wrong codes -> 5th is exhausted (commitOnError)', () => {
  it('5 wrong codes: 401 auth.otp_invalid x4 then 401 auth.otp_attempts_exhausted; after EACH 401 attempts and one auth.otp_failure access-log row persist; status failed only after the 5th', async () => {
    const f = setup();
    for (let i = 1; i <= 5; i++) {
      const e = await rejection(f.verify(WRONG));
      expect(e.code).toBe(i < 5 ? 'auth.otp_invalid' : 'auth.otp_attempts_exhausted'); expect(e.statusCode).toBe(401);
      const ch = f.w.challenge(f.id);
      expect(ch['attempts']).toBe(i);                                                    // persisted although the request failed (P-42)
      expect(ch['status']).toBe(i < 5 ? 'sent' : 'failed');
      expect(failures(f.w)).toHaveLength(i);
      expect(f.w.commit.calls).toBe(i);                                                  // ctx.commitOnError() on every mismatch
    }
    for (const row of failures(f.w)) expect(row).toMatchObject({ action: 'auth.otp_failure', entityType: 'otp_challenge', entityId: f.id, outcome: 'denied' });
    expect(f.w.accounts()).toHaveLength(0);
    expect(f.c2.calls('provisionPatientMembership')).toHaveLength(0); expect(f.c2.calls('openPatientSession')).toHaveLength(0);
    expect(f.w.challenge(f.id)['verified_at']).toBeNull(); expect(f.w.challenge(f.id)['consumed_at']).toBeNull();
  });

  it('a 6th attempt with the CORRECT code also fails and opens no session; the challenge stays failed with attempts = 5', async () => {
    const f = setup(); for (let i = 0; i < 5; i++) await rejection(f.verify(WRONG));
    const e = await rejection(f.verify(CODE));
    expect(['auth.otp_invalid', 'auth.otp_attempts_exhausted', 'common.rate_limited']).toContain(e.code);
    expect(f.c2.calls('openPatientSession')).toHaveLength(0); expect(f.w.accounts()).toHaveLength(0);
    expect(f.w.challenge(f.id)).toMatchObject({ status: 'failed', attempts: 5 });
  });

  it('a correct code after 2 wrong ones still succeeds (attempts do not lock earlier)', async () => {
    const f = setup(); await rejection(f.verify(WRONG)); await rejection(f.verify(WRONG));
    expect((await f.verify(CODE)).status).toBe(200);
    expect(f.w.challenge(f.id)).toMatchObject({ status: 'verified', attempts: 3 });
  });

  it('burning one victim challenge kills only that challenge; the same phone`s NEXT challenge verifies normally (lock-out by burning attempts, 07-SECURITY E3)', async () => {
    const f = setup({ n: 1 }); for (let i = 0; i < 5; i++) await rejection(f.verify(WRONG));
    const g = setup({ w: f.w, c2: f.c2, n: 2 });
    expect((await g.verify()).status).toBe(200); expect(f.w.challenge(f.id)['status']).toBe('failed');
  });

  it('the rate limiter is consulted per challenge: tier otp_verify, key o:<challenge_id> (04 §4)', async () => {
    const f = setup(); await rejection(f.verify(WRONG));
    expect(f.w.rateCalls).toContainEqual({ tier: 'otp_verify', key: `o:${f.id}` });
  });

  it('malformed code (not 6 digits) -> 400 validation, never a wrong-attempt and never a DB write', async () => {
    const f = setup();
    for (const bad of ['12345', '1234567', 'abcdef', '12 456', '', '١٢٣٤٥٦']) {
      const e = await rejection(f.verify(bad));
      expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e)).not.toContain(bad || 'zzzz');
    }
    expect(f.w.writes()).toHaveLength(0); expect(f.w.challenge(f.id)['attempts']).toBe(0);
  });

  it('the compare is constant-time: source uses crypto.timingSafeEqual on the 32-byte HMACs and never === / Buffer.equals on code_hmac (08 A5.5)', () => {
    const src = readFileSync(join(REPO_ROOT, 'services/api/src/modules/engagement/service/auth.service.ts'), 'utf8');
    expect(src).toMatch(/timingSafeEqual/);
    expect(src).not.toMatch(/code_hmac['"\]]*\s*(===|!==)/);
  });
});

describe('US-EN-01.5 expired / replayed / unusable challenge -> auth.otp_invalid with no write', () => {
  const expectNoWrite = (f: Fx, before: number) => {
    expect(f.w.writes().length).toBe(before); expect(f.w.audit).toHaveLength(0);
    expect(f.c2.calls('provisionPatientMembership')).toHaveLength(0); expect(f.c2.calls('openPatientSession')).toHaveLength(0); expect(f.w.accounts()).toHaveLength(0);
  };
  it('expired challenge + CORRECT code -> 401 auth.otp_invalid, nothing written (attempts unchanged)', async () => {
    const f = setup(); f.w.advance(301_000); const before = f.w.writes().length;
    const e = await rejection(f.verify(CODE));
    expect(e.code).toBe('auth.otp_invalid'); expect(e.statusCode).toBe(401);
    expectNoWrite(f, before); expect(f.w.challenge(f.id)).toMatchObject({ status: 'sent', attempts: 0 });
  });
  it('expired + WRONG code answers the same auth.otp_invalid (no expiry oracle) and still writes nothing', async () => {
    const f = setup(); f.w.advance(24 * 3_600_000); const before = f.w.writes().length;
    expect((await rejection(f.verify(WRONG))).code).toBe('auth.otp_invalid'); expectNoWrite(f, before);
  });
  it('replay of a verified challenge (same code, right after success) -> auth.otp_invalid; no second session, no extra write, account unchanged', async () => {
    const f = setup(); await f.verify();
    const acc = JSON.stringify(f.w.accounts()); const writes = f.w.writes().length;
    const e = await rejection(f.verify(CODE));
    expect(e.code).toBe('auth.otp_invalid'); expect(f.c2.calls('openPatientSession')).toHaveLength(1);
    expect(f.w.writes().length).toBe(writes); expect(JSON.stringify(f.w.accounts())).toBe(acc); expect(failures(f.w)).toHaveLength(0);
  });
  it.each(['verified', 'failed', 'superseded'])('status %s + correct code -> auth.otp_invalid, attempts unchanged, no session', async (status) => {
    const f = setup({ status }); const before = f.w.writes().length;
    expect((await rejection(f.verify(CODE))).code).toBe('auth.otp_invalid');
    expectNoWrite(f, before); expect(f.w.challenge(f.id)['attempts']).toBe(0);
  });
  it('credential resolves to no visible challenge row (purged between resolve and verify): 401 auth.otp_invalid, not a 500, no write', async () => {
    const f = setup(); f.w.challenges().length = 0; const before = f.w.writes().length;
    const e = await rejection(f.verify(CODE)); expect(e.code).toBe('auth.otp_invalid'); expect(f.w.writes().length).toBe(before);
  });
});

describe('C2 failure after a correct code -> 500, rollback, retry with the same code (TRD §4.1 step 3, §6.2; review C16 #9)', () => {
  it.each([['openPatientSession', 'common.dependency_unavailable'], ['openPatientSession', 'identity.membership_inactive'], ['provisionPatientMembership', 'common.dependency_unavailable']] as const)(
    '%s fails with %s -> 500 common.internal; challenge status/attempts unchanged, no account row, no auth.otp_failure row, commitOnError not used', async (method, c2code) => {
      const f = setup(); (f.c2 as any).failNext(method, c2code);
      const e = await rejection(f.verify(CODE));
      expect(e.code).toBe('common.internal'); expect(e.statusCode).toBe(500);
      expect(f.w.challenge(f.id)).toMatchObject({ status: 'sent', attempts: 0, verified_at: null, consumed_at: null });
      expect(f.w.accounts()).toHaveLength(0); expect(failures(f.w)).toHaveLength(0); expect(f.w.commit.calls).toBe(0);
    });
  it('a non-LimsError from C2 (network) is also 500 common.internal, with no detail echoed', async () => {
    const f = setup(); const base = f.ctx;
    const boom = () => { const c = base(); c.ports.IdentityPort.openPatientSession = async () => { throw new Error('socket hang up 10.0.0.7:5432'); }; return c; };
    const e = await rejection(f.w.inTx(() => (handlers as any).verifyPatientOtp({ params: {}, query: {}, headers: {}, body: { code: CODE } }, boom())));
    expect(e.code).toBe('common.internal'); expect(e.statusCode).toBe(500); expect(JSON.stringify(e)).not.toContain('10.0.0.7');
    expect(f.w.challenge(f.id)).toMatchObject({ status: 'sent', attempts: 0 });
  });
  it('retry with the SAME code succeeds and reuses the same account id (= challenge id) and the same C2 membership (no orphan GoTrue user)', async () => {
    const f = setup(); (f.c2 as any).failNext('openPatientSession', 'common.dependency_unavailable');
    await rejection(f.verify(CODE));                                                     // provisionPatientMembership already succeeded inside C2 (not rolled back)
    const r = await f.verify(CODE);
    expect(r.status).toBe(200); expect(r.body.account.id).toBe(f.id); expect(f.w.accounts()).toHaveLength(1);
    const prov = f.c2.calls('provisionPatientMembership'); expect(prov).toHaveLength(2);
    expect(prov.map((c) => (c.input as any).accountId)).toEqual([f.id, f.id]);
    const again = await (f.c2 as any).provisionPatientMembership(patientCtx(f.w), { accountId: f.id });
    expect(f.w.account(f.id)!['membership_id']).toBe(again.membershipId);               // one C2 membership for this account id
    expect(f.w.challenge(f.id)).toMatchObject({ status: 'verified', attempts: 1 });
  });
  it('a wrong code between the failure and the retry still counts normally (attempts 0 -> 1) and the correct retry then succeeds', async () => {
    const f = setup(); (f.c2 as any).failNext('openPatientSession', 'common.dependency_unavailable');
    await rejection(f.verify(CODE)); await rejection(f.verify(WRONG));
    expect(f.w.challenge(f.id)['attempts']).toBe(1); expect((await f.verify(CODE)).status).toBe(200);
  });
});

describe('pre-auth claims cannot reach another phone\'s account (PRE_ACC; SQL probe, 05-SCHEMA §5.2, 07-SECURITY E3)', () => {
  const probe = (f: Fx, sql: string, v: unknown[] = []) => f.ctx().tx.query(sql, v);
  it('before verification the caller sees NO account at all - not its own phone\'s, not another phone\'s', async () => {
    const w = makeOtpWorld(); w.seedAccount(PHONE); w.seedAccount(OTHER_PHONE); const f = setup({ w });
    expect((await probe(f, 'SELECT id FROM engagement.accounts WHERE phone_e164 = $1', [OTHER_PHONE])).rows).toHaveLength(0);
    expect((await probe(f, 'SELECT id FROM engagement.accounts WHERE phone_e164 = $1', [PHONE])).rows).toHaveLength(0);
    expect((await probe(f, 'SELECT id FROM engagement.accounts')).rows).toHaveLength(0);
  });
  it('after the challenge is verified only the verified phone\'s account is visible; INSERT / UPDATE for another phone is refused (42501 / 0 rows)', async () => {
    const w = makeOtpWorld(); const mine = w.seedAccount(PHONE); const theirs = w.seedAccount(OTHER_PHONE); const f = setup({ w, status: 'verified' });
    expect((await probe(f, 'SELECT id FROM engagement.accounts')).rows.map((r: any) => r.id)).toEqual([mine['id']]);
    const e = await rejection(probe(f, 'INSERT INTO engagement.accounts (id, tenant_id, phone_e164, phone_hmac, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)', [w.newId(), w.tenantId, phoneN(3), phoneHmac(w.tenantId, phoneN(3)), f.id]));
    expect(e.code).toBe('42501');
    expect((await probe(f, 'UPDATE engagement.accounts SET reminders_opt_out = true WHERE id = $1', [theirs['id']])).rowCount).toBe(0);
    expect(w.account(theirs['id'])!['reminders_opt_out']).toBe(false);
  });
  it('verify for phone A while an account of phone B exists: B\'s account is neither returned, reused, nor modified; a NEW account is created for A', async () => {
    const w = makeOtpWorld(); const b = w.seedAccount(OTHER_PHONE, { last_login_at: '2026-01-01T00:00:00.000Z' }); const before = JSON.stringify(b);
    const f = setup({ w }); const r = await f.verify();
    expect(r.body.account.id).toBe(f.id); expect(r.body.account.id).not.toBe(b['id']);
    expect(JSON.stringify(w.account(b['id']))).toBe(before); expect(w.accounts()).toHaveLength(2);
    expect(f.c2.calls('provisionPatientMembership').map((c) => (c.input as any).accountId)).toEqual([f.id]);
  });
  it('the account is inserted only AFTER the challenge is verified (PRE_ACC WITH CHECK): no accounts INSERT is issued before the challenge UPDATE to verified', async () => {
    const f = setup(); await f.verify();
    const kinds = f.w.writes().map((s) => (/otp_challenges/i.test(s.text) ? 'challenge' : 'account') + ':' + s.text.trim().split(/\s+/)[0]!.toLowerCase());
    expect(kinds.indexOf('challenge:update')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('account:insert')).toBeGreaterThan(kinds.indexOf('challenge:update'));
  });
});

/** Everything an operator or attacker could read back (logs + audit + metric labels). */
function w_obs(w: OtpWorld) { return w.observed(); }
function opened(f: Fx) { return f.c2.calls('openPatientSession')[0]!; }
