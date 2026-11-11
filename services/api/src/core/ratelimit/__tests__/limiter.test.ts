// T0D-06 — rate-limit tiers, rejection shape, fail-open/closed (02-TRD §6.7, REQ-SEC-078, 03-APP-FLOW E-14, 07-SECURITY AB-18).
// Expected API (core/ratelimit/index.ts):
//   createRateLimiter({ backend, hmacKey: string|Buffer, log?: {info,warn,error}(obj,msg), metrics?: {inc(name, labels?)},
//                       tenant?: { rps?: number; burst?: number } })        // tenant = LIMS_CORE_TENANT_RPS / _BURST, defaults 100 / 200
//     -> { consume(tier: RateLimitTier, key: string): Promise<void> }       // same shape as ctx.rateLimit.consume
//   backend: RateLimitBackend = {
//     slidingWindow(keyHash, windowSeconds, limit): Promise<{ allowed, retryAfterSeconds }>,
//     tokenBucket(keyHash, ratePerSecond, burst):   Promise<{ allowed, retryAfterSeconds }>,
//     counter(keyHash, limit, ttlSeconds):          Promise<{ allowed, retryAfterSeconds }> }   // otp_verify: N attempts per OTP lifetime
//   keyHash = lowercase-hex HMAC-SHA256(hmacKey, …) — the raw key (phone, ip, account…) never reaches the backend.
//   Reject: LimsError('common.rate_limited') statusCode 429, retryAfterSeconds = backend value (integer >= 1);
//           metric lims_ratelimit_rejections_total{tier}. Backend error: `general` fails OPEN (+ log event 'ratelimit_backend_down'),
//           login/otp_request/otp_verify/qr_verify/report_download fail CLOSED with LimsError('common.dependency_unavailable') (503).
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createRateLimiter } from '../index.js';
import { KEY, recordingBackend, recordingLog, recordingMetrics } from './helpers.js';

const mk = (over: Record<string, unknown> = {}, decide?: Parameters<typeof recordingBackend>[0]) => {
  const b = recordingBackend(decide); const l = recordingLog(); const m = recordingMetrics();
  const limiter = createRateLimiter({ backend: b.backend, hmacKey: KEY, log: l.log, metrics: m.metrics, ...over } as any) as any;
  return { limiter, ...b, ...l, ...m };
};
const rejected = { allowed: false, retryAfterSeconds: 17 };

// 02-TRD §6.7 / 04 §4 — each tier limit exact.
const TABLE: Array<[tier: string, key: string, kind: string, args: unknown[]]> = [
  ['general', 'u:11111111-1111-7111-8111-111111111111', 'tokenBucket', [10, 20]],
  ['general', 't:22222222-2222-7222-8222-222222222222', 'tokenBucket', [100, 200]],
  ['ingest', 'd:device-1', 'slidingWindow', [60, 60]],
  ['login', 'a:someone@example.test', 'slidingWindow', [3600, 10]],
  ['otp_request', 'p:+9779800000000', 'slidingWindow', [3600, 3]],
  ['qr_verify', 'i:203.0.113.9', 'slidingWindow', [86400, 100]],
  ['report_download', 'l:33333333-3333-7333-8333-333333333333', 'slidingWindow', [3600, 20]],
];

describe('tier limits are exact (AC: each 04 §4 tier limit exact)', () => {
  it.each(TABLE)('%s %s -> %s%j', async (tier, key, kind, args) => {
    const t = mk();
    await t.limiter.consume(tier, key);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.kind).toBe(kind);
    expect(t.calls[0]!.args.slice(1)).toEqual(args); // args[0] = keyHash
  });

  it('otp_verify = counter of exactly 5 attempts for a positive integer lifetime', async () => {
    const t = mk();
    await t.limiter.consume('otp_verify', 'o:44444444-4444-7444-8444-444444444444');
    const c = t.calls[0]!;
    expect(c.kind).toBe('counter');
    expect(c.args[1]).toBe(5);
    expect(Number.isInteger(c.args[2]) && (c.args[2] as number) > 0).toBe(true);
  });

  it('tenant aggregate is configurable (LIMS_CORE_TENANT_RPS / _BURST); user bucket is not', async () => {
    const t = mk({ tenant: { rps: 50, burst: 75 } });
    await t.limiter.consume('general', 't:22222222-2222-7222-8222-222222222222');
    await t.limiter.consume('general', 'u:11111111-1111-7111-8111-111111111111');
    expect(t.calls.map((c) => c.args.slice(1))).toEqual([[50, 75], [10, 20]]);
  });
});

