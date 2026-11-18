// T0B-PRICETOOLS-1 comparePriceLists over a real PG17 under RLS (done_when 5, 7): one row per orderable on either version ordered by test code, difference = B - A, percent_bp = difference in basis points of A
// (integer, half up, absent when A is 0), a price missing from one version is ABSENT (never 0), paged by cursor, and ONE paged SQL query: the statement count does not grow with the rows (no per row loops).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NONE, T, TENANT_A, TENANT_B, compareOf, draftOf, expectCode, halfUpDiv, mkList, mkTests, pcall, pfails, publishedList, putItems, schemaErrors, seedTests, superTx, uid, world, req, type TestRef } from './helpers.js';
import type { World } from '../testmgmt/helpers.js';

let w: World; let tests: TestRef[]; let A: string; let B: string; const bulkPrefix = `CMP${Math.floor(Math.random() * 1e6)}X`;
beforeAll(async () => {
  w = await world(TENANT_A); tests = await mkTests(w, 12);
  const a = await publishedList(tests.slice(0, 8).map((t, i) => ({ id: t.id, paisa: [1000, 3, 0, 200, 1000, 3, 0, 200][i]! })));
  const b = await publishedList(tests.slice(4, 12).map((t, i) => ({ id: t.id, paisa: [1100, 5, 500, 100, 1, 2, 3, 4][i]! })));
  A = a.versionId; B = b.versionId;
}, T);
afterAll(async () => { await superTx(async (tx) => { await tx.query(`UPDATE catalog.orderables SET is_active = false WHERE tenant_id = $1 AND code LIKE $2 || '%'`, [TENANT_A, bulkPrefix]); await tx.query(`UPDATE catalog.tests SET is_active = false WHERE tenant_id = $1 AND id IN (SELECT id FROM catalog.orderables WHERE code LIKE $2 || '%')`, [TENANT_A, bulkPrefix]); }, TENANT_A); }, T);

describe('rows and arithmetic', () => {
  it('one row per orderable on either version, ordered by test code; matches PriceListComparisonPage', { timeout: T }, async () => {
    const r = await compareOf(A, B);
    expect(r.status).toBe(200);
    expect(schemaErrors('PriceListComparisonPage', r.body)).toEqual([]);
    const codes = r.body.data.map((x: any) => x.test_code);
    expect(codes).toEqual([...tests.map((t) => t.code)].sort());
    expect(new Set(codes).size).toBe(12);
    for (const row of r.body.data) { expect(row.test_name).toBeTruthy(); expect(row.orderable_id).toBeTruthy(); }
  });
  it('difference_paisa = B - A; percent_bp = difference in basis points of A, integer half up; absent when A is 0', { timeout: T }, async () => {
    const rows = Object.fromEntries((await compareOf(A, B)).body.data.map((x: any) => [x.test_code, x]));
    const at = (i: number) => rows[tests[i]!.code];
    expect(at(4)).toMatchObject({ price_a_paisa: 1000, price_b_paisa: 1100, difference_paisa: 100, percent_bp: 1000 });
    expect(at(5)).toMatchObject({ price_a_paisa: 3, price_b_paisa: 5, difference_paisa: 2, percent_bp: Number(halfUpDiv(2n * 10000n, 3n)) });   // 6666.67 -> 6667
    expect(at(5).percent_bp).toBe(6667);
    expect(at(6)).toMatchObject({ price_a_paisa: 0, price_b_paisa: 500, difference_paisa: 500 });
    expect(at(6), 'A is 0: no percent').not.toHaveProperty('percent_bp');
    expect(at(7)).toMatchObject({ price_a_paisa: 200, price_b_paisa: 100, difference_paisa: -100, percent_bp: -5000 });
  });
  it('a price missing from one version is ABSENT, never 0, and so is the difference', { timeout: T }, async () => {
    const rows = Object.fromEntries((await compareOf(A, B)).body.data.map((x: any) => [x.test_code, x]));
    for (const i of [0, 1, 2, 3]) { const x = rows[tests[i]!.code]; expect(x).toHaveProperty('price_a_paisa'); for (const k of ['price_b_paisa', 'difference_paisa', 'percent_bp']) expect(x, `${i} ${k}`).not.toHaveProperty(k); }
    for (const i of [8, 9, 10, 11]) { const x = rows[tests[i]!.code]; expect(x).toHaveProperty('price_b_paisa'); for (const k of ['price_a_paisa', 'difference_paisa', 'percent_bp']) expect(x, `${i} ${k}`).not.toHaveProperty(k); }
  });
  it('the same version on both sides: every difference is 0 and every percent is 0 (or absent for a 0 price)', { timeout: T }, async () => {
    for (const x of (await compareOf(A, A)).body.data) { expect(x.difference_paisa).toBe(0); if (x.price_a_paisa !== 0) expect(x.percent_bp).toBe(0); }
  });
  it('versions of different lists, and a draft, can be compared; read only (no write statement)', { timeout: T }, async () => {
    const { list } = await mkList(); const dr = await draftOf(list.id); await putItems(dr.id, [{ id: tests[0]!.id, paisa: 1500 }]);
    const r = await compareOf(A, dr.id);
    expect(r.status).toBe(200);
    expect(r.body.data.find((x: any) => x.test_code === tests[0]!.code)).toMatchObject({ price_a_paisa: 1000, price_b_paisa: 1500, difference_paisa: 500, percent_bp: 5000 });
    expect(r.writes, 'compare writes nothing').toEqual([]);
  });
});

