// T0B-SWEEP-2 (LD-270) done_when (1): no operation may end 429. The per-user bucket (`u:` 10/s, burst 20 in src/core/ratelimit/index.ts) is hard-coded,
// so the harness spaces calls per session subject and retries a 429 after Retry-After. Implementation: services/api/test-sweep/pace.ts
//   export function createPacer(o: { ratePerSecond: number; burst: number; now: () => number; sleep: (ms: number) => Promise<void> }): { acquire(subject: string): Promise<void> }
//     token bucket per subject (starts full): any n consecutive acquires of one subject span at least (n - burst) / ratePerSecond seconds; subjects are independent.
//   export function withRateLimitRetry<T extends { statusCode: number; headers: Record<string, unknown> }>(
//     send: () => Promise<T>, o: { sleep: (ms: number) => Promise<void>; maxAttempts?: number }): Promise<{ res: T; attempts: number }>
//     a 429 is retried after Retry-After seconds (>= 1 s when absent or invalid); other statuses return at once; after maxAttempts (default 5) the last 429 is returned.
import { describe, expect, it } from 'vitest';
import { createPacer, withRateLimitRetry } from '../pace.js';

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, get t() { return t; } };
}

describe('createPacer', () => {
  it('never exceeds burst + rate * elapsed for one subject, and is not needlessly slow', async () => {
    const c = clock();
    const p = createPacer({ ratePerSecond: 8, burst: 10, now: c.now, sleep: c.sleep });
    const ts: number[] = [];
    for (let i = 0; i < 200; i++) { await p.acquire('session-a'); ts.push(c.t); }
    for (let i = 0; i < ts.length; i++) for (let j = i; j < ts.length; j++) {
      expect(j - i + 1, `window ${i}..${j}`).toBeLessThanOrEqual(10 + (8 * (ts[j]! - ts[i]!)) / 1000 + 1e-6);
    }
    expect(ts.at(-1)!).toBeGreaterThanOrEqual(((200 - 10) / 8) * 1000 - 1);
    expect(ts.at(-1)!).toBeLessThanOrEqual(((200 - 10) / 8) * 1000 * 1.1 + 50);
  });
  it('the burst goes out at once', async () => {
    const c = clock();
    const p = createPacer({ ratePerSecond: 8, burst: 10, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 10; i++) await p.acquire('s');
    expect(c.t).toBe(0);
  });
  it('subjects are independent: draining one does not delay another', async () => {
    const c = clock();
    const p = createPacer({ ratePerSecond: 8, burst: 10, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 60; i++) await p.acquire('a');
    const after = c.t;
    expect(after).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) await p.acquire('b');
    expect(c.t).toBe(after);
  });
  it('refills with time: after a pause the burst is available again', async () => {
    const c = clock();
    const p = createPacer({ ratePerSecond: 8, burst: 10, now: c.now, sleep: c.sleep });
    for (let i = 0; i < 10; i++) await p.acquire('s');
    await c.sleep(10_000);
    const before = c.t;
    for (let i = 0; i < 10; i++) await p.acquire('s');
    expect(c.t).toBe(before);
  });
});

describe('withRateLimitRetry', () => {
  const res = (statusCode: number, headers: Record<string, unknown> = {}) => ({ statusCode, headers });
  it('returns a non-429 answer at once', async () => {
    const slept: number[] = [];
    let n = 0;
    const r = await withRateLimitRetry(async () => { n++; return res(200); }, { sleep: async (ms) => { slept.push(ms); } });
    expect(r).toEqual({ res: res(200), attempts: 1 });
    expect(n).toBe(1);
    expect(slept).toEqual([]);
  });
  it('retries a 429 after Retry-After and returns the real answer', async () => {
    const slept: number[] = [];
    const seq = [res(429, { 'retry-after': '2' }), res(404)];
    const r = await withRateLimitRetry(async () => seq.shift()!, { sleep: async (ms) => { slept.push(ms); } });
    expect(r.res.statusCode).toBe(404);
    expect(r.attempts).toBe(2);
    expect(slept).toHaveLength(1);
    expect(slept[0]!).toBeGreaterThanOrEqual(2000);
  });
  it('waits at least one second when Retry-After is missing or invalid', async () => {
    const slept: number[] = [];
    const seq = [res(429), res(429, { 'retry-after': 'soon' }), res(200)];
    await withRateLimitRetry(async () => seq.shift()!, { sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toHaveLength(2);
    for (const s of slept) expect(s).toBeGreaterThanOrEqual(1000);
  });
  it('gives up after maxAttempts and returns the last 429 (the classifier then says NOT EXERCISED)', async () => {
    let n = 0;
    const r = await withRateLimitRetry(async () => { n++; return res(429, { 'retry-after': '1' }); }, { sleep: async () => undefined, maxAttempts: 3 });
    expect(n).toBe(3);
    expect(r.attempts).toBe(3);
    expect(r.res.statusCode).toBe(429);
  });
});