describe('key hashing (no PHI stored)', () => {
  it('backend only sees 64-hex HMAC-SHA256 of the key; raw phone/ip/account never appear', async () => {
    const t = mk();
    const keys: Array<[string, string]> = [['otp_request', 'p:+9779800000000'], ['qr_verify', 'i:203.0.113.9'], ['login', 'a:someone@example.test']];
    for (const [tier, key] of keys) await t.limiter.consume(tier, key);
    for (const [i, c] of t.calls.entries()) {
      expect(c.args[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(c.args)).not.toContain(keys[i]![1].slice(2));
    }
  });
  it('is keyed: deterministic per key, different per server key, different per tier, different per key', async () => {
    const hash = async (over: Record<string, unknown>, tier: string, key: string) => {
      const t = mk(over); await t.limiter.consume(tier, key); return t.calls[0]!.args[0];
    };
    const a = await hash({}, 'login', 'a:x');
    expect(await hash({}, 'login', 'a:x')).toBe(a);
    expect(await hash({ hmacKey: 'another-key-another-key-another' }, 'login', 'a:x')).not.toBe(a);
    expect(await hash({}, 'login', 'a:y')).not.toBe(a);
    expect(await hash({}, 'otp_request', 'a:x').catch(() => 'rejected')).not.toBe(a); // same key under another tier never shares a counter
    expect(a).not.toBe(createHmac('sha256', 'wrong').update('a:x').digest('hex'));
  });
});

describe('rejection (429 common.rate_limited)', () => {
  it('throws LimsError 429 with integer Retry-After from the backend and counts the rejection per tier', async () => {
    const t = mk({}, () => rejected);
    const e = await t.limiter.consume('qr_verify', 'i:203.0.113.9').then(() => null, (x: any) => x);
    expect(e?.code).toBe('common.rate_limited');
    expect(e.statusCode).toBe(429);
    expect(e.retryAfterSeconds).toBe(17);
    expect(t.incs).toEqual([{ name: 'lims_ratelimit_rejections_total', labels: expect.objectContaining({ tier: 'qr_verify' }) }]);
  });
  it.each([[0.2, 1], [0, 1], [3.01, 4]])('Retry-After %s is rounded up to an integer >= 1 (got %s)', async (given, want) => {
    const t = mk({}, () => ({ allowed: false, retryAfterSeconds: given }));
    const e = await t.limiter.consume('ingest', 'd:x').then(() => null, (x: any) => x);
    expect(e.retryAfterSeconds).toBe(want);
  });
  it('allowed calls count nothing and resolve undefined', async () => {
    const t = mk();
    await expect(t.limiter.consume('login', 'a:x')).resolves.toBeUndefined();
    expect(t.incs).toEqual([]);
  });
});

describe('fail-open / fail-closed (REQ-SEC-078, E-14, AB-18)', () => {
  it('general fails OPEN when the backend is down, and logs ratelimit_backend_down', async () => {
    const t = mk(); t.state.down = true;
    await expect(t.limiter.consume('general', 'u:11111111-1111-7111-8111-111111111111')).resolves.toBeUndefined();
    expect(t.entries.some((e) => e.obj?.event === 'ratelimit_backend_down')).toBe(true);
  });
  it.each(['login:a:x', 'otp_request:p:+9779800000000', 'otp_verify:o:abc', 'qr_verify:i:203.0.113.9', 'report_download:l:abc'])(
    '%s fails CLOSED: 503 common.dependency_unavailable, never allowed', async (spec) => {
      const [tier, ...rest] = spec.split(':');
      const t = mk(); t.state.down = true;
      const e = await t.limiter.consume(tier!, rest.join(':')).then(() => null, (x: any) => x);
      expect(e?.code).toBe('common.dependency_unavailable');
      expect(e.statusCode).toBe(503);
      expect(t.incs).toEqual([]); // an outage is not a rate-limit rejection
    });
  it('OTP brute force while the backend is down gets zero attempts (AB-18)', async () => {
    const t = mk(); t.state.down = true;
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => t.limiter.consume('otp_verify', 'o:abc')));
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });
  it('ingest (enforced automatically, per-device flood limit) is not in the fail-open list: fails closed', async () => {
    const t = mk(); t.state.down = true;
    const e = await t.limiter.consume('ingest', 'd:x').then(() => null, (x: any) => x);
    expect(e?.code).toBe('common.dependency_unavailable');
  });
});

describe('input discipline (adversarial)', () => {
  it.each([['unknown tier', 'nope', 'a:x'], ['empty key', 'login', ''], ['key prefix of another tier', 'ingest', 'u:abc'], ['bare key without prefix', 'login', 'someone'], ['non-string key', 'login', undefined as any]])(
    '%s is refused and the backend is never asked', async (_n, tier, key) => {
      const t = mk();
      await expect(t.limiter.consume(tier, key)).rejects.toBeTruthy();
      expect(t.calls).toHaveLength(0);
    });
  it('a refused key never fails open, even for general', async () => {
    const t = mk();
    await expect(t.limiter.consume('general', 'd:wrong-prefix')).rejects.toBeTruthy();
  });
  it('construction without an HMAC key is refused (keys would be unhashed)', () => {
    expect(() => createRateLimiter({ backend: recordingBackend().backend, hmacKey: '' } as any)).toThrow();
  });
});

