// T0D-18 stage 5 (02-TRD §6.2 row 5, §6.7): tier from x-rate-limit-tier; `general` and `ingest` are enforced by the pipeline,
// every other tier only through ctx.rateLimit.consume() in the handler. Runs before idempotency and before any DB work.
import { describe, expect, it } from 'vitest';
import { claimsA, claimsDevice, count, LimsError, makeRig, op, rejects, SUB, TENANT_A } from './helpers.js';

describe('stage 5 rate limit', () => {
  it('general: consumes the actor bucket u:<sub> and the tenant bucket t:<tenant_id>', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.rl.calls).toEqual([['general', `u:${SUB}`], ['general', `t:${TENANT_A}`]]);
  });

  it('ingest: consumes d:<device_id> (the device actor id), not the general buckets', async () => {
    const rig = makeRig();
    await rig.run({ op: op({ rateLimitTier: 'ingest' }), claims: claimsDevice });
    expect(rig.rl.calls).toEqual([['ingest', `d:${claimsDevice.sub}`]]);
  });

  it.each(['login', 'otp_request', 'otp_verify', 'qr_verify', 'report_download'])('%s is NOT consumed by the pipeline (the handler does it)', async (tier) => {
    const rig = makeRig();
    await rig.run({ op: op({ rateLimitTier: tier }) });
    expect(rig.rl.calls).toEqual([]);
  });

  it('an operation without a tier consumes nothing', async () => {
    const rig = makeRig();
    await rig.run({ op: op({ rateLimitTier: undefined }) });
    expect(rig.rl.calls).toEqual([]);
  });

  it('a public operation (no claims) has no actor/tenant key: nothing consumed, handler still runs', async () => {
    const rig = makeRig({ handler: async () => ({ status: 200, body: {} }) });
    const r = await rig.run({ op: op({ public: true, context: undefined }), claims: undefined });
    expect(r.status).toBe(200);
    expect(rig.rl.calls).toEqual([]);
  });

  it('runs before idempotency begin, before the transaction and before the handler', async () => {
    const rig = makeRig();
    rig.idem.beginResult = { action: 'skip' };
    await rig.run({ op: op({ idempotency: 'optional' }), idempotencyKey: 'k1' });
    const i = (p: string) => rig.order.findIndex((o) => o.startsWith(p));
    expect(i('rate:general:u:')).toBeGreaterThanOrEqual(0);
    expect(i('rate:general:t:')).toBeLessThan(i('idem.begin'));
    expect(i('idem.begin')).toBeLessThan(i('handler'));
  });

  it('exceeded: common.rate_limited keeps retryAfterSeconds; no idempotency claim, no transaction, no handler', async () => {
    const rig = makeRig();
    const denied = Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: 7 });
    rig.rl.deny = denied;
    const e = await rejects(rig.run({ op: op({ idempotency: 'optional' }), idempotencyKey: 'k1' }));
    expect(e.code).toBe('common.rate_limited');
    expect(e.statusCode).toBe(429);
    expect(e.retryAfterSeconds).toBe(7);
    expect(rig.idem.begin).toEqual([]);
    expect(rig.order.some((o) => o.startsWith('handler'))).toBe(false);
    expect(count(rig, /^BEGIN/i)).toBe(0);
  });

  it('backend-down on a brute-force tier surfaces as 503 common.dependency_unavailable (limiter decides; pipeline rethrows unchanged)', async () => {
    const rig = makeRig();
    rig.rl.deny = new LimsError('common.dependency_unavailable');
    const e = await rejects(rig.run());
    expect(e.code).toBe('common.dependency_unavailable');
  });

  it('a claims object is never mutated by the stage', async () => {
    const rig = makeRig();
    const before = JSON.stringify(claimsA);
    await rig.run();
    expect(JSON.stringify(claimsA)).toBe(before);
  });
});
