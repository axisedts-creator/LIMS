// T0B-PRICETOOLS-1 security tests (07-SECURITY S-1 tenant isolation, S-4 permission before data, REQ-SEC-083 uploads; done_when 6, 7): permission matrix over all seven operations, no file name / cell value / price in logs,
// hostile file names and SQL text in cells, many users at once, cross tenant reads of history.
import { beforeAll, describe, expect, it } from 'vitest';
import { NONE, READ, T, TENANT_A, TENANT_B, XLSX_CT, allBatches, batchRow, commitOf, compareOf, dry, draftOf, dryRun, expectCode, listSnapshot, mkList, mkTests, ownerRows, pcall, pfails, priceBook, publishedList, putItems, req, rowsFor, uid, world, type TestRef } from './helpers.js';

let tests: TestRef[];
beforeAll(async () => { tests = await mkTests(await world(TENANT_A), 6); }, T);

describe('permission matrix: every operation refuses a caller without its permission (403 auth.forbidden) and changes nothing', () => {
  it('none / read only against the five manage operations; none against the two read operations; each handler asks for the contract permission', { timeout: T }, async () => {
    const pub = await publishedList([{ id: tests[0]!.id, paisa: 1000 }]);
    const d = await dry(pub.list.id, priceBook(rowsFor(tests.slice(0, 2), () => 5)));
    const dr = await draftOf(pub.list.id); await putItems(dr.id, [{ id: tests[0]!.id, paisa: 100 }]);
    const before = await listSnapshot(pub.list.id);
    const bytes = priceBook(rowsFor(tests.slice(0, 1), () => 5));
    const manage: Array<[string, ReturnType<typeof req>]> = [
      ['downloadPriceListTemplate', req({ query: { price_list_id: pub.list.id } })],
      ['dryRunPriceListImport', req({ params: { price_list_id: pub.list.id }, headers: { 'idempotency-key': uid() }, body: { file: { filename: 'p.xlsx', mimeType: XLSX_CT, bytes } } })],
      ['commitPriceListImport', req({ params: { batch_id: d.batch.id }, headers: { 'idempotency-key': uid() }, body: { change_reason: 'x' } })],
      ['bulkUpdatePriceListDraft', req({ params: { price_list_version_id: dr.id }, headers: { 'idempotency-key': uid() }, body: { change_kind: 'percent', percent_bp: 10, rounding: 'none', scope: 'all' } })],
      ['copyPriceList', req({ params: { price_list_id: pub.list.id }, headers: { 'idempotency-key': uid() }, body: { source_price_list_version_id: pub.versionId, mode: 'replace' } })],
    ];
    for (const [op, r] of manage) for (const grants of [NONE, READ]) expectCode(await pfails(op, r, { grants }), 'auth.forbidden', 403);
    const read: Array<[string, ReturnType<typeof req>]> = [
      ['comparePriceLists', req({ query: { version_a_id: pub.versionId, version_b_id: dr.id } })],
      ['listPriceListImportBatches', req({ query: { price_list_id: pub.list.id } })],
    ];
    for (const [op, r] of read) expectCode(await pfails(op, r, { grants: NONE }), 'auth.forbidden', 403);
    expect(await listSnapshot(pub.list.id), 'a refused call changed nothing').toEqual(before);
    for (const [op, r] of manage.filter(([o]) => o === 'downloadPriceListTemplate')) expect((await pcall(op, r)).assertCalls).toContain('catalog.price_list.manage');
    expect((await compareOf(pub.versionId, dr.id)).assertCalls).toContain('catalog.price_list.read');
  });
  it('read only callers may read history and compare (read is enough), but the history shows no error rows and no file content', { timeout: T }, async () => {
    const { list } = await mkList();
    await dry(list.id, priceBook([{ code: 'NOSUCH3', price: 1 }, { code: tests[0]!.code, price: 1 }]));
    const r = await pcall('listPriceListImportBatches', req({ query: { price_list_id: list.id } }), { grants: READ });
    expect(r.status).toBe(200);
    const json = JSON.stringify(r.body);
    expect(json).not.toContain('NOSUCH3'); expect(json).not.toContain('file_ref');
  });
});