// LD-121 (2026-11-12, C15 PG-T09): tier `general` also accepts `payments:cb:<intent_id>` (02-TRD C15 §6.3 step 2,
// 08 A19 D-116, 02-CV §10.3), same per-key token bucket as `u:` (10/s, burst 20). Nothing else changes.
describe('payments:cb:<intent_id> under general (LD-121)', () => {
  const ID_A = '55555555-5555-7555-8555-555555555555';
  const ID_B = '66666666-6666-7666-8666-666666666666';

  it('is consumed as the same token bucket as `u:` (10/s, burst 20)', async () => {
    const t = mk();
    await t.limiter.consume('general', `payments:cb:${ID_A}`);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.kind).toBe('tokenBucket');
    expect(t.calls[0]!.args.slice(1)).toEqual([10, 20]);
    expect(t.calls[0]!.args[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(t.calls[0]!.args)).not.toContain(ID_A); // key is HMAC'd like every other key
  });

  it('is not affected by the tenant bucket configuration', async () => {
    const t = mk({ tenant: { rps: 50, burst: 75 } });
    await t.limiter.consume('general', `payments:cb:${ID_A}`);
    expect(t.calls[0]!.args.slice(1)).toEqual([10, 20]);
  });

  it('is rejected with 429 common.rate_limited once the burst of 20 is spent', async () => {
    let n = 0; // stateful fake bucket: burst 20, then reject
    const t = mk({}, () => (++n <= 20 ? { allowed: true, retryAfterSeconds: 0 } : rejected));
    for (let i = 0; i < 20; i++) await t.limiter.consume('general', `payments:cb:${ID_A}`);
    const e = await t.limiter.consume('general', `payments:cb:${ID_A}`).then(() => null, (x: any) => x);
    expect(e?.code).toBe('common.rate_limited');
    expect(e.statusCode).toBe(429);
    expect(e.retryAfterSeconds).toBe(17);
    expect(t.incs).toEqual([{ name: 'lims_ratelimit_rejections_total', labels: expect.objectContaining({ tier: 'general' }) }]);
  });

  it('two intent ids do not share a bucket; same id is deterministic; not shared with the `u:` key of the same id', async () => {
    const t = mk();
    await t.limiter.consume('general', `payments:cb:${ID_A}`);
    await t.limiter.consume('general', `payments:cb:${ID_B}`);
    await t.limiter.consume('general', `payments:cb:${ID_A}`);
    await t.limiter.consume('general', `u:${ID_A}`);
    const h = t.calls.map((c) => c.args[0]);
    expect(h[0]).not.toBe(h[1]);
    expect(h[0]).toBe(h[2]);
    expect(h[3]).not.toBe(h[0]);
  });

  it('keeps general fail-OPEN on backend outage (logged), like every general key', async () => {
    const t = mk(); t.state.down = true;
    await expect(t.limiter.consume('general', `payments:cb:${ID_A}`)).resolves.toBeUndefined();
    expect(t.entries.some((e) => e.obj?.event === 'ratelimit_backend_down')).toBe(true);
  });

  it.each([
    ['empty intent id', 'general', 'payments:cb:'],
    ['prefix only, no colon', 'general', 'payments:cb'],
    ['near-miss prefix payments:cbx:', 'general', `payments:cbx:${ID_A}`],
    ['near-miss prefix payments:CB:', 'general', `payments:CB:${ID_A}`],
    ['other module prefix pay:cb:', 'general', `pay:cb:${ID_A}`],
    ['leading space', 'general', ` payments:cb:${ID_A}`],
    ['tier login', 'login', `payments:cb:${ID_A}`],
    ['tier ingest', 'ingest', `payments:cb:${ID_A}`],
    ['tier otp_request', 'otp_request', `payments:cb:${ID_A}`],
    ['tier otp_verify', 'otp_verify', `payments:cb:${ID_A}`],
    ['tier qr_verify', 'qr_verify', `payments:cb:${ID_A}`],
    ['tier report_download', 'report_download', `payments:cb:${ID_A}`],
    ['unknown tier', 'payments', `payments:cb:${ID_A}`],
  ])('still throws "ratelimit: unknown tier or key prefix" and never asks the backend: %s', async (_n, tier, key) => {
    const t = mk();
    await expect(t.limiter.consume(tier, key)).rejects.toThrow('ratelimit: unknown tier or key prefix');
    expect(t.calls).toHaveLength(0);
  });

  it('a refused payments:cb: key never fails open even while the backend is down', async () => {
    const t = mk(); t.state.down = true;
    await expect(t.limiter.consume('general', 'payments:cb:')).rejects.toThrow('ratelimit: unknown tier or key prefix');
  });

  it('existing 2-char prefix lookup is unchanged: u: and t: still work, other prefixes under general still throw', async () => {
    const t = mk();
    await t.limiter.consume('general', `u:${ID_A}`);
    await t.limiter.consume('general', `t:${ID_A}`);
    expect(t.calls.map((c) => c.args.slice(1))).toEqual([[10, 20], [100, 200]]);
    await expect(t.limiter.consume('general', `pa:${ID_A}`)).rejects.toThrow('ratelimit: unknown tier or key prefix');
  });
});
