// AN-T21 — P1 (#20-#23), P2 (listAnalyticsExports), P3 (exports of a centre-restricted caller), P9, X3 over the AN-T15 export emulator
// (handlers/__tests__/t15.helpers.ts; ../../export/__tests__/sqlFake.ts emulates the own-only RLS of analytics.exports / export_files).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import {
  A1, A2, B1, LAB_MANAGER, NO_PERM, OWNER, OWNER_A1, PARTNER, TA, TB, callExp, createBody, db15, exportId, expectLims, makeCtx15, okExp, seedReady,
} from '../../handlers/__tests__/t15.helpers.js';
import { extraPaths } from './spec.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
beforeEach(() => { db15.reset(); vi.clearAllMocks(); });
const text = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? Buffer.from(x).toString() : x));

describe('P1 tenant B ids on the export operations -> 404 common.not_found, nothing of tenant B in the answer', () => {
  beforeEach(() => { seedReady(1, OWNER); seedReady(70, OWNER, {}, TB, Buffer.from('TENANT-B-SECRET-BYTES')); });

  it.each(['getAnalyticsExport', 'downloadAnalyticsExport'] as const)('%s with a tenant B export id (same membership id) and with a random id', async (op) => {
    for (const n of [70, 99]) {
      const c = await makeCtx15(OWNER);
      const e = await expectLims(callExp(op, c.ctx, { params: { export_id: exportId(n) } }), 'common.not_found', 404);
      expect(text({ m: e.message, d: (e as any).detail })).not.toContain('TENANT-B');
      expect(c.accessRows).toEqual([]); // no access_log row for a file that is not ours
    }
    expect(db15.exports.get(exportId(70))!.downloads_used).toBe(0);
  });

  it('createAnalyticsExport: a tenant B centre / branch in params (alone or mixed with a tenant A centre) -> 404, no export row is created', async () => {
    for (const params of [{ centre_id: [B1] }, { centre_id: [A1, B1] }, { branch_id: ['01900002-0000-7000-8000-00000000bb03'] }]) {
      const before = db15.exports.size;
      const c = await makeCtx15(OWNER);
      await expectLims(callExp('createAnalyticsExport', c.ctx, { body: createBody({ params: { business_date_from: '2026-11-05', business_date_to: '2026-11-06', ...params } }) }), 'common.not_found', 404);
      expect(db15.exports.size).toBe(before);
    }
  });

  it('createAnalyticsExport: a tenant B department filter -> 404 / 400, never an export', async () => {
    const before = db15.exports.size;
    const c = await makeCtx15(OWNER);
    const out = await callExp('createAnalyticsExport', c.ctx, { body: createBody({ params: { business_date_from: '2026-11-05', business_date_to: '2026-11-06', filters: { department_id: ['01900002-0000-7000-8000-0000000000d4'] } } }) })
      .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
    // 07-SECURITY P1: department_id / branch ids of another tenant -> 404 (or per-field 400), at request time, like every report GET
    expect(out.ok, 'a tenant B / unknown department_id filter was accepted and stored in the export params').toBe(false);
    expect(db15.exports.size).toBe(before);
    if (!out.ok) expect(isLimsError(out.e, 'common.not_found') || isLimsError(out.e, 'common.validation_failed')).toBe(true);
  });
});

describe('P2 listAnalyticsExports with tenant B data present returns zero tenant B rows; P9 another user\'s export is invisible', () => {
  beforeEach(() => {
    seedReady(1, OWNER); seedReady(2, OWNER_A1);       // a colleague's (same tenant)
    for (let i = 0; i < 4; i++) seedReady(60 + i, OWNER, {}, TB); seedReady(65, OWNER_A1, {}, TB);
  });

  it('only the caller\'s own tenant-A exports, across pages', async () => {
    const c = await makeCtx15(OWNER);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await okExp('listAnalyticsExports', c.ctx, { query: { limit: 1, ...(cursor ? { cursor } : {}) } });
      seen.push(...r.body.data.map((e: any) => e.id));
      cursor = r.body.next_cursor ?? r.body.page?.next_cursor;
      for (const e of r.body.data) expect(extraPaths('listAnalyticsExports', { data: [e] }), 'X3').toEqual([]);
      if (!cursor) break;
    }
    expect(seen).toEqual([exportId(1)]);
  });

  it('P9: the colleague\'s export is 404 on get and on download (API) and the SQL emulation of RLS shows it to its owner only', async () => {
    const mine = await makeCtx15(OWNER);
    for (const op of ['getAnalyticsExport', 'downloadAnalyticsExport'] as const) await expectLims(callExp(op, mine.ctx, { params: { export_id: exportId(2) } }), 'common.not_found', 404);
    expect(db15.exports.get(exportId(2))!.downloads_used).toBe(0);
    const theirs = await makeCtx15(OWNER_A1);
    const r = await okExp('getAnalyticsExport', theirs.ctx, { params: { export_id: exportId(2) } });
    expect(r.body.id).toBe(exportId(2));
  });
});

describe('P3 exports of a centre-restricted caller', () => {
  it('A1-only caller cannot request centre A2 (404); a request without centre filter is stored with the caller scope, not "all centres"', async () => {
    const c = await makeCtx15(OWNER_A1);
    await expectLims(callExp('createAnalyticsExport', c.ctx, { body: createBody({ params: { business_date_from: '2026-11-05', business_date_to: '2026-11-06', centre_id: [A2] } }) }), 'common.not_found', 404);
    const r = await callExp('createAnalyticsExport', (await makeCtx15(OWNER_A1)).ctx, { body: createBody() });
    expect(r.status).toBe(202);
    const row = [...db15.exports.values()].find((e) => e.tenant_id === TA)!;
    expect(text(row)).not.toContain(A2);
    expect(JSON.stringify(row.scope_snapshot ?? row)).toMatch(new RegExp(`${A1}|"all_centres":false|all_centres.:.?false`));
  });
});

describe('P1/X1 export operations refuse partner and lacking roles before touching any row', () => {
  it.each([[PARTNER], [NO_PERM], [LAB_MANAGER]])('%s', async (who) => {
    seedReady(1, who === PARTNER ? OWNER : OWNER);
    for (const [op, o] of [['listAnalyticsExports', {}], ['getAnalyticsExport', { params: { export_id: exportId(1) } }], ['downloadAnalyticsExport', { params: { export_id: exportId(1) } }], ['createAnalyticsExport', { body: createBody() }]] as const) {
      const c = await makeCtx15(who);
      const e = await callExp(op, c.ctx, o as never).then(() => undefined, (x: unknown) => x);
      expect(isLimsError(e, 'auth.forbidden') || isLimsError(e, 'auth.unauthenticated'), `${op} for ${who}`).toBe(true);
    }
    expect(db15.exports.get(exportId(1))!.downloads_used).toBe(0);
  });
});
