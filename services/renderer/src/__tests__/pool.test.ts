// C6-T05 — Chromium pool: contexts, recycle, timeout, page limit, memory, crash recovery (02-TRD §5.1; AC-03.9; 07-SECURITY T18).
// ASSUMED API (spec names no signatures) — see guard.test.ts header, plus:
//   Pool.browser(): playwright Browser (the single Chromium instance; tests close it to simulate a crash)
//   createPool opts: contexts (default LIMS_RENDERER_CONTEXTS=4), recycleAfter (=200), timeoutMs (=30000), maxPages (=60),
//                    memoryLimitBytes (container limit; recycle when RSS > 85 % of it)
//   Failures reject with an Error carrying numeric `httpStatus` per 02-TRD §5.1 error table: 408 timeout, 422 page limit.
//   The worker's 5 retries (AC-03.9) are worker logic (later task); here the pool must be reusable after a failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '../pool.js';
import { norm, pdfPages, pdfText } from './helpers/pdf-text.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

type Pool = Awaited<ReturnType<typeof createPool>>;
const open: Pool[] = [];
const mk = async (o: Parameters<typeof createPool>[0] = {}) => {
  const p = await createPool(o);
  open.push(p);
  return p;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((p) => p.close()));
});

const doc = (label: string, pages = 1) =>
  `<!doctype html><meta charset="utf-8">` +
  Array.from({ length: pages }, (_, i) => `<div${i < pages - 1 ? ' style="break-after:page"' : ''}>${label}-P${i + 1}</div>`).join('');

describe('contexts', () => {
  it('never runs more than N contexts at once and completes every job', async () => {
    const pool = await mk({ contexts: 2 });
    let max = 0;
    const timer = setInterval(() => (max = Math.max(max, pool.stats().contextsBusy)), 5);
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => pool.renderHtml(doc(`J${i}`))));
    clearInterval(timer);
    expect(max).toBeLessThanOrEqual(2);
    outs.forEach((o, i) => expect(norm(pdfText(o.pdf))).toContain(`J${i}-P1`)); // no cross-talk between contexts
    expect(pool.stats().contextsBusy).toBe(0);
  });
});

describe('recycle', () => {
  it('restarts the browser after recycleAfter renders and keeps serving', async () => {
    const pool = await mk({ contexts: 2, recycleAfter: 2 });
    for (let i = 0; i < 5; i++) {
      const { pdf } = await pool.renderHtml(doc(`R${i}`));
      expect(norm(pdfText(pdf))).toContain(`R${i}-P1`);
    }
    expect(pool.stats().recycles).toBeGreaterThanOrEqual(2);
  });

  it('memory cap: RSS above 85 % of memoryLimitBytes triggers a recycle', async () => {
    const pool = await mk({ contexts: 2, recycleAfter: 100_000, memoryLimitBytes: 1 });
    await pool.renderHtml(doc('M'));
    await pool.renderHtml(doc('M'));
    expect(pool.stats().recycles).toBeGreaterThanOrEqual(1);
  });

  it('no recycle while under both thresholds', async () => {
    const pool = await mk({ contexts: 2, recycleAfter: 100_000, memoryLimitBytes: 64 * 1024 ** 3 });
    await pool.renderHtml(doc('N'));
    await pool.renderHtml(doc('N'));
    expect(pool.stats().recycles).toBe(0);
  });
});