describe('no personal data in logs, hostile names and text', () => {
  it('logs of dry run, commit, bulk and copy contain no file name, no test code and no price from the file', { timeout: T }, async () => {
    const { list } = await mkList(); const NAME = 'rupa-sharma-private-prices.xlsx';
    const d = await dryRun(list.id, priceBook([{ code: tests[0]!.code, price: 123.45 }, { code: 'NOSUCH4', price: 1 }]), { name: NAME });
    expect(d.status).toBe(201);
    const logs = [...d.logs];
    const fixed = await mkList(); const fd = await dry(fixed.list.id, priceBook([{ code: tests[1]!.code, price: 123.45 }]), {});
    const c = await commitOf(fd.batch.id); logs.push(...c.logs);
    const blob = logs.join('\n');
    for (const secret of [NAME, 'rupa', 'sharma', tests[0]!.code, tests[1]!.code, 'NOSUCH4', '123.45']) expect(blob, `log contains "${secret}"`).not.toContain(secret);
  });
  it('a hostile file name (path traversal, quotes, newline) is never part of the stored file reference and does not break the batch', { timeout: T }, async () => {
    const { list } = await mkList();
    for (const name of ['../../etc/passwd.xlsx', 'a"b\r\nSet-Cookie: x=1.xlsx', '<script>alert(1)</script>.xlsx']) {
      const r = await dryRun(list.id, priceBook([{ code: tests[0]!.code, price: 1 }]), { name });
      expect(r.status, name).toBe(201);
      const ref = String((await batchRow(r.body.batch.id)).file_ref);
      expect(ref, name).not.toMatch(/\.\.|[\r\n"<>]|etc\/passwd/);
    }
  });
  it('SQL text in a test code cell is just an unknown code: no injection, the tables are intact', { timeout: T }, async () => {
    const { list } = await mkList();
    const evil = ["' OR 1=1 --", "'; DROP TABLE catalog.price_list_items; --", '" OR ""="', '\\'];
    const r = await dry(list.id, priceBook(evil.map((c) => ({ code: c, price: 1 }))));
    for (let i = 0; i < evil.length; i++) expect(r.errors.filter((e) => e.row_no === i + 2).map((e) => e.code), `row ${i + 2}`).toContain('code_not_found');
    expect((await ownerRows('information_schema.tables', `table_schema = 'catalog' AND table_name = 'price_list_items'`)).length, 'price_list_items still exists').toBe(1);
  });
});

describe('many users at once', () => {
  it('8 simultaneous dry runs of different files on one list: 8 distinct batches, no price written, no draft created', { timeout: T }, async () => {
    const { list } = await mkList();
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => dryRun(list.id, priceBook([{ code: tests[i % 6]!.code, price: 10 + i }]))));
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(new Set(res.map((r) => r.body.batch.id)).size).toBe(8);
    expect((await allBatches(list.id)).length).toBe(8);
    expect(await ownerRows('catalog.price_list_versions', 'price_list_id = $1', [list.id])).toEqual([]);
  });
  it('tenant B uploading while tenant A uploads: each tenant\'s batches stay in its own tenant', { timeout: T }, async () => {
    const a = await mkList(TENANT_A); const b = await mkList(TENANT_B); const bTests = await mkTests(await world(TENANT_B), 1);
    const [ra, rb] = await Promise.all([dryRun(a.list.id, priceBook([{ code: tests[0]!.code, price: 1 }])), dryRun(b.list.id, priceBook([{ code: bTests[0]!.code, price: 1 }]), { tenant: TENANT_B })]);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect((await batchRow(ra.body.batch.id)).tenant_id).toBe(TENANT_A);
    expect((await batchRow(rb.body.batch.id)).tenant_id).toBe(TENANT_B);
    // tenant B naming A's list gets the same 404 as an unknown list
    const e = await pfails('dryRunPriceListImport', req({ params: { price_list_id: a.list.id }, headers: { 'idempotency-key': uid() }, body: { file: { filename: 'p.xlsx', mimeType: XLSX_CT, bytes: priceBook([]) } } }), { tenant: TENANT_B });
    expectCode(e, 'common.not_found', 404);
  });
});
