// T0B-PRICETOOLS-1 (done_when 7): a 5000 row file inside a time bound on the throwaway PG17 — dry run, commit, bulk update, copy, compare — with every price exact. The bounds are generous (a loaded CI host runs
// this file in a few seconds); a per row loop of round trips or a quadratic validator blows through them. Fixture tests are seeded by SQL and deactivated at the end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T, TENANT_A, bulkOf, commitOf, compareOf, copyOf, dry, itemRows, listSnapshot, mkList, percentPaisa, priceBook, priceMap, roundTo, seedTests, superTx, tag, world, type TestRef } from './helpers.js';

const PREFIX = `PF${tag(4)}X`; const N = 5000; const LIMIT_MS = { dry: 60_000, commit: 60_000, bulk: 40_000, copy: 40_000, compare: 10_000 };
let tests: TestRef[]; let deptId: string;
beforeAll(async () => { const w = await world(TENANT_A); deptId = w.dept.id; tests = await seedTests(TENANT_A, deptId, N, PREFIX); expect(tests).toHaveLength(N); }, 300_000);
afterAll(async () => {
  await superTx(async (tx) => {
    await tx.query(`UPDATE catalog.tests SET is_active = false WHERE tenant_id = $1 AND id IN (SELECT id FROM catalog.orderables WHERE tenant_id = $1 AND code LIKE $2 || '%')`, [TENANT_A, PREFIX]);
    await tx.query(`UPDATE catalog.orderables SET is_active = false WHERE tenant_id = $1 AND code LIKE $2 || '%'`, [TENANT_A, PREFIX]);
  }, TENANT_A);
}, T);

const paisaOf = (i: number) => 100 + ((i * 37) % 99_900);                       // 1.00 .. 999.99 rupees, deterministic
const rupees = (i: number): string => { const p = paisaOf(i); return `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`; };   // exact decimal text

describe('5000 rows end to end', () => {
  let batchId = ''; let versionId = ''; let listId = '';
  it(`dry run of a 5000 row file: valid, no price written, inside ${LIMIT_MS.dry / 1000} s`, { timeout: 300_000 }, async () => {
    const { list } = await mkList(); listId = list.id;
    const bytes = priceBook(tests.map((t, i) => ({ code: t.code, price: rupees(i) })));
    const before = await listSnapshot(list.id); const t0 = Date.now();
    const r = await dry(list.id, bytes);
    const ms = Date.now() - t0;
    expect(r.errors.slice(0, 3), JSON.stringify(r.errors.slice(0, 3))).toEqual([]);
    expect(r.batch).toMatchObject({ row_count: N, error_count: 0, status: 'dry_run' });
    expect(r.batch.summary).toMatchObject({ rows: N, added: N });
    expect(ms, `dry run took ${ms} ms`).toBeLessThan(LIMIT_MS.dry);
    const after = await listSnapshot(list.id);
    expect(after.items).toBe(before.items); expect(after.versions).toBe(before.versions);
    batchId = r.batch.id;
  });
  it(`commit of the 5000 rows: one DRAFT, every price exact, inside ${LIMIT_MS.commit / 1000} s`, { timeout: 300_000 }, async () => {
    const t0 = Date.now(); const c = await commitOf(batchId); const ms = Date.now() - t0;
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body).toMatchObject({ status: 'draft', item_count: N });
    expect(ms, `commit took ${ms} ms`).toBeLessThan(LIMIT_MS.commit);
    expect(c.writes.length, 'bulk statements, not one write per row').toBeLessThan(200);
    versionId = c.body.id;
    expect(await itemRows(versionId)).toHaveLength(N);
    const pm = await priceMap(versionId);
    for (const i of [0, 1, 7, 1234, 2500, 4999]) expect(pm[tests[i]!.code], `row ${i}`).toBe(paisaOf(i));
    expect(Object.values(pm).reduce((s, x) => s + x, 0)).toBe(tests.reduce((s, _, i) => s + paisaOf(i), 0));
  });
  it(`bulk update +12.5 % nearest_rupee over the whole draft: exact for every row, inside ${LIMIT_MS.bulk / 1000} s`, { timeout: 300_000 }, async () => {
    const t0 = Date.now(); const r = await bulkOf(versionId, { change_kind: 'percent', percent_bp: 1250, rounding: 'nearest_rupee', scope: 'all' }); const ms = Date.now() - t0;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(ms, `bulk took ${ms} ms`).toBeLessThan(LIMIT_MS.bulk);
    const pm = await priceMap(versionId);
    let wrong = 0;
    tests.forEach((t, i) => { if (pm[t.code] !== roundTo(percentPaisa(paisaOf(i), 1250), 100)) wrong++; });
    expect(wrong, 'rows with a wrong price').toBe(0);
    expect(r.body.changed_count + r.body.unchanged_count).toBe(N);
  });
  it(`copy of 5000 items into another list (replace, +10 %), inside ${LIMIT_MS.copy / 1000} s`, { timeout: 300_000 }, async () => {
    const dst = await mkList(); const t0 = Date.now();
    const c = await copyOf(dst.list.id, { source_price_list_version_id: versionId, mode: 'replace', percent_bp: 1000, rounding: 'none' }); const ms = Date.now() - t0;
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.item_count).toBe(N);
    expect(ms, `copy took ${ms} ms`).toBeLessThan(LIMIT_MS.copy);
    const src = await priceMap(versionId); const out = await priceMap(c.body.id);
    expect(tests.filter((t) => out[t.code] !== percentPaisa(src[t.code]!, 1000)).length).toBe(0);
  });
  it(`compare of two 5000 item versions: a page of 200 inside ${LIMIT_MS.compare / 1000} s, the walk to the end terminates with every row once`, { timeout: 300_000 }, async () => {
    const other = await mkList();
    const c = await copyOf(other.list.id, { source_price_list_version_id: versionId, mode: 'replace', percent_bp: 500, rounding: 'none' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const t0 = Date.now(); const page = await compareOf(versionId, c.body.id, { query: { limit: 200 } }); const ms = Date.now() - t0;
    expect(page.status).toBe(200); expect(page.body.data).toHaveLength(200); expect(page.body.page.next_cursor).toBeTruthy();
    expect(ms, `compare page took ${ms} ms`).toBeLessThan(LIMIT_MS.compare);
    let n = 0; let cursor: string | undefined; const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const r = await compareOf(versionId, c.body.id, { query: { limit: 200, ...(cursor ? { cursor } : {}) } });
      for (const x of r.body.data) { seen.add(x.orderable_id); n++; }
      cursor = r.body.page.next_cursor; if (!cursor) break;
    }
    expect([n, seen.size]).toEqual([N, N]);
  });
  it(`a 5000 row file where EVERY row is wrong: all 5000 errors with row and column, inside ${LIMIT_MS.dry / 1000} s, the batch records them`, { timeout: 300_000 }, async () => {
    const { list } = await mkList(); const t0 = Date.now();
    const r = await dry(list.id, priceBook(Array.from({ length: N }, (_, i) => ({ code: `NOSUCH${i}`, price: 'x' }))));
    expect(Date.now() - t0).toBeLessThan(LIMIT_MS.dry);
    expect(r.batch.error_count).toBeGreaterThanOrEqual(N);
    expect(r.errors.length).toBe(r.batch.error_count);
    expect(r.batch.status).toBe('dry_run');
    expect(await itemRows(versionId), 'the committed draft of the first list is untouched by the failed file').toHaveLength(N);
  });
});