describe('AC-03.9 — timeout and crash', () => {
  it('a render over timeoutMs rejects with httpStatus 408 and the pool stays usable', async () => {
    const pool = await mk({ contexts: 2, timeoutMs: 1 });
    await expect(pool.renderHtml(doc('SLOW', 30))).rejects.toMatchObject({ httpStatus: 408 });
    expect(pool.stats().contextsBusy).toBe(0); // context released
    const ok = await mk({ contexts: 2 });
    expect(norm(pdfText((await ok.renderHtml(doc('FAST'))).pdf))).toContain('FAST-P1');
  });

  it('after a timeout on the same pool the next render succeeds (no leaked/hung context)', async () => {
    const pool = await mk({ contexts: 1, timeoutMs: 1 });
    await expect(pool.renderHtml(doc('SLOW', 30))).rejects.toMatchObject({ httpStatus: 408 });
    // same pool, same single context: must not deadlock (race against a guard so the test fails instead of hanging)
    const r = await Promise.race([
      pool.renderHtml('<p>x</p>').then(
        () => 'done',
        () => 'done', // may time out again at 1 ms, but must settle
      ),
      new Promise((res) => setTimeout(() => res('hung'), 30_000)),
    ]);
    expect(r).toBe('done');
    expect(pool.stats().contextsBusy).toBe(0);
  });

  it('browser crash: the next render relaunches and succeeds', async () => {
    const pool = await mk({ contexts: 2 });
    await pool.renderHtml(doc('PRE'));
    await pool.browser().close(); // simulate the crash
    const { pdf } = await pool.renderHtml(doc('POST'));
    expect(norm(pdfText(pdf))).toContain('POST-P1');
  });

  it('browser crash while jobs are in flight: in-flight jobs settle, later jobs succeed', async () => {
    const pool = await mk({ contexts: 2 });
    const inflight = Promise.allSettled([pool.renderHtml(doc('A', 40)), pool.renderHtml(doc('B', 40))]);
    await pool.browser().close();
    const settled = await inflight; // must not hang
    expect(settled).toHaveLength(2);
    const { pdf } = await pool.renderHtml(doc('AFTER'));
    expect(norm(pdfText(pdf))).toContain('AFTER-P1');
  });
});

describe('saturation (02-TRD §5.1 error table: 503 pool saturated, worker retries)', () => {
  it('a queued job behind a long job is bounded: renders (context freed by 408) or rejects 503/408', async () => {
    const pool = await mk({ contexts: 1, timeoutMs: 1000, maxPages: 100_000 });
    const long = pool.renderHtml(doc('LONG', 1500)).then(
      () => 'ok',
      (e: { httpStatus?: number }) => `err${e.httpStatus}`,
    );
    await new Promise((r) => setTimeout(r, 50)); // long job owns the single context
    expect(pool.stats().contextsBusy).toBe(1);
    const t0 = Date.now();
    // 02-TRD §5.1: one per-job timeout, 503 allowed, no queue-wait bound. Waiter may take the context freed by LONG's 408, or get 503/408 (arbiter ruling, round 3)
    const waiter = await pool.renderHtml(doc('WAIT')).then(
      (r) => ({ ok: true as const, text: norm(pdfText(r.pdf)) }),
      (e: { httpStatus?: number }) => ({ ok: false as const, status: e.httpStatus }),
    );
    if (waiter.ok) expect(waiter.text).toContain('WAIT-P1');
    else expect([503, 408]).toContain(waiter.status);
    expect(Date.now() - t0).toBeLessThan(4000); // wait bounded by ~timeoutMs, not "until the long job ends"
    await long; // settles (408 or ok), must not hang
    expect(pool.stats().contextsBusy).toBe(0);
    // abandoned waiter must not leak: next job gets the context
    const { pdf } = await pool.renderHtml(doc('NEXT'));
    expect(norm(pdfText(pdf))).toContain('NEXT-P1');
  });
});

describe('page limit (T18)', () => {
  it('maxPages exceeded → httpStatus 422; exactly maxPages is fine', async () => {
    const pool = await mk({ contexts: 2, maxPages: 3 });
    const ok = await pool.renderHtml(doc('L', 3));
    expect(ok.pageCount).toBe(3);
    expect(pdfPages(ok.pdf)).toHaveLength(3);
    await expect(pool.renderHtml(doc('L', 5))).rejects.toMatchObject({ httpStatus: 422 });
  });
});
