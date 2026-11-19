// SEC-ABUSE-1 (LD-237; audit 2.4 / 6.1): stage 5 used to `return` for every public operation (no claims), so the nine public operations on the
// `general` tier had no application limit. Now a public operation WITHOUT claims on tier `general` consumes ONE IP-keyed general bucket:
// key 'i:' + <HMAC of the client IP>, consumed before idempotency, the transaction and the handler. Claims present = unchanged (u:/t:).
import { describe, expect, it } from 'vitest';
import { claimsA, count, LimsError, makeRig, op, rejects } from './helpers.js';

const pub = (over: Record<string, unknown> = {}) => op({ public: true, context: undefined, rateLimitTier: 'general', ...over });
const handler = async () => ({ status: 200, body: {} });

describe('stage 5: public operation without claims', () => {
  it('consumes exactly one general-tier key shaped i:<64 hex>, never the raw client IP', async () => {
    const rig = makeRig({ handler });
    const r = await rig.run({ op: pub(), claims: undefined, clientIp: '203.0.113.9' });
    expect(r.status).toBe(200);
    expect(rig.rl.calls).toHaveLength(1);
    const [tier, key] = rig.rl.calls[0]!;
    expect(tier).toBe('general');
    expect(key).toMatch(/^i:[0-9a-f]{64}$/);
    expect(JSON.stringify(rig.rl.calls)).not.toContain('203.0.113.9');
  });
  it('same IP -> same key; different IP -> different key (per-client bucket, not one shared bucket)', async () => {
    const rig = makeRig({ handler });
    await rig.run({ op: pub(), claims: undefined, clientIp: '203.0.113.9' });
    await rig.run({ op: pub(), claims: undefined, clientIp: '203.0.113.9' });
    await rig.run({ op: pub(), claims: undefined, clientIp: '198.51.100.4' });
    const keys = rig.rl.calls.map((c) => c[1]);
    expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[0]);
  });
  it('the IP bucket is also keyed apart from the verify-link bucket of tier qr_verify (no key text shared with another tier\'s raw IP key)', async () => {
    const rig = makeRig({ handler });
    await rig.run({ op: pub(), claims: undefined, clientIp: '203.0.113.9' });
    expect(rig.rl.calls[0]![1]).not.toBe('i:203.0.113.9');
  });
  it('runs before idempotency begin, before the transaction and before the handler', async () => {
    const rig = makeRig({ handler }); rig.idem.beginResult = { action: 'skip' };
    await rig.run({ op: pub({ idempotency: 'optional' }), claims: undefined, idempotencyKey: 'k1' });
    const i = (p: string) => rig.order.findIndex((o) => o.startsWith(p));
    expect(i('rate:general:i:')).toBeGreaterThanOrEqual(0);
    expect(i('rate:general:i:')).toBeLessThan(i('idem.begin'));
    expect(i('rate:general:i:')).toBeLessThan(i('handler'));
  });
  it('exceeded: 429 common.rate_limited keeps Retry-After; no transaction, no handler', async () => {
    const rig = makeRig({ handler });
    rig.rl.deny = Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: 9 });
    const e = await rejects(rig.run({ op: pub(), claims: undefined }));
    expect(e.code).toBe('common.rate_limited'); expect(e.statusCode).toBe(429); expect(e.retryAfterSeconds).toBe(9);
    expect(rig.order.some((o) => o.startsWith('handler'))).toBe(false); expect(count(rig, /^BEGIN/i)).toBe(0);
  });
  it('a limiter error other than rate_limited is rethrown unchanged (the limiter decides open/closed per tier)', async () => {
    const rig = makeRig({ handler });
    rig.rl.deny = new LimsError('common.dependency_unavailable');
    expect((await rejects(rig.run({ op: pub(), claims: undefined }))).code).toBe('common.dependency_unavailable');
  });
  it('identityAuth public operations (login family, tier login) are NOT consumed by the pipeline: the handler owns the login tier', async () => {
    const rig = makeRig({ handler });
    await rig.run({ op: pub({ rateLimitTier: 'login', identityAuth: true, module: 'identity' }), claims: undefined });
    expect(rig.rl.calls.filter((c) => c[0] === 'login')).toEqual([]);
  });
  it('a public operation with another tier or no tier consumes no IP general bucket (no double counting on otp_*, qr_verify, report_download)', async () => {
    for (const t of ['otp_request', 'otp_verify', 'qr_verify', 'report_download', undefined]) {
      const rig = makeRig({ handler });
      await rig.run({ op: pub({ rateLimitTier: t }), claims: undefined });
      expect(rig.rl.calls.filter((c) => c[0] === 'general')).toEqual([]);
    }
  });
  it('an empty client IP is either refused with common.internal (as verify.service does) or keyed i:<64 hex>; it never skips the limiter', async () => {
    const rig = makeRig({ handler });
    const out = await rig.run({ op: pub(), claims: undefined, clientIp: '' }).then(() => 'served', (e: any) => e.code);
    if (out === 'served') expect(rig.rl.calls[0]?.[1]).toMatch(/^i:[0-9a-f]{64}$/); else expect(out).toBe('common.internal');
  });
});

describe('stage 5: claims present is unchanged', () => {
  it('actor and tenant buckets only, no IP bucket', async () => {
    const rig = makeRig();
    await rig.run({ claims: claimsA, clientIp: '203.0.113.9' });
    expect(rig.rl.calls.map((c) => c[1].slice(0, 2))).toEqual(['u:', 't:']);
  });
});
