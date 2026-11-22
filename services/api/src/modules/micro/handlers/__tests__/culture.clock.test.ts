// T0D-FIX-1 item 3 (LD-446, CR DEPLOY-AXIS-012 item 4): the pipeline's ctx.now() returns an ISO STRING, not a Date.
// listCultures (/micro/worklist) used `now.toISOString()` and answered 500 `common.internal`. It must work with a string clock, a Date clock, and a frozen clock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failure, mkCtx, READ, run } from './helpers/cultureReads.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const FROZEN = '2026-11-22T06:00:00.000Z';
const seen: { sql: string; params: unknown[] }[] = [];
const tx = { async query(sql: string, params: unknown[] = []) { seen.push({ sql, params }); return { rows: [], rowCount: 0 }; } };

const ctxWith = (now: unknown) => {
  const { ctx } = mkCtx({ tenantId: TENANT, tx, grants: [READ] });
  return { ...ctx, now };
};
afterEach(() => { vi.useRealTimers(); seen.length = 0; });

describe('listCultures clock (item 3)', () => {
  it('ctx.now() as an ISO string (what the pipeline really passes) -> 200, no throw', async () => {
    const r = await run('listCultures', { query: {} }, ctxWith(() => FROZEN));
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
  });
  it('ctx.now() as a Date still works', async () => {
    expect((await run('listCultures', { query: {} }, ctxWith(() => new Date(FROZEN)))).status).toBe(200);
  });
  it('a frozen wall clock and an ISO string clock: the ctx clock is used, the answer is 200', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'));
    const r = await run('listCultures', { query: { read_overdue: 'true', include_total: 'true' } }, ctxWith(() => FROZEN));
    expect(r.status).toBe(200);
  });
  it('no ctx.now at all falls back to the wall clock (200)', async () => {
    expect((await run('listCultures', { query: {} }, ctxWith(undefined))).status).toBe(200);
  });
  it('the numeric limit the validator injects (50) and a numeric string both work with the string clock', async () => {
    for (const limit of [50, '50']) expect((await run('listCultures', { query: { limit } }, ctxWith(() => FROZEN))).status, String(limit)).toBe(200);
  });
  it('a clock string that is not a date is not a 500 from a TypeError: it is refused or answered, never "toISOString is not a function"', async () => {
    const e = await run('listCultures', { query: {} }, ctxWith(() => 'garbage')).then(() => undefined, (x) => x);
    if (e) expect(String(e?.message ?? e)).not.toMatch(/is not a function/);
  });
  it('permission still comes first with the string clock: no grant -> 403 and no SQL', async () => {
    const { ctx } = mkCtx({ tenantId: TENANT, tx, grants: [] });
    const e = await failure(run('listCultures', { query: {} }, { ...ctx, now: () => FROZEN }));
    expect(e.code).toBe('auth.forbidden');
    expect(seen).toEqual([]);
  });
});
