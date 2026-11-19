// SEC-ABUSE-1 (LD-237; audit 6.1): the staff-login failure windows and the per-IP counters live in the limiter's `login` tier
// (Postgres app.ratelimit_hit), NOT in process Maps. Thresholds, windows and lockout are the ones loginStaff.ts has today:
//   consumeAttempt  a:<acct>  10 / 60 min (limiter rule)        accountState  failures in the last 60 min + time of the last one
//   recordIpFailure 10 failures in 10 min -> engaged, throttled 30 min     checkIp  while throttled 5 attempts / 60 s, then common.rate_limited
// SEAM the tests expect: createAuthLimits(rateLimit, now) keeps its signature and `rateLimit` is a REAL createRateLimiter() over the pg backend.
// The key prefixes / extra rules the writer adds to the login tier are free; tests only observe AuthLimits + the SQL the backend saw.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRateLimiter } from '../../../../core/ratelimit/index.js';
import { createPgBackend } from '../../../../core/ratelimit/pg.js';
import { KEY, clock, fakePg } from '../../../../core/ratelimit/__tests__/helpers.js';
import { createAuthLimits } from '../loginStaff.js';

const T0 = 1_800_000_000_000;                 // multiple of 3600 s: every window below starts on its boundary
const MIN = 60_000;
// a fresh IP / account per test: the in-process Maps of the CURRENT loginStaff.ts leak state between tests of one file, the new store-backed code does not
let seq = 0, IP = '', ACCT = '';
beforeEach(() => { seq += 1; IP = `203.0.${Math.floor(seq / 250)}.${(seq % 250) + 1}`; ACCT = seq.toString(16).padStart(64, 'a'); });

/** one shared "database" (fake app.ratelimit_hit) and any number of limiter + createAuthLimits instances over it = N API processes. */
function world(startMs = T0) {
  const c = clock(startMs); const pg = fakePg(c.now);
  const process_ = () => {
    const limiter = createRateLimiter({ backend: createPgBackend({ query: pg.query }), hmacKey: KEY } as any);
    return createAuthLimits(limiter as any, c.now);
  };
  return { c, pg, process_ };
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e: any) { return e?.code ?? `non-lims:${e?.message}`; } };
const err = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e; } throw new Error('expected rejection'); };

