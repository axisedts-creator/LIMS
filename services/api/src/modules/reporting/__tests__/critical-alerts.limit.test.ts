// T0D-FIX-1 item 5b (LD-446, CR DEPLOY-AXIS-012 item 5): the contract validator injects `limit` as the NUMBER 50; listCriticalAlerts (/reporting)
// accepted only a numeric string and answered 400. It must accept a number and a numeric string, keep its bounds, and work with an ISO string ctx.now().
import { describe, expect, it } from 'vitest';
import { reportsReadHandlers } from '../handlers/reports-read.handlers.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const NOW = '2026-11-22T06:00:00.000Z';

function ctx(now: unknown = () => NOW) {
  const sql: string[] = [];
  const c = {
    tenantId: TENANT, actor: { id: '01a1b34e-1000-7eee-9d29-d7ca59a102b5', type: 'user' }, now,
    tx: { async query(text: string) { sql.push(text); return { rows: [] }; } },
    ports: { IdentityPort: { async assertRole() {} } },
  };
  return { c: c as never, sql };
}
const call = (query: Record<string, unknown>, c: unknown) =>
  reportsReadHandlers['listCriticalAlerts']!({ params: {}, query, headers: {}, body: undefined } as never, c as never) as Promise<any>;
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e?.code as string);

describe('listCriticalAlerts limit: number or numeric string (item 5b)', () => {
  it('limit 50 as a number -> 200, page.limit 50', async () => {
    const r = await call({ limit: 50 }, ctx().c);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [], page: { limit: 50 } });
  });
  it('limit "50" as a string and no limit still answer 200', async () => {
    expect((await call({ limit: '50' }, ctx().c)).body.page.limit).toBe(50);
    expect((await call({}, ctx().c)).body.page.limit).toBe(50);
  });
  it('bounds: 1 and 200 pass; 0, 201, 2.5, -1, NaN -> common.validation_failed, nothing read', async () => {
    for (const ok of [1, 200]) expect((await call({ limit: ok }, ctx().c)).status).toBe(200);
    const { c, sql } = ctx();
    for (const bad of [0, 201, 2.5, -1, Number.NaN, 'abc', '', true, null]) expect(await code(call({ limit: bad as never }, c)), String(bad)).toBe('common.validation_failed');
    expect(sql).toEqual([]);
  });
  it('an ISO string ctx.now() and a Date ctx.now() both work with a numeric limit', async () => {
    expect((await call({ limit: 50 }, ctx(() => NOW).c)).status).toBe(200);
    expect((await call({ limit: 50 }, ctx(() => new Date(NOW)).c)).status).toBe(200);
  });
  it('the 7 day look-back and strict keys still hold with a numeric limit', async () => {
    expect(await code(call({ limit: 50, since: '2026-11-01T00:00:00.000Z' }, ctx().c))).toBe('common.validation_failed');
    expect(await code(call({ limit: 50, foo: 'x' }, ctx().c))).toBe('common.validation_failed');
  });
  it('staff only: a non-user actor is refused before any read', async () => {
    const { c, sql } = ctx();
    expect(await code(call({ limit: 50 }, { ...(c as object), actor: { id: 'x', type: 'device' } }))).toBe('auth.forbidden');
    expect(sql).toEqual([]);
  });
});
