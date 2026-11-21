// SEC-ABUSE-1 (LD-237; audit 6.1): changeOwnPassword and confirmEmailToken declare x-rate-limit-tier: login (contracts/openapi/identity.yaml)
// but never consumed it. They now consume ctx.rateLimit.consume('login', key) BEFORE any GoTrue call, like the other login-tier handlers,
// and fail closed (no limiter -> common.dependency_unavailable; limiter says no -> that error, GoTrue untouched).
// Key text is the writer's choice (the limiter HMACs it); the tests pin tier, order, one consume per request and fail-closed.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { LimsError } from '../../../../core/errors.js';
import { makeWorld as recoveryWorld, rejection as recRejection } from './recovery.helpers.js';
import { createConfirmEmailToken } from '../confirmEmailToken.js';
import { NEW_PW, OLD_PW, makeWorld as selfWorld, rejection, type Who } from '../../service/__tests__/self.helpers.js';
import { createSelfService } from '../../service/self.service.js';

const limited = () => Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: 42 });

describe('confirmEmailToken consumes the login tier', () => {
  const setup = async () => {
    const w = await recoveryWorld(); const u = await w.addUser(); await w.gw.sendRecovery(u.email, '/auth/confirm');
    const hash = w.fake!.mailbox.latestTokenHash(u.email, 'recovery')!;
    return { w, hash, h: createConfirmEmailToken(w.deps as any) as any };
  };
  it('consumes exactly one login-tier key, before GoTrue verifyEmailToken', async () => {
    const { w, hash, h } = await setup(); const order: string[] = [];
    const consume = vi.fn(async (tier: string, key: string) => { order.push(`consume:${tier}`); void key; });
    const orig = w.fake!.verifyEmailToken.bind(w.fake); (w.fake as any).verifyEmailToken = (...a: any[]) => { order.push('verifyEmailToken'); return (orig as any)(...a); };
    const r = await w.call(h, { body: { token_hash: hash, type: 'recovery' } }, { rateLimit: { consume } });
    expect(r.status).toBe(200);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]![0]).toBe('login'); expect(typeof consume.mock.calls[0]![1]).toBe('string'); expect(consume.mock.calls[0]![1].length).toBeGreaterThan(2);
    expect(order.indexOf('consume:login')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('consume:login')).toBeLessThan(order.indexOf('verifyEmailToken'));
  });
  it('the key does not carry the token (a link token is a secret) and differs between two client IPs', async () => {
    const { w, hash, h } = await setup(); const keys: string[] = [];
    const consume = async (_t: string, k: string) => { keys.push(k); };
    await w.call(h, { body: { token_hash: hash, type: 'recovery' } }, { rateLimit: { consume }, clientIp: '203.0.113.9' });
    await w.call(h, { body: { token_hash: 'x'.repeat(20), type: 'recovery' } }, { rateLimit: { consume }, clientIp: '198.51.100.4' }).catch(() => undefined);
    expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
    for (const k of keys) { expect(k).not.toContain(hash); expect(k).not.toContain('x'.repeat(20)); }
  });
  it('rate limited -> that 429 error, GoTrue is not called, nothing is written', async () => {
    const { w, hash, h } = await setup();
    const e = await recRejection(w.call(h, { body: { token_hash: hash, type: 'recovery' } }, { rateLimit: { consume: async () => { throw limited(); } } }));
    expect(e.code).toBe('common.rate_limited'); expect(e.retryAfterSeconds).toBe(42);
    expect(w.calls.filter((c) => c.method === 'verifyEmailToken')).toEqual([]);
    expect(w.store.committed()).toEqual([]);
  });
  it('limiter down on the login tier -> common.dependency_unavailable, GoTrue is not called', async () => {
    const { w, hash, h } = await setup();
    const e = await recRejection(w.call(h, { body: { token_hash: hash, type: 'recovery' } }, { rateLimit: { consume: async () => { throw new LimsError('common.dependency_unavailable'); } } }));
    expect(e.code).toBe('common.dependency_unavailable');
    expect(w.calls.filter((c) => c.method === 'verifyEmailToken')).toEqual([]);
  });
  it('no ctx.rateLimit at all -> common.dependency_unavailable (never served without the limiter)', async () => {
    const { w, hash, h } = await setup();
    const e = await recRejection(w.call(h, { body: { token_hash: hash, type: 'recovery' } }, { rateLimit: undefined }));
    expect(e.code).toBe('common.dependency_unavailable');
    expect(w.calls.filter((c) => c.method === 'verifyEmailToken')).toEqual([]);
  });
  it('a malformed body is still the 400 (validated before the limiter is spent)', async () => {
    const { w, h } = await setup(); const consume = vi.fn(async () => undefined);
    const e = await recRejection(w.call(h, { body: { token_hash: '', type: 'recovery' } }, { rateLimit: { consume } }));
    expect(e.code).toBe('common.validation_failed'); expect(consume).not.toHaveBeenCalled();
  });
});

