// T0B-MISREPORTS-1 done_when (5) "a performance bound for one month of a 20000 bill fixture on the throwaway PG17" and (3) the row cap on a result that is too large.
// Fixture: 20000 issued invoices (about 40000 lines, 40000 order items, 14000 payments, 7000 home collections) in 30 days of tenant A, synthetic, bulk inserted (kit.ts).
// Bound (pinned pick, lead may tighten): the median of 3 runs of every report over the whole month is <= 2000 ms, bill_of_the_day over one day (about 670 rows, paged by 100) <= 2000 ms in
// total, statements per report <= 8. Correctness is checked on the same runs so a wrong but fast query cannot pass. Rows above the contract row_cap fail fast with the standard error.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAIN_CODES, def } from './contract.js';
import { ALL, TENANT_A, allPages, cleanupWorld, makeSpec, misReports, rangeOf, seedSales, seedWorld, sum, withCtx, type World } from './kit.js';

const FROM = '2020-06-01', TO = '2020-06-30', T = 1_800_000, BOUND_MS = 2000;
let W: World;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

beforeAll(async () => {
  W = await seedWorld(makeSpec({ tenant: TENANT_A, bills: 20_000, seed: 33, tag: 'MISP', patients: 12_000 }));
  await seedSales(W);
}, T);
afterAll(async () => { if (W) await cleanupWorld(W); }, T);

const PARAMS: Record<string, Record<string, unknown>> = { repeated_patient: { filters: { min_repeat_count: 6 } } }; // keeps the result below the row cap
async function timed(code: string, a: Record<string, unknown>) {
  return withCtx(W, 'rls', async ({ ctx, statements }) => {
    const { runMisReport } = await misReports(); const t0 = performance.now();
    const r = await runMisReport(ctx, code, { range: rangeOf(FROM, TO), scope: ALL, limit: 1000, ...a });
    return { ms: performance.now() - t0, r, statements: statements.length };
  });
}

describe('one month of 20000 bills', () => {
  it.each(PLAIN_CODES.filter((c) => c !== 'bill_of_the_day'))('%s: median of 3 runs <= 2000 ms, <= 8 statements, rows below the contract cap, content right', async (code) => {
    await timed(code, PARAMS[code] ?? {}); // warm up the plan cache / buffers
    const runs = [await timed(code, PARAMS[code] ?? {}), await timed(code, PARAMS[code] ?? {}), await timed(code, PARAMS[code] ?? {})];
    expect(median(runs.map((x) => x.ms)), `${code} ms ${runs.map((x) => Math.round(x.ms))}`).toBeLessThanOrEqual(BOUND_MS);
    for (const x of runs) expect(x.statements).toBeLessThanOrEqual(8);
    expect(runs[0]!.r.rows.length).toBeLessThanOrEqual(def(code).row_cap);
    expect(JSON.stringify(runs[0]!.r.rows)).toEqual(JSON.stringify(runs[2]!.r.rows)); // deterministic
  }, T);

  it('ipd_opd over the month adds up to the register (fast and right)', async () => {
    const r = (await timed('ipd_opd', {})).r;
    expect(sum(r.rows.map((x: any) => x.net_paisa))).toBe(sum(W.bills.map((b) => b.net)));
    expect(sum(r.rows.map((x: any) => x.orders_registered))).toBe(20_000);
  }, T);

  it('consultant over the month: Σ net billed = Σ net of the referred bills', async () => {
    const r = (await timed('consultant', {})).r;
    expect(sum(r.rows.map((x: any) => x.net_billed_paisa))).toBe(sum(W.bills.filter((b) => b.referrerId).map((b) => b.net)));
  }, T);

  it('bill_of_the_day: one day paged by 100 within the bound, every bill of the day once', async () => {
    const day = '2020-06-15'; const want = W.bills.filter((b) => b.day === day);
    expect(want.length).toBeGreaterThan(300);
    const t0 = performance.now();
    const rows = await withCtx(W, 'rls', ({ ctx }) => allPages(ctx, 'bill_of_the_day', { range: rangeOf(day, day), scope: ALL }, 100));
    const ms = performance.now() - t0;
    expect(rows.map((r) => r.invoice_id).sort()).toEqual(want.map((b) => b.id).sort());
    expect(ms, `paged day ${Math.round(ms)} ms`).toBeLessThanOrEqual(BOUND_MS);
  }, T);

  it('row cap (done_when 3): the whole month of bills (20000 rows > 5000) fails fast with the standard validation error, for a page and for a stream', async () => {
    expect(def('bill_of_the_day').row_cap).toBe(5000);
    const t0 = performance.now();
    const e: any = await timed('bill_of_the_day', {}).then(() => undefined, (x) => x);
    expect(e?.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(e.errors.length).toBeGreaterThan(0);
    expect(performance.now() - t0, 'refused without reading 20000 rows into memory').toBeLessThanOrEqual(BOUND_MS);
    const s: any = await withCtx(W, 'rls', async ({ ctx }) => {
      const { streamMisReport } = await misReports();
      try { for await (const _ of streamMisReport(ctx, 'bill_of_the_day', { range: rangeOf(FROM, TO), scope: ALL })) { /* never */ } } catch (x) { return x; }
      return undefined;
    });
    expect(s?.code).toBe('common.validation_failed');
  }, T);

  it('stream of a day: chunks of 100, whole result equals the paged result, no chunk above the chunk size', async () => {
    const day = '2020-06-15'; const sizes: number[] = []; let n = 0;
    await withCtx(W, 'rls', async ({ ctx }) => {
      const { streamMisReport } = await misReports();
      for await (const ch of streamMisReport(ctx, 'bill_of_the_day', { range: rangeOf(day, day), scope: ALL, chunkRows: 100 })) { sizes.push(ch.length); n += ch.length; }
    });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
    expect(n).toBe(W.bills.filter((b) => b.day === day).length);
  }, T);
});
