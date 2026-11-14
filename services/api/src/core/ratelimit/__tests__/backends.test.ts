// T0D-06 — Postgres + Redis backends and boundary-burst tests (REQ-SEC-079, 05-SCHEMA §10 app.ratelimit_hit).
// Expected API:
//   core/ratelimit/pg.ts    createPgBackend({ query(sql, values): Promise<{ rows }> }) -> RateLimitBackend (see limiter.test.ts)
//       slidingWindow / counter call ONLY `SELECT allowed, retry_after_seconds FROM app.ratelimit_hit($1,$2,$3)` with [keyHash, windowSeconds, limit]
//       (counter: window = limit*ttlSeconds + 1 so the previous window can't fade within one OTP lifetime, review item 1). The counter table has no grants, so SQL must never name core.rate_limit_counters.
//       tokenBucket on Postgres is an approximation (ratelimit_hit is a sliding window); contract: first call allowed, never more than `burst` in one instant.
//   core/ratelimit/redis.ts createRedisBackend({ client }) -> RateLimitBackend (ioredis-shaped client). Live semantics only run when
//       LIMS_TEST_REDIS_URL is set (ioredis is not yet a dependency of services/api — lockfile is C0-0A's, LD-05).
import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../index.js';
import { createPgBackend } from '../pg.js';
import { createRedisBackend } from '../redis.js';
import { KEY, clock, fakePg } from './helpers.js';

const WINDOW_START = 1_800_000_000_000 - (1_800_000_000_000 % 60_000); // a 60 s boundary (ms)
const mk = (startMs: number) => {
  const c = clock(startMs); const pg = fakePg(c.now);
  const limiter = createRateLimiter({ backend: createPgBackend({ query: pg.query }), hmacKey: KEY } as any) as any;
  const hit = async (tier: string, key: string) => limiter.consume(tier, key).then(() => true, (e: any) => { if (e.code !== 'common.rate_limited') throw e; return false; });
  const burst = async (n: number, tier: string, key: string) => { let ok = 0; for (let i = 0; i < n; i++) if (await hit(tier, key)) ok++; return ok; };
  return { c, pg, limiter, hit, burst };
};

describe('pg backend: SQL contract', () => {
  it('calls only app.ratelimit_hit with [keyHash, window, limit]; never the counter table; no raw key in SQL or values', async () => {
    const { pg, limiter } = mk(WINDOW_START);
    await limiter.consume('otp_request', 'p:+9779800000000');
    expect(pg.executed).toHaveLength(1);
    const { sql, values } = pg.executed[0]!;
    expect(sql).toMatch(/app\.ratelimit_hit\s*\(\s*\$1\s*,\s*\$2\s*,\s*\$3\s*\)/);
    expect(sql).not.toMatch(/rate_limit_counters/);
    expect(values).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), 3600, 3]);
    expect(JSON.stringify([sql, values])).not.toContain('9779800000000');
  });
  it('maps retry_after_seconds to Retry-After', async () => {
    const { c, limiter, burst } = mk(WINDOW_START + 10_000);
    expect(await burst(3, 'otp_request', 'p:+9779800000000')).toBe(3);
    c.advance(0);
    const e = await limiter.consume('otp_request', 'p:+9779800000000').then(() => null, (x: any) => x);
    expect(e.code).toBe('common.rate_limited');
    expect(e.retryAfterSeconds).toBe(3590); // ceil(window - elapsed) = 3600 - 10
  });
  it('query failure surfaces as the tier policy: login closed (503), general open', async () => {
    const { pg, limiter } = mk(WINDOW_START); pg.state.down = true;
    await expect(limiter.consume('login', 'a:x')).rejects.toMatchObject({ code: 'common.dependency_unavailable' });
    await expect(limiter.consume('general', 'u:11111111-1111-7111-8111-111111111111')).resolves.toBeUndefined();
  });
});

describe('exact limits through the pg backend (limit N allowed, N+1 rejected)', () => {
  it.each([
    ['ingest', 'd:dev-1', 60], ['login', 'a:acct', 10], ['otp_request', 'p:+9779800000000', 3],
    ['qr_verify', 'i:203.0.113.9', 100], ['report_download', 'l:link-1', 20], ['otp_verify', 'o:otp-1', 5],
  ] as const)('%s %s allows exactly %i then rejects', async (tier, key, n) => {
    const { burst, hit } = mk(WINDOW_START + 1_000);
    expect(await burst(n, tier, key)).toBe(n);
    expect(await hit(tier, key)).toBe(false);
  });
  it('keys are independent (one device flooding does not block another)', async () => {
    const { burst, hit } = mk(WINDOW_START + 1_000);
    await burst(61, 'ingest', 'd:noisy');
    expect(await hit('ingest', 'd:quiet')).toBe(true);
  });
  it('general token bucket on pg: first call allowed, never more than burst (20) in one instant', async () => {
    const { burst, hit } = mk(WINDOW_START + 1_000);
    expect(await hit('general', 'u:11111111-1111-7111-8111-111111111111')).toBe(true);
    const ok = 1 + await burst(60, 'general', 'u:11111111-1111-7111-8111-111111111111');
    expect(ok).toBeLessThanOrEqual(20);
  });
});