describe('changeOwnPassword consumes the login tier', () => {
  const setup = async () => {
    const w = await selfWorld(); for (const k of ['ME', 'OTHER'] as Who[]) await w.addPerson(k);
    const cur = w.addSession('ME'); const svc = createSelfService(w.deps);
    const run = (c: Record<string, unknown>, pw = { currentPassword: OLD_PW, newPassword: NEW_PW }) => w.run((ctx) => svc.changeOwnPassword(ctx, pw), 'ME', cur, c);
    return { w, run };
  };
  it('consumes exactly one login-tier key, before the verifying GoTrue sign-in', async () => {
    const { w, run } = await setup(); let signInsBefore = -1;
    const consume = vi.fn(async (_t: string, _k: string) => { signInsBefore = w.gcalls.filter((c) => c.method === 'signInWithPassword').length; });
    const r = run({ rateLimit: { consume } }); await r.promise;
    expect(consume).toHaveBeenCalledTimes(1); expect(consume.mock.calls[0]![0]).toBe('login'); expect(signInsBefore).toBe(0);
    expect(w.gcalls.filter((c) => c.method === 'signInWithPassword').length).toBeGreaterThan(0);
  });
  it('the key is per caller: two different users never share it, and the same user always does', async () => {
    const { w, run } = await setup(); const keys: string[] = []; const consume = async (_t: string, k: string) => { keys.push(k); };
    const wrong = { currentPassword: 'Wrong-horse-battery-Lims!1', newPassword: NEW_PW };   // wrong password: no state change between calls
    await run({ rateLimit: { consume } }, wrong).promise.catch(() => undefined);
    await run({ rateLimit: { consume } }, wrong).promise.catch(() => undefined);
    const other = w.addSession('OTHER'); const svc = createSelfService(w.deps);
    await w.run((ctx) => svc.changeOwnPassword(ctx, wrong), 'OTHER', other, { rateLimit: { consume } }).promise.catch(() => undefined);
    expect(keys).toHaveLength(3); expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[0]);
  });
  it('rate limited -> common.rate_limited with Retry-After, the current password is NOT checked (no GoTrue call), nothing committed', async () => {
    const { w, run } = await setup();
    const r = run({ rateLimit: { consume: async () => { throw limited(); } } });
    const e = await rejection(r.promise);
    expect(e.code).toBe('common.rate_limited'); expect(e.retryAfterSeconds).toBe(42);
    expect(w.gcalls.filter((c) => c.method === 'signInWithPassword')).toEqual([]);
    expect(w.gcalls.filter((c) => c.method === 'adminUpdatePassword')).toEqual([]);
  });
  it('limiter down -> common.dependency_unavailable, GoTrue untouched', async () => {
    const { w, run } = await setup();
    const e = await rejection(run({ rateLimit: { consume: async () => { throw new LimsError('common.dependency_unavailable'); } } }).promise);
    expect(e.code).toBe('common.dependency_unavailable'); expect(w.gcalls).toEqual([]);
  });
  it('no ctx.rateLimit -> common.dependency_unavailable (fail closed), GoTrue untouched', async () => {
    const { w, run } = await setup();
    const e = await rejection(run({ rateLimit: undefined }).promise);
    expect(e.code).toBe('common.dependency_unavailable'); expect(w.gcalls).toEqual([]);
  });
  it('a wrong current password still answers auth.login_failed (the limiter does not change the answer)', async () => {
    const { run } = await setup(); const consume = vi.fn(async () => undefined);
    const e = await rejection(run({ rateLimit: { consume } }, { currentPassword: 'Wrong-horse-battery-Lims!1', newPassword: NEW_PW }).promise);
    expect(e.code).toBe('auth.login_failed'); expect(consume).toHaveBeenCalledTimes(1);
  });
});

describe('every operation declared x-rate-limit-tier: login reaches the limiter (completeness)', () => {
  // operationId -> files that may hold the consume call (handler or the service it calls)
  const ids = () => {
    const y = readFileSync(new URL('../../../../../../../contracts/openapi/identity.yaml', import.meta.url), 'utf8');
    const out: string[] = []; let op = '';
    for (const line of y.split(/\r?\n/)) {
      const m = /^\s+operationId:\s*(\w+)/.exec(line); if (m) op = m[1]!;
      if (/^\s+x-rate-limit-tier:\s*login\s*$/.test(line) && op) out.push(op);
    }
    return out;
  };
  it('the contract still lists these login-tier operations (guards the guard)', () => {
    expect(ids()).toEqual(expect.arrayContaining(['loginStaff', 'confirmEmailToken', 'changeOwnPassword', 'verifyMfaChallenge', 'setPasswordFromSetup', 'requestPasswordRecovery']));
  });
  it('each one has a handler/service source that consumes the tier (createAuthLimits, rateLimit.consume or ctx.rateLimit)', () => {
    const dir = new URL('../', import.meta.url); const svcDir = new URL('../../service/', import.meta.url);
    const read = (d: URL) => readdirSync(d).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(new URL(f, d), 'utf8'));
    const all = [...read(dir), ...read(svcDir)].join('\n');
    const uses = (src: string) => /createAuthLimits|rateLimit\??\.consume|ctx\.rateLimit|rateLimit\.consume\(\s*'login'/.test(src);
    expect(uses(all)).toBe(true);
    for (const op of ids()) {
      const file = (() => { try { return readFileSync(new URL(`${op}.ts`, dir), 'utf8'); } catch { return ''; } })();
      // operations bound through a shared file (self.http.ts, auth.service.ts, mfa handlers) are covered by the behaviour tests above / existing T6-T9 tests
      if (file && /bindSelf|createLoginHandler|from '\.\/verifyMfaChallenge/.test(file) === false) expect({ op, ok: uses(file) }).toEqual({ op, ok: true });
    }
  });
  it('self.service.ts changeOwnPassword consumes the login tier', () => {
    const src = readFileSync(new URL('../../service/self.service.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('async changeOwnPassword'));
    expect(body.slice(0, 1500)).toMatch(/rateLimit\??\.consume\(\s*'login'/);
  });
});
