// T0B-SYNC-2 done_when (7) BACKPRESSURE: one batch in flight per device (advisory lock, a second concurrent batch gets 429 with retry_after), per device and per tenant rate limits,
// 200 devices after an outage. Live PG17. Fails today: createSyncPart2Handlers does not exist.
// Pinned settings: deviceBatchesPerMinute, tenantBatchesPerMinute (sliding window on ctx.now(), limiter state per createSyncPart2Handlers instance); errors are LimsError('common.rate_limited') with retryAfterSeconds > 0.
import { describe, expect, it } from 'vitest';
import { A1, A2, B1, code, devicePush, effects, engine, enter, entered, gate, ledger, newDevice, NOW, okBody, uid } from './helpers2.js';

const T = 300_000;
const waitFor = async (cond: () => boolean, ms = 20_000): Promise<void> => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for the batch to start'); await new Promise((r) => setTimeout(r, 20)); } };

describe('one batch in flight per device', () => {
  it('a second concurrent batch of the SAME device gets 429 (common.rate_limited) with retry_after and does no work; the first finishes normally; a retry afterwards works', async () => {
    const H = engine();
    const dev = await newDevice(A1);
    const g = `g-${uid()}`;
    const held = enter({ payload: { tag: 'held', hold: g } });
    const first = devicePush(H, A1, dev, [held]);
    await waitFor(() => entered.includes(held.op_id));
    const other = enter({ payload: { tag: 'other' } });
    const second = await devicePush(H, A1, dev, [other]);
    expect(code(second)).toBe('common.rate_limited');
    expect(second.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(await ledger([other.op_id])).toEqual([]);
    gate(g).open();
    expect(okBody(await first).results[0].status).toBe('accepted');
    expect(okBody(await devicePush(H, A1, dev, [other])).results[0].status).toBe('accepted');   // the lock is released at the end of the request
  }, T);
  it('another device (also of the same user) and another tenant are not blocked while a batch is in flight', async () => {
    const H = engine();
    const [d1, d2, d3] = [await newDevice(A1), await newDevice(A1), await newDevice(B1)];
    const g = `g-${uid()}`;
    const held = enter({ payload: { hold: g } });
    const first = devicePush(H, A1, d1, [held]);
    await waitFor(() => entered.includes(held.op_id));
    expect(okBody(await devicePush(H, A1, d2, [enter()])).results[0].status).toBe('accepted');
    expect(okBody(await devicePush(H, B1, d3, [enter()])).results[0].status).toBe('accepted');
    gate(g).open(); okBody(await first);
  }, T);
  it('a refused batch (device revoked, too large, invalid) does not keep the lock: the next batch of the device runs', async () => {
    const H = engine({ maxBatchOperations: 2 });
    const dev = await newDevice(A1);
    expect(code(await devicePush(H, A1, dev, [enter(), enter(), enter()]))).toBe('sync.batch_too_large');
    expect(okBody(await devicePush(H, A1, dev, [enter()])).results[0].status).toBe('accepted');
  }, T);
});

describe('rate limits per device and per tenant', () => {
  it('per device: the batch beyond deviceBatchesPerMinute within the window is common.rate_limited with retry_after <= 60 and does no work; after the window it runs; other devices are not affected', async () => {
    const H = engine({ deviceBatchesPerMinute: 2 });
    const [d1, d2] = [await newDevice(A1), await newDevice(A1)];
    okBody(await devicePush(H, A1, d1, [enter()])); okBody(await devicePush(H, A1, d1, [enter()]));
    const blocked = enter();
    const metrics: any[] = [];
    const o = await devicePush(H, A1, d1, [blocked], { metrics });
    expect(code(o)).toBe('common.rate_limited');
    expect(o.error.retryAfterSeconds).toBeGreaterThan(0); expect(o.error.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(await ledger([blocked.op_id])).toEqual([]);
    expect(metrics.some((m) => m.name === 'lims_core_sync_batches_total' && m.labels?.outcome === 'rate_limited')).toBe(true);
    expect(okBody(await devicePush(H, A1, d2, [enter()])).results[0].status).toBe('accepted');
    expect(okBody(await devicePush(H, A1, d1, [blocked], { now: new Date(NOW.getTime() + 61_000) })).results[0].status).toBe('accepted');
  }, T);
  it('per tenant: tenantBatchesPerMinute counts every device of the tenant and never another tenant', async () => {
    const H = engine({ tenantBatchesPerMinute: 3 });
    const [d1, d2, d3] = [await newDevice(A1), await newDevice(A2), await newDevice(A1)];
    const at = { now: new Date('2026-11-17T12:00:00Z') };
    okBody(await devicePush(H, A1, d1, [enter()], at)); okBody(await devicePush(H, A2, d2, [enter()], at)); okBody(await devicePush(H, A1, d1, [enter()], at));
    const o = await devicePush(H, A1, d3, [enter()], at);
    expect(code(o)).toBe('common.rate_limited'); expect(o.error.retryAfterSeconds).toBeGreaterThan(0);
    const dB = await newDevice(B1);
    expect(okBody(await devicePush(H, B1, dB, [enter()], at)).results[0].status).toBe('accepted');
  }, T);
  it('the defaults leave room for a normal outage recovery (a device may send at least 10 batches per minute, a tenant at least 100)', async () => {
    const H = engine();
    const dev = await newDevice(A1);
    for (let i = 0; i < 10; i++) okBody(await devicePush(H, A1, dev, [enter()], { now: new Date('2026-11-17T13:00:00Z') }));
  }, T);
});

// NOT covered here: the 200 device load test of LD-322 decision 5 (too slow for the suite); 40 concurrent devices prove the lock and the ledger under real concurrency
describe('after an outage many devices send at once', () => {
  it('40 devices push 3 operations each concurrently: all accepted exactly once, no deadlock, no lost or doubled effect', async () => {
    const H = engine();
    const devs = await Promise.all(Array.from({ length: 40 }, () => newDevice(A1)));
    const batches = devs.map((d) => ({ d, ops: [enter(), enter(), enter()] }));
    const outs = await Promise.all(batches.map(({ d, ops }) => devicePush(H, A1, d, ops)));
    for (const o of outs) expect(okBody(o).results.map((r: any) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);
    const all = batches.flatMap((b) => b.ops.map((x) => x.op_id));
    expect((await effects(all)).length).toBe(120);
    expect((await ledger(all)).length).toBe(120);
  }, T);
  it('the same batch sent by two devices of one user at the same time: every operation is executed once (op_id is the key per tenant)', async () => {
    const H = engine();
    const [d1, d2] = [await newDevice(A1), await newDevice(A1)];
    const ops = [enter(), enter(), enter(), enter()];
    const [a, b] = await Promise.all([devicePush(H, A1, d1, ops), devicePush(H, A1, d2, ops)]);
    expect(a.error ?? b.error).toBeUndefined();                          // a unique violation on (tenant, op_id) must become duplicate, never a failed request
    const statuses = [a, b].flatMap((o) => okBody(o).results.map((r: any) => r.status));
    expect((await effects(ops.map((x) => x.op_id))).length).toBe(4);
    expect(statuses.filter((s) => s === 'accepted').length).toBe(4);   // never 8
    expect(statuses.filter((s) => s === 'duplicate').length).toBe(4);
  }, T);
});
