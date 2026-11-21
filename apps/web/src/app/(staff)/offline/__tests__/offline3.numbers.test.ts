// T0D-OFFLINE-3 (LD-322; offline design section 4; done_when 1, 2, 5): device number blocks for lab codes and patient ids, provisional document numbers.
// Fails now because core/offline/numbers.ts does not exist.
import { describe, expect, it } from 'vitest';
import { DEVICE, createEnv, prov } from './offline3.fixtures';
import { PIN } from '@/core/offline/__tests__/offline1.helpers';

describe('provisionalNumber (the device and the server must print the same string)', () => {
  it('is OFF-<first 8 of the device id>-<op id>-<doc>, upper case, exactly the server formula', async () => {
    const { provisionalNumber } = await import('@/core/offline/numbers');
    const op = '0192f0d6-1234-7abc-8def-0123456789ab';
    expect(provisionalNumber(DEVICE, op, 'INV')).toBe(prov(op, 'INV'));
    expect(provisionalNumber(DEVICE, op, 'RC2')).toBe(prov(op, 'RC2'));
    expect(provisionalNumber(DEVICE, op, 'RC')).toMatch(/^OFF-[A-Za-z0-9-]+$/); // SyncNumberMapping.provisional_number pattern
    expect(provisionalNumber(DEVICE, op, 'RC').length).toBeLessThanOrEqual(60);
  });
});