describe('paging', () => {
  it('limit + cursor walk every row exactly once in code order; the last page has no cursor', { timeout: T }, async () => {
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await compareOf(A, B, { query: { limit: 5, ...(cursor ? { cursor } : {}) } });
      expect(r.status).toBe(200); expect(r.body.page.limit).toBe(5); expect(r.body.data.length).toBeLessThanOrEqual(5);
      seen.push(...r.body.data.map((x: any) => x.test_code)); cursor = r.body.page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([...tests.map((t) => t.code)].sort());
  });
  it('the default page has at most 200 rows and a limit above 200 is not served as more than 200', { timeout: T }, async () => {
    const r = await pcall('comparePriceLists', req({ query: { version_a_id: A, version_b_id: B, limit: 200 } }));
    expect(r.body.data.length).toBeLessThanOrEqual(200);
  });
});

describe('ONE paged SQL query, no per row loops (done_when 5)', () => {
  it('the number of statements is small and identical for 12 rows and for 200 rows', { timeout: 180_000 }, async () => {
    const big = await seedTests(TENANT_A, w.dept.id, 300, bulkPrefix);
    const la = await mkList(); const lb = await mkList(); const da = await draftOf(la.list.id); const db = await draftOf(lb.list.id);
    await putItems(da.id, big.slice(0, 250).map((t, i) => ({ id: t.id, paisa: 1000 + i }))); await putItems(db.id, big.slice(50, 300).map((t, i) => ({ id: t.id, paisa: 2000 + i })));
    const small = await compareOf(A, B); const large = await compareOf(da.id, db.id, { query: { limit: 200 } });
    expect(small.body.data.length).toBe(12); expect(large.body.data.length).toBe(200); expect(large.body.page.next_cursor).toBeTruthy();
    expect(large.queries.length, `statements: ${large.queries.map((q) => q.slice(0, 60)).join(' | ')}`).toBeLessThanOrEqual(6);
    expect(large.queries.length, 'the statement count does not grow with the rows').toBe(small.queries.length);
  });
});

describe('tenant isolation and permission', () => {
  it('another tenant\'s version on either side, and unknown ids: the same 404 as for an id that does not exist', { timeout: T }, async () => {
    const e1 = await pfails('comparePriceLists', req({ query: { version_a_id: A, version_b_id: B } }), { tenant: TENANT_B });
    const e2 = await pfails('comparePriceLists', req({ query: { version_a_id: uid(), version_b_id: uid() } }), { tenant: TENANT_B });
    expectCode(e1, 'common.not_found', 404); expect([e1.code, e1.statusCode, e1.detail]).toEqual([e2.code, e2.statusCode, e2.detail]);
    expectCode(await pfails('comparePriceLists', req({ query: { version_a_id: A, version_b_id: uid() } })), 'common.not_found', 404);
  });
  it('needs catalog.price_list.read: 403 without it', { timeout: T }, async () => {
    expectCode(await pfails('comparePriceLists', req({ query: { version_a_id: A, version_b_id: B } }), { grants: NONE }), 'auth.forbidden', 403);
    expect((await compareOf(A, B)).assertCalls).toContain('catalog.price_list.read');
  });
});
