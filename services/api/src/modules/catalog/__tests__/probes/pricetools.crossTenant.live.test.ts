// T0B-PRICETOOLS-1 cross tenant probes (07-SECURITY S-1) for the seven price tool operations, as the real handlers over a real PG17 under RLS: tenant B names tenant A's objects and must get the SAME answer
// as for an id that does not exist (404 common.not_found, never 403, never a hint), must see none of A's rows, and A's data (both new tables, the price tables, audit lines, events) stays byte-identical.
import { beforeAll, describe, expect, it } from 'vitest';
import { expectCode, pcall, pfails, req } from '../pricetools/helpers.js';
import { NEW_OPS, T, TENANT_A, TENANT_B, objs, requestFor, snapshot, uid, type Objs } from './pricetools.kit.js';

let A: Objs; let B: Objs;
beforeAll(async () => { A = await objs(TENANT_A); B = await objs(TENANT_B); }, T);

const same = (e1: any, e2: any) => expect([e1.code, e1.statusCode, e1.detail]).toEqual([e2.code, e2.statusCode, e2.detail]);

describe('operations that name one object of tenant A', () => {
  it.each(['downloadPriceListTemplate', 'dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList'])('%s: 404 identical to a made up id; A is byte-identical afterwards; the same request works for its owner', { timeout: T }, async (op) => {
    const before = await snapshot(TENANT_A);
    const e1 = await pfails(op, requestFor(op, A), { tenant: TENANT_B });
    expectCode(e1, 'common.not_found', 404);
    // the made up request: the same request with every path / query id of A replaced by a random one
    const r: any = requestFor(op, A);
    const fake = { ...r, params: Object.fromEntries(Object.keys(r.params ?? {}).map((k) => [k, uid()])), query: Object.fromEntries(Object.keys(r.query ?? {}).map((k) => [k, uid()])) };
    same(e1, await pfails(op, fake, { tenant: TENANT_B }));
    expect(await snapshot(TENANT_A)).toEqual(before);
    expect((await pcall(op, requestFor(op, A), { tenant: TENANT_A })).status).toBeLessThan(300);
  });
  it('copyPriceList into B\'s own list from A\'s version, and from B\'s version into A\'s list: 404 both ways, nothing created', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A); const beforeB = await snapshot(TENANT_B);
    const body = (v: string) => ({ source_price_list_version_id: v, mode: 'replace' });
    expectCode(await pfails('copyPriceList', req({ params: { price_list_id: B.list.id }, headers: { 'idempotency-key': uid() }, body: body(A.versionId) }), { tenant: TENANT_B }), 'common.not_found', 404);
    expectCode(await pfails('copyPriceList', req({ params: { price_list_id: A.list.id }, headers: { 'idempotency-key': uid() }, body: body(B.versionId) }), { tenant: TENANT_B }), 'common.not_found', 404);
    expect(await snapshot(TENANT_A)).toEqual(before); expect(await snapshot(TENANT_B)).toEqual(beforeB);
  });
  it('comparePriceLists with one version of each tenant: 404, no price of A is revealed', { timeout: T }, async () => {
    const e = await pfails('comparePriceLists', req({ query: { version_a_id: B.versionId, version_b_id: A.versionId } }), { tenant: TENANT_B });
    expectCode(e, 'common.not_found', 404);
    expect(JSON.stringify([e.detail, e.errors ?? []])).not.toContain(A.versionId);
  });
});

describe('listPriceListImportBatches', () => {
  it('each tenant sees only its own batches, also when it passes the other tenant\'s price_list_id; the foreign total is zero', { timeout: T }, async () => {
    const own = await pcall('listPriceListImportBatches', requestFor('listPriceListImportBatches', A), { tenant: TENANT_A });
    expect(own.body.data.map((x: any) => x.id)).toEqual(expect.arrayContaining([A.batch.id, A.badBatch.id]));
    const attack = await pcall('listPriceListImportBatches', requestFor('listPriceListImportBatches', A), { tenant: TENANT_B });
    expect(attack.status).toBe(200); expect(attack.body.data).toEqual([]);
    const all = await pcall('listPriceListImportBatches', req({ query: { limit: 200 } }), { tenant: TENANT_B });
    const ids = all.body.data.map((x: any) => x.id);
    expect(ids).not.toContain(A.batch.id); expect(ids).toContain(B.batch.id);
  });
});

describe('a rejected cross tenant call leaks nothing', () => {
  it('the problem never names the other tenant\'s ids', { timeout: T }, async () => {
    const e = await pfails('commitPriceListImport', requestFor('commitPriceListImport', A), { tenant: TENANT_B });
    expect(JSON.stringify([e.detail, e.errors ?? [], e.message])).not.toContain(A.batch.id);
  });
  it('coverage: every new operation has a probe request in the kit', () => { for (const id of NEW_OPS) expect(() => requestFor(id, A), id).not.toThrow(); });
});