describe('boundary-burst (REQ-SEC-079): a burst straddling a window edge cannot double the limit', () => {
  it('ingest 60/min: 60 at the end of window n, 60 right after the edge -> second burst is rejected', async () => {
    const { c, burst } = mk(WINDOW_START + 59_000);
    expect(await burst(60, 'ingest', 'd:dev-1')).toBe(60);       // end of window n
    c.set(WINDOW_START + 60_500);                                 // 1.5 s later, window n+1 (0.5 s in)
    expect(await burst(60, 'ingest', 'd:dev-1')).toBe(0);         // fixed-window counter would let all 60 through (120 in 1.5 s)
  });
  it('the previous window fades linearly: halfway through window n+1 exactly half the limit is available', async () => {
    const { c, burst } = mk(WINDOW_START + 59_000);
    await burst(60, 'ingest', 'd:dev-1');
    c.set(WINDOW_START + 90_000);                                 // 30 s into window n+1: estimate = 60*0.5 + cur <= 60
    expect(await burst(60, 'ingest', 'd:dev-1')).toBe(30);
  });
  it('after a full idle window the whole limit is available again', async () => {
    const { c, burst } = mk(WINDOW_START + 59_000);
    await burst(60, 'ingest', 'd:dev-1');
    c.set(WINDOW_START + 125_000);                                // window n+2: window n is no longer "previous"
    expect(await burst(60, 'ingest', 'd:dev-1')).toBe(60);
  });
  it('long windows too: report_download 20/h at the hour edge', async () => {
    const H = 3_600_000; const edge = 1_800_000_000_000 - (1_800_000_000_000 % H);
    const { c, burst } = mk(edge + H - 5_000);
    expect(await burst(20, 'report_download', 'l:link-1')).toBe(20);
    c.set(edge + H + 5_000);
    expect(await burst(20, 'report_download', 'l:link-1')).toBe(0);
  });
  it('otp_verify (counter tier) on pg: never more than 5 attempts within one 600 s OTP lifetime, whatever the window alignment', async () => {
    // Window-alignment independent: sweep the first-burst time across the counter's window; 5 + 10 attempts, the 2nd burst 540 s later (< 600 s).
    for (let offsetS = 0; offsetS < 3_100; offsetS += 50) {
      const { c, burst } = mk(WINDOW_START - 1_000 + offsetS * 1_000);
      const first = await burst(5, 'otp_verify', 'o:otp-1');
      c.advance(540_000);
      const second = await burst(10, 'otp_verify', 'o:otp-1');
      expect(first + second, `offset ${offsetS}s`).toBeLessThanOrEqual(5);
    }
  });
  it('rejected attempts count toward the next window (hammering extends the lockout)', async () => {
    const { c, burst, hit } = mk(WINDOW_START + 3_590_000);
    expect(await burst(10, 'login', 'a:acct')).toBe(10);
    await burst(90, 'login', 'a:acct');                           // 90 rejected attempts, 100 hits recorded in window n
    c.set(WINDOW_START + 3_601_000);                              // 1 s into window n+1: 100 * (1 - 1/3600) + 1 > 10
    expect(await hit('login', 'a:acct')).toBe(false);
  });
});

describe('redis backend', () => {
  it('every client failure rejects (so the limiter can apply fail-open/closed) — never resolves allowed', async () => {
    const dead = new Proxy({}, { get: () => async () => { throw new Error('ECONNREFUSED'); } });
    const b = createRedisBackend({ client: dead as any }) as any;
    await expect(b.slidingWindow('h'.repeat(64), 60, 60)).rejects.toBeTruthy();
    await expect(b.tokenBucket('h'.repeat(64), 10, 20)).rejects.toBeTruthy();
    await expect(b.counter('h'.repeat(64), 5, 300)).rejects.toBeTruthy();
  });
  it('end-to-end: Redis down -> login closed 503, general open', async () => {
    const dead = new Proxy({}, { get: () => async () => { throw new Error('ECONNREFUSED'); } });
    const limiter = createRateLimiter({ backend: createRedisBackend({ client: dead as any }), hmacKey: KEY } as any) as any;
    await expect(limiter.consume('otp_verify', 'o:abc')).rejects.toMatchObject({ code: 'common.dependency_unavailable' });
    await expect(limiter.consume('general', 'u:11111111-1111-7111-8111-111111111111')).resolves.toBeUndefined();
  });
});

// Live Redis (env-gated: LIMS_TEST_REDIS_URL=redis://127.0.0.1:6379). Same limits as the pg backend; real wall clock, so window edges are not asserted.
describe.skipIf(!process.env['LIMS_TEST_REDIS_URL'])('redis backend (live)', () => {
  it.each([['ingest', 'd:dev-live', 60], ['login', 'a:live', 10], ['otp_request', 'p:+9779800000001', 3], ['otp_verify', 'o:live', 5]] as const)(
    '%s allows exactly %i then rejects', async (tier, key, n) => {
      const mod = 'ioredis'; // variable specifier: ioredis is not installed yet, vite must not resolve it at transform time
      const { default: Redis } = await import(/* @vite-ignore */ mod);
      const client = new Redis(process.env['LIMS_TEST_REDIS_URL']!);
      try {
        const unique = `${key}:${Date.now()}`;
        const limiter = createRateLimiter({ backend: createRedisBackend({ client }), hmacKey: KEY } as any) as any;
        for (let i = 0; i < n; i++) await limiter.consume(tier, unique);
        await expect(limiter.consume(tier, unique)).rejects.toMatchObject({ code: 'common.rate_limited' });
      } finally { client.disconnect(); }
    });
});