describe('reserve: blocks come from the server while online', () => {
  it('POSTs /v1/core/sync/number-blocks with the device id, the series, the default size and an Idempotency-Key', async () => {
    const env = await createEnv({ blocks: false });
    const r = await env.numbers.reserve('lab_code');
    expect(r).toMatchObject({ ok: true, remaining: 200 });
    const p = await env.numbers.reserve('patient_id', { centreId: '01a1a98a-ac40-7000-8000-000000000003' });
    expect(p).toMatchObject({ ok: true, remaining: 100 });
    const calls = env.sim.calls.filter((c) => c.path === '/v1/core/sync/number-blocks');
    expect(calls.map((c) => c.body)).toEqual([
      { device_id: DEVICE, series: 'lab_code', size: 200 },
      { device_id: DEVICE, series: 'patient_id', size: 100, centre_id: '01a1a98a-ac40-7000-8000-000000000003' },
    ]);
    for (const c of calls) expect(c.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
    expect(calls[0]!.headers['idempotency-key']).not.toBe(calls[1]!.headers['idempotency-key']);
  });

  it('answers { ok: false } with no side effect when the server is unreachable, and carries the closed code of a refusal', async () => {
    const env = await createEnv({ blocks: false });
    env.sim.routes['POST /v1/core/sync/number-blocks'] = () => 'throw';
    expect(await env.numbers.reserve('lab_code')).toMatchObject({ ok: false });
    expect(await env.numbers.remaining('lab_code')).toMatchObject({ left: 0 });
    env.sim.routes['POST /v1/core/sync/number-blocks'] = () => ({ status: 422, body: { code: 'sync.series_unknown' } });
    expect(await env.numbers.reserve('lab_code')).toMatchObject({ ok: false, code: 'sync.series_unknown' });
    expect((await env.numbers.next('lab_code')).provisional).toBe(true); // nothing was kept
  });

  it('refuses a series that is not a block series (bill, invoice and receipt numbers are never issued in blocks)', async () => {
    const env = await createEnv({ blocks: false });
    await expect(env.numbers.reserve('receipt')).rejects.toBeTruthy();
    await expect(env.numbers.reserve('invoice')).rejects.toBeTruthy();
    expect(env.sim.calls.filter((c) => c.path === '/v1/core/sync/number-blocks')).toHaveLength(0);
  });
});

describe('next: numbers come out of the block, once each', () => {
  it('hands out the block in order, one number per call, lab codes and patient ids on separate counters', async () => {
    const env = await createEnv();
    const a = await env.numbers.next('lab_code'); const b = await env.numbers.next('lab_code'); const p = await env.numbers.next('patient_id');
    expect([a.value, b.value, p.value]).toEqual(['1001', '1002', '5001']);
    expect([a.number, b.number, p.number]).toEqual([1001, 1002, 5001]);
    expect([a.provisional, b.provisional, p.provisional]).toEqual([false, false, false]);
    expect(a.mark).toBeUndefined();
  });

  it('never hands the same number twice under 120 parallel calls (one tab, many screens)', async () => {
    const env = await createEnv();
    const all = await Promise.all(Array.from({ length: 120 }, () => env.numbers.next('lab_code')));
    const values = all.map((x) => x.value);
    expect(new Set(values).size).toBe(120);
    expect(values.every((v) => /^\d+$/.test(v))).toBe(true);
    expect(Math.min(...all.map((x) => x.number!))).toBe(1001);
    expect(Math.max(...all.map((x) => x.number!))).toBe(1120);
  });

  it('survives a reload: a new instance on the reopened store continues where the last one stopped', async () => {
    const env = await createEnv();
    expect((await env.numbers.next('lab_code')).value).toBe('1001');
    expect((await env.numbers.next('lab_code')).value).toBe('1002');
    env.store.lock();
    const store2 = await env.reopen();
    expect((await store2.unlock(PIN)).ok).toBe(true);
    const { createNumbers } = await import('@/core/offline/numbers');
    const again = createNumbers({ store: store2, deviceId: DEVICE, fetch: env.sim.fetch, now: env.c.now } as never);
    expect((await again.next('lab_code')).value).toBe('1003');
    expect((await again.remaining('lab_code')).left).toBe(197);
  });

  it('rejects with offline.locked while the store is locked and does not spend a number', async () => {
    const env = await createEnv();
    env.store.lock();
    await expect(env.numbers.next('lab_code')).rejects.toMatchObject({ code: 'offline.locked' });
    env.store.lock();
    expect((await env.store.unlock(PIN)).ok).toBe(true);
    expect((await env.numbers.next('lab_code')).value).toBe('1001');
  });

  it('keeps the blocks of two reservations in order and never overlaps them', async () => {
    const env = await createEnv({ blocks: false, sizes: { lab_code: 3 } });
    await env.numbers.reserve('lab_code'); await env.numbers.reserve('lab_code');
    const got: string[] = [];
    for (let i = 0; i < 6; i++) got.push((await env.numbers.next('lab_code')).value);
    expect(got).toEqual(['1001', '1002', '1003', '1004', '1005', '1006']);
    expect((await env.numbers.next('lab_code')).provisional).toBe(true);
  });
});

describe('early warning at 20 percent left, then provisional codes marked PENDING (done_when 5)', () => {
  it('remaining() reports left, size and warn; warn turns on at exactly 20 percent of the block (200 -> 40 left)', async () => {
    const env = await createEnv();
    expect(await env.numbers.remaining('lab_code')).toEqual({ left: 200, size: 200, warn: false });
    for (let i = 0; i < 159; i++) await env.numbers.next('lab_code');
    expect(await env.numbers.remaining('lab_code')).toEqual({ left: 41, size: 200, warn: false });
    await env.numbers.next('lab_code');
    expect(await env.numbers.remaining('lab_code')).toEqual({ left: 40, size: 200, warn: true });
    expect(await env.numbers.remaining('patient_id')).toEqual({ left: 100, size: 100, warn: false }); // each series on its own
  });

  it('an empty block falls back to OFF- numbers marked PENDING, unique, and never inside the block range', async () => {
    const env = await createEnv({ blocks: false, sizes: { lab_code: 2 } });
    await env.numbers.reserve('lab_code');
    expect((await env.numbers.next('lab_code')).provisional).toBe(false);
    expect((await env.numbers.next('lab_code')).provisional).toBe(false);
    expect(await env.numbers.remaining('lab_code')).toEqual({ left: 0, size: 2, warn: true });
    const fallback = await Promise.all(Array.from({ length: 30 }, () => env.numbers.next('lab_code')));
    for (const f of fallback) expect(f).toMatchObject({ provisional: true, mark: 'PENDING', number: null, value: expect.stringMatching(/^OFF-[A-Za-z0-9-]+$/) });
    expect(new Set(fallback.map((f) => f.value)).size).toBe(30);
  });

  it('a device that never reserved a block still works (provisional PENDING codes), and patient ids fall back the same way', async () => {
    const env = await createEnv({ blocks: false });
    expect(await env.numbers.next('lab_code')).toMatchObject({ provisional: true, mark: 'PENDING' });
    expect(await env.numbers.next('patient_id')).toMatchObject({ provisional: true, mark: 'PENDING' });
  });
});

describe('the number blocks and counters are only in the encrypted store', () => {
  it('no plain block range or counter value is readable in the raw IndexedDB dump', async () => {
    const { rawDump } = await import('./offline3.fixtures');
    const env = await createEnv();
    await env.numbers.next('lab_code');
    const dump = await rawDump(env.dbName);
    expect(dump).not.toMatch(/from_value|to_value|"series"|lab_code|patient_id/);
  });
});