describe('threshold table is unchanged', () => {
  it('account attempt cap: 10 per hour, the 11th is common.rate_limited with Retry-After >= 1', async () => {
    const { process_ } = world(); const l = process_();
    for (let i = 0; i < 10; i++) await l.consumeAttempt(ACCT);
    const e = await err(l.consumeAttempt(ACCT));
    expect(e.code).toBe('common.rate_limited'); expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
  it('account failures: counted per account, lastFailureAt = time of the latest, clear resets to 0', async () => {
    const { c, process_ } = world(); const l = process_();
    expect(await l.accountState(ACCT)).toEqual({ failures: 0, lastFailureAt: null });
    for (let i = 0; i < 4; i++) { await l.recordAccountFailure(ACCT); c.advance(10_000); }
    const s = await l.accountState(ACCT);
    expect(s.failures).toBe(4); expect(s.lastFailureAt!.getTime()).toBe(T0 + 30_000);
    expect((await l.accountState('b'.repeat(64))).failures).toBe(0);   // another account is untouched
    await l.clearAccountFailures(ACCT);
    expect((await l.accountState(ACCT)).failures).toBe(0);
  });
  it('account failures older than 60 minutes no longer count', async () => {
    const { c, process_ } = world(); const l = process_();
    await l.recordAccountFailure(ACCT); await l.recordAccountFailure(ACCT);
    c.advance(61 * MIN);
    expect((await l.accountState(ACCT)).failures).toBe(0);
  });
  it('IP: 9 failures in 10 minutes do not engage; the 10th does (engaged:true, windowStart = first failure)', async () => {
    const { c, process_ } = world(); const l = process_();
    for (let i = 0; i < 9; i++) { expect((await l.recordIpFailure(IP)).engaged).toBe(false); c.advance(30_000); }
    const r = await l.recordIpFailure(IP);
    expect(r.engaged).toBe(true); expect(r.windowStart.getTime()).toBe(T0);
  });
  it('IP: failures spread over more than 10 minutes never engage', async () => {
    const { c, process_ } = world(); const l = process_();
    for (let i = 0; i < 12; i++) { expect((await l.recordIpFailure(IP)).engaged).toBe(false); c.advance(2 * MIN); }
  });
  it('IP not engaged: checkIp never limits, however often it is called', async () => {
    const { process_ } = world(); const l = process_();
    for (let i = 0; i < 20; i++) await l.checkIp(IP);
  });
  it('IP engaged: 5 attempts per 60 s pass, the 6th is common.rate_limited (Retry-After 1..60); passes again in the next minute', async () => {
    const { c, process_ } = world(); const l = process_();
    for (let i = 0; i < 10; i++) await l.recordIpFailure(IP);
    for (let i = 0; i < 5; i++) await l.checkIp(IP);
    const e = await err(l.checkIp(IP));
    expect(e.code).toBe('common.rate_limited'); expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(1); expect(e.retryAfterSeconds).toBeLessThanOrEqual(60);
    c.advance(130_000);                                    // sliding window moved on; still inside the 30 minute throttle
    await l.checkIp(IP);
  });
  it('IP lockout lasts 30 minutes from the engaging failure: still throttled at +29 min, free at +31 min', async () => {
    const { c, process_ } = world(); const l = process_();
    for (let i = 0; i < 10; i++) await l.recordIpFailure(IP);
    c.advance(29 * MIN);
    for (let i = 0; i < 5; i++) await l.checkIp(IP);
    expect(await code(l.checkIp(IP))).toBe('common.rate_limited');
    c.advance(2 * MIN + 1);                                // 31 min after engagement
    for (let i = 0; i < 20; i++) await l.checkIp(IP);
  });
  it('another IP is not throttled by the engaged one', async () => {
    const { process_ } = world(); const l = process_();
    for (let i = 0; i < 10; i++) await l.recordIpFailure(IP);
    for (let i = 0; i < 20; i++) await l.checkIp('198.51.100.5');
  });
});

describe('counters survive a restart and are shared by instances (fake limiter store shared by two processes)', () => {
  it('failures recorded by process A are seen by process B, and B clears them for A', async () => {
    const { process_ } = world(); const a = process_(), b = process_();
    await a.recordAccountFailure(ACCT); await a.recordAccountFailure(ACCT); await a.recordAccountFailure(ACCT);
    expect((await b.accountState(ACCT)).failures).toBe(3);
    await b.clearAccountFailures(ACCT);
    expect((await a.accountState(ACCT)).failures).toBe(0);
  });
  it('the hourly attempt cap is one budget across processes (6 on A + 4 on B = 10, the next on either is limited)', async () => {
    const { process_ } = world(); const a = process_(), b = process_();
    for (let i = 0; i < 6; i++) await a.consumeAttempt(ACCT);
    for (let i = 0; i < 4; i++) await b.consumeAttempt(ACCT);
    expect(await code(a.consumeAttempt(ACCT))).toBe('common.rate_limited');
    expect(await code(b.consumeAttempt(ACCT))).toBe('common.rate_limited');
  });
  it('IP failures from two processes add up to the engagement; the throttle then bites on a third (a restart forgets nothing)', async () => {
    const { process_ } = world(); const a = process_(), b = process_();
    for (let i = 0; i < 5; i++) expect((await a.recordIpFailure(IP)).engaged).toBe(false);
    for (let i = 0; i < 4; i++) expect((await b.recordIpFailure(IP)).engaged).toBe(false);
    expect((await a.recordIpFailure(IP)).engaged).toBe(true);
    const fresh = process_();                              // "restarted" process: new Maps would be empty
    for (let i = 0; i < 5; i++) await fresh.checkIp(IP);
    expect(await code(fresh.checkIp(IP))).toBe('common.rate_limited');
  });
  it('no process-local state is left in loginStaff.ts (no Map of failure times, no module-level counters)', () => {
    const src = readFileSync(new URL('../loginStaff.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/new Map\s*</);
    expect(src).not.toMatch(/\b(ipFails|ipAttempts|ipUntil|ipLast)\b\s*=/);
  });
});

describe('fail closed: a limiter failure on the login tier denies', () => {
  const ops: Array<[string, (l: ReturnType<typeof createAuthLimits>) => Promise<unknown>]> = [
    ['consumeAttempt', (l) => l.consumeAttempt(ACCT)],
    ['accountState', (l) => l.accountState(ACCT)],
    ['recordAccountFailure', (l) => l.recordAccountFailure(ACCT)],
    ['checkIp', (l) => l.checkIp(IP)],
    ['recordIpFailure', (l) => l.recordIpFailure(IP)],
  ];
  it.each(ops)('%s with the store down -> common.dependency_unavailable (never resolves, never "allowed")', async (_n, run) => {
    const { pg, process_ } = world(); const l = process_();
    pg.state.down = true;
    expect(await code(run(l))).toBe('common.dependency_unavailable');
  });
  it.each(ops)('%s without a limiter -> common.dependency_unavailable', async (_n, run) => {
    expect(await code(run(createAuthLimits(undefined, () => T0)))).toBe('common.dependency_unavailable');
  });
  it('a store that comes back is used again (no sticky denial and no sticky allow)', async () => {
    const { pg, process_ } = world(); const l = process_();
    pg.state.down = true; expect(await code(l.checkIp(IP))).toBe('common.dependency_unavailable');
    pg.state.down = false; await l.checkIp(IP);
  });
});

describe('keys are HMAC-ed before they reach the store; only app.ratelimit_hit / ratelimit_peek / ratelimit_clear (LD-410) are used', () => {
  it('the SQL and values never contain the raw IP or the raw account key; every key is 64 hex chars', async () => {
    const { pg, process_ } = world(); const l = process_();
    await l.checkIp(IP); await l.consumeAttempt(ACCT); await l.recordAccountFailure(ACCT); await l.accountState(ACCT);
    for (let i = 0; i < 10; i++) await l.recordIpFailure(IP);
    await l.checkIp(IP); await l.clearAccountFailures(ACCT);
    expect(pg.executed.length).toBeGreaterThan(0);
    for (const { sql, values } of pg.executed) {
      expect(sql).toMatch(/app\.ratelimit_(hit|peek|clear)/); expect(sql).not.toMatch(/rate_limit_counters/);
      expect(values[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify([sql, values])).not.toContain(IP);
      expect(JSON.stringify([sql, values])).not.toContain(ACCT);
    }
  });
  it('the IP counters and the account counters never share a key (a:<x> and f:<x> with the same text are different counters)', async () => {
    const { process_ } = world(); const l = process_();
    for (let i = 0; i < 10; i++) await l.recordIpFailure(ACCT);   // same text as the account key, on the IP side
    expect((await l.accountState(ACCT)).failures).toBe(0);
    for (let i = 0; i < 10; i++) await l.consumeAttempt(ACCT);    // the IP side is still free
    await l.checkIp(ACCT);
  });
});
