// T0B-TESTIMPORT-1 (done_when 5, 6, 7) COMMIT over a real PG17 under RLS: one transaction, DRAFTS only (never published, no publish permission needed), audit + events, idempotent upload,
// atomicity (a failure at the last row leaves nothing, not even the batch status), update mode (new DRAFT versions beside the published one), expiry, If-Match, tenant isolation, permissions,
// batch history list / get / errors-file, and the import_batch table guards. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import { SHEET } from './columns.js';
import {
  T, TENANT_A, TENANT_B, MANAGE, ageBatch, analytesByTag, appTx, auditRows, batchRows, build, call, catalogRevision, changedEvents, commit, errorsOf, expectCode, fails, fresh, getBatch, im, mkAnalyte, mkTest,
  ownerRows, publishVersion, req, schemaErrors, sha, snapshot, testsByTag, uid, upload, uploadFails, validated, versionsOf, expectInvalid, type Ctx,
} from './helpers.js';
import { GOLDEN_COUNTS, golden, readWorkbook, workbook, type Data } from './xlsx.js';

let C: Ctx;
beforeAll(async () => { C = await fresh(); }, T);
const created = { tests: 2, analytes: 5, ranges: 10, panels: 1 };

/** everything the import wrote for one tag: tests, analytes, versions, range sets, critical sets (all DRAFT expected) */
async function written(tenant: string, t: string) {
  const tests = await testsByTag(tenant, t); const analytes = await analytesByTag(tenant, t); const ids = analytes.map((a: any) => a.id);
  const sets = await versionsOf(ids, 'reference_range_sets'); const crit = await versionsOf(ids, 'critical_limit_sets'); const vers = await versionsOf(ids, 'analyte_versions');
  const ranges = sets.length ? await ownerRows('catalog.reference_ranges', 'set_id = ANY($1::uuid[])', [sets.map((s: any) => s.id)]) : [];
  const limits = crit.length ? await ownerRows('catalog.critical_limits', 'set_id = ANY($1::uuid[])', [crit.map((s: any) => s.id)]) : [];
  const panels = await ownerRows('catalog.panels', 'tenant_id = $1 AND code LIKE $2', [tenant, `%${t}`]);
  const members = panels.length ? await ownerRows('catalog.panel_members', 'panel_id = ANY($1::uuid[])', [panels.map((p: any) => p.id)]) : [];
  return { tests, analytes, vers, sets, crit, ranges, limits, panels, members };
}

describe('dry run', () => {
  it('writes nothing but the batch history row (no test, analyte, panel, revision bump or event)', { timeout: T }, async () => {
    const X = await fresh(); const rev = await catalogRevision(TENANT_A);
    const r = await validated(build(X));
    expect(r.called.writes.filter((w) => !/import_batch/i.test(w)), 'every write statement targets catalog.import_batch').toEqual([]);
    expect(await snapshot(TENANT_A, X.t)).toEqual({ tests: 0, analytes: 0, panels: 0 });
    expect(await catalogRevision(TENANT_A)).toBe(rev);
  });
});

describe('commit (done_when 6)', () => {
  it('creates tests, analytes, DRAFT versions, DRAFT range and critical sets and the panel; never publishes, and needs no publish permission', { timeout: T }, async () => {
    const X = await fresh(); const rev = await catalogRevision(TENANT_A);
    const v = await validated(build(X));
    const r = await commit(v.batch, { grants: MANAGE });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(schemaErrors('CatalogImportCommitResult', r.body)).toEqual([]);
    expect(r.body.created).toEqual(created);
    expect(r.body.batch).toMatchObject({ id: v.batch.id, status: 'committed', version: 2, committed_by: expect.any(String), counts: GOLDEN_COUNTS });
    expect(r.assertCalls).toContain('catalog.test.manage');
    expect(r.assertCalls, 'the publish gate is never touched by the import').not.toContain('catalog.reference_range.publish');
    const w = await written(TENANT_A, X.t);
    expect(w.tests.map((t: any) => t.code).sort()).toEqual([X.g.codes.t1, X.g.codes.t2].sort());
    expect(w.analytes).toHaveLength(5);
    expect(w.vers).toHaveLength(5); expect(w.vers.every((x: any) => x.status === 'draft'), 'analyte versions are DRAFT').toBe(true);
    expect(w.sets).toHaveLength(5); expect(w.sets.every((x: any) => x.status === 'draft'), 'range sets are DRAFT').toBe(true);
    expect(w.ranges).toHaveLength(10);
    expect(w.crit.every((x: any) => x.status === 'draft'), 'critical sets are DRAFT').toBe(true);
    expect(w.crit, 'only glucose has critical limits (0 and 0 of TG means none)').toHaveLength(1); expect(w.limits).toHaveLength(2);
    expect(w.vers.find((x: any) => x.formula_expression)?.formula_expression).toContain(X.g.codes.tg);
    expect(w.panels).toHaveLength(1); expect(w.members).toHaveLength(2);
    expect(await catalogRevision(TENANT_A), 'catalog revision moved').toBeGreaterThan(rev);
  });
  it('the same commit with every grant (including publish) still publishes nothing', { timeout: T }, async () => {
    const X = await fresh(); const v = await validated(build(X));
    expect((await commit(v.batch)).status).toBe(201);
    const w = await written(TENANT_A, X.t);
    for (const rows of [w.vers, w.sets, w.crit]) expect(rows.every((x: any) => x.status === 'draft')).toBe(true);
  });
  it('imported tests are not orderable by themselves: no published analyte version exists, so the existing publish rules still gate ordering', { timeout: T }, async () => {
    const X = await fresh(); await commit((await validated(build(X))).batch);
    const w = await written(TENANT_A, X.t);
    expect(w.vers.filter((x: any) => x.status === 'published')).toEqual([]);
  });
  it('trimmed, NFC and control-free values are what is stored', { timeout: T }, async () => {
    const X = await fresh();
    await commit((await validated(build(X, (d) => { d[SHEET.tests]![0]!['Test Name'] = `  Café \u0007Lipid ${X.t} `; }))).batch);
    expect((await testsByTag(TENANT_A, X.t)).find((t: any) => t.code === X.g.codes.t1).name).toBe(`Café Lipid ${X.t}`);
  });
  it('audit: the batch row has an INSERT and a committed UPDATE carrying the file hash and the counts; each created test has an audit INSERT and a catalog.changed.v1 created event', { timeout: T }, async () => {
    const X = await fresh(); const bytes = build(X); const v = await validated(bytes); await commit(v.batch);
    const audit = await auditRows('import_batch', v.batch.id);
    expect(audit.map((a: any) => a.action)).toEqual(['INSERT', 'UPDATE']);
    const last = audit[1];
    expect(last.new_values).toMatchObject({ status: 'committed', file_sha256: sha(bytes), counts: GOLDEN_COUNTS });
    expect(last.changed_columns).toEqual(expect.arrayContaining(['status', 'committed_at', 'committed_by']));
    const test = (await testsByTag(TENANT_A, X.t))[0];
    expect((await auditRows('tests', test.id)).map((a: any) => a.action)).toContain('INSERT');
    expect((await changedEvents(TENANT_A, test.id)).map((e: any) => e.envelope.payload.change_kind)).toContain('created');
  });
  it('a second commit of the same batch -> 409 catalog.import_already_committed and nothing is created twice', { timeout: T }, async () => {
    const X = await fresh(); const v = await validated(build(X)); await commit(v.batch);
    expectCode(await fails('commitCatalogImport', req({ params: { batch_id: v.batch.id }, headers: { 'idempotency-key': uid(), ...im(2) }, body: { confirm: true } })), 'catalog.import_already_committed', 409);
    expect((await written(TENANT_A, X.t)).tests).toHaveLength(2);
  });
  it('two concurrent commits: exactly one wins, the tests are created once', { timeout: T }, async () => {
    const X = await fresh(); const v = await validated(build(X));
    const out = await Promise.allSettled([commit(v.batch), commit(v.batch)]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(['catalog.import_already_committed', 'common.version_conflict']).toContain(lost.reason?.code);
    const w = await written(TENANT_A, X.t); expect(w.tests).toHaveLength(2); expect(w.analytes).toHaveLength(5);
  });
  it('a rejected batch (errors) -> 409 catalog.import_has_errors; nothing is written', { timeout: T }, async () => {
    const X = await fresh(); const v = await validated(build(X, (d) => { d[SHEET.tests]![0]!['Test Name'] = ''; }));
    expect(v.batch.status).toBe('rejected');
    expectCode(await fails('commitCatalogImport', req({ params: { batch_id: v.batch.id }, headers: { 'idempotency-key': uid(), ...im(v.batch.version) }, body: { confirm: true } })), 'catalog.import_has_errors', 409);
    expect(await snapshot(TENANT_A, X.t)).toEqual({ tests: 0, analytes: 0, panels: 0 });
  });
  it('a batch older than 24 hours -> 409 catalog.import_batch_expired', { timeout: T }, async () => {
    const X = await fresh(); const v = await validated(build(X)); await ageBatch(v.batch.id);
    expectCode(await fails('commitCatalogImport', req({ params: { batch_id: v.batch.id }, headers: { 'idempotency-key': uid(), ...im(v.batch.version) }, body: { confirm: true } })), 'catalog.import_batch_expired', 409);
    expect(await snapshot(TENANT_A, X.t)).toEqual({ tests: 0, analytes: 0, panels: 0 });
  });
  it('If-Match: a wrong version -> 409 common.version_conflict; none -> 428 common.precondition_required; confirm false -> 400 /confirm; unknown batch -> 404', { timeout: T }, async () => {
    const X = await fresh(); const v = await validated(build(X)); const k = () => ({ 'idempotency-key': uid() });
    expectCode(await fails('commitCatalogImport', req({ params: { batch_id: v.batch.id }, headers: { ...k(), ...im(99) }, body: { confirm: true } })), 'common.version_conflict', 409);
    expectCode(await fails('commitCatalogImport', req({ params: { batch_id: v.batch.id }, headers: k(), body: { confirm: true } })), 'common.precondition_required', 428);
    await expectInvalid('commitCatalogImport', req({ params: { batch_id: v.batch.id }, headers: { ...k(), ...im(1) }, body: { confirm: false } }), '/confirm');
    expectCode(await fails('commitCatalogImport', req({ params: { batch_id: uid() }, headers: { ...k(), ...im(1) }, body: { confirm: true } })), 'common.not_found', 404);
    expect(await snapshot(TENANT_A, X.t)).toEqual({ tests: 0, analytes: 0, panels: 0 });
  });
});

describe('atomicity: all rows or none', () => {
  it('a conflict found only at commit time (the LAST test appears in the catalog after validation) leaves no row behind, the batch stays validated, and the revision does not move', { timeout: T }, async () => {
    const X = await fresh(); const v = await validated(build(X));
    await mkTest(X.w, { code: X.g.codes.t2 }); // someone creates the second test between validate and commit
    const before = await snapshot(TENANT_A, X.t); const rev = await catalogRevision(TENANT_A);
    expectCode(await fails('commitCatalogImport', req({ params: { batch_id: v.batch.id }, headers: { 'idempotency-key': uid(), ...im(v.batch.version) }, body: { confirm: true } })), 'catalog.code_duplicate', 409);
    expect(await snapshot(TENANT_A, X.t), 'only the test created by hand exists: no analyte, no panel, not even the first test of the file').toEqual({ ...before, tests: 1, analytes: 0, panels: 0 });
    expect(await catalogRevision(TENANT_A)).toBe(rev);
    const b = (await getBatch(v.batch.id)).body;
    expect(b).toMatchObject({ status: 'validated', version: 1 }); expect(b.committed_at).toBeUndefined();
    expect((await auditRows('import_batch', v.batch.id)).map((a: any) => a.action), 'the failed commit left no audit line').toEqual(['INSERT']);
  });
});

describe('idempotency (same file hash and mode in the same tenant returns the existing batch)', () => {
  it('uploading the same bytes twice (new Idempotency-Key each time) returns the same batch, one history row', { timeout: T }, async () => {
    const X = await fresh(); const bytes = build(X);
    const a = await validated(bytes); const b = await validated(bytes);
    expect(b.batch.id).toBe(a.batch.id);
    expect(await batchRows(TENANT_A, sha(bytes))).toHaveLength(1);
  });
  it('the other mode is another batch; after commit the same file returns the committed batch and creates nothing', { timeout: T }, async () => {
    const X = await fresh(); const bytes = build(X);
    const a = await validated(bytes); const u = await validated(bytes, { mode: 'update' });
    expect(u.batch.id).not.toBe(a.batch.id);
    await commit(a.batch);
    const again = await validated(bytes);
    expect(again.batch).toMatchObject({ id: a.batch.id, status: 'committed' });
    expect((await written(TENANT_A, X.t)).tests).toHaveLength(2);
  });
});

describe('update mode: new DRAFT versions beside the published one, never a silent overwrite', () => {
  it('an existing test and analyte keep their published version; the import adds a DRAFT version and a DRAFT range set; the batch preview says update', { timeout: T }, async () => {
    const X = await fresh();
    const test = await mkTest(X.w, { code: X.g.codes.t1 });
    const an = await mkAnalyte(X.w, test.id, { code: X.g.codes.tg }); await publishVersion(an);
    const [pub] = await versionsOf([an.id], 'analyte_versions'); expect(pub.status).toBe('published');
    const v = await validated(build(X), { mode: 'update' });
    expect(v.errors, JSON.stringify(v.errors)).toEqual([]);
    expect(v.preview.tests.find((t: any) => t.code === X.g.codes.t1).action).toBe('update');
    const r = await commit(v.batch); expect(r.status, JSON.stringify(r.body)).toBe(201);
    const vers = await versionsOf([an.id], 'analyte_versions');
    expect(vers.map((x: any) => [x.version_no, x.status])).toEqual([[1, 'published'], [2, 'draft']]);
    expect(vers[0], 'the published row is untouched').toEqual(pub);
    const w = await written(TENANT_A, X.t);
    expect(w.tests, 'no second test with the same code').toHaveLength(2); expect(w.analytes, 'the analyte is reused').toHaveLength(5);
    expect(w.sets.filter((s: any) => s.analyte_id === an.id).every((s: any) => s.status === 'draft')).toBe(true);
  });
});

describe('tenant isolation (done_when 7)', () => {
  it('another tenant cannot get, list, download the errors of, or commit a batch; its same-code workbook is independent', { timeout: T }, async () => {
    const A = await fresh(TENANT_A); const B = await fresh(TENANT_B);
    const va = await validated(build(A)); const o = { tenant: TENANT_B };
    expectCode(await fails('getCatalogImport', req({ params: { batch_id: va.batch.id } }), o), 'common.not_found', 404);
    expectCode(await fails('downloadCatalogImportErrors', req({ params: { batch_id: va.batch.id } }), o), 'common.not_found', 404);
    expectCode(await fails('commitCatalogImport', req({ params: { batch_id: va.batch.id }, headers: { 'idempotency-key': uid(), ...im(1) }, body: { confirm: true } }), o), 'common.not_found', 404);
    const list = (await call('listCatalogImports', req({ query: { limit: 200 } }), o)).body.data;
    expect(list.map((b: any) => b.id)).not.toContain(va.batch.id);
    await commit(va.batch);
    // tenant B imports the SAME test codes with its own masters: no clash with tenant A, nothing leaks
    const bytesB = workbook(golden(A.t, B.masters).data as Data, { metaChecksum: B.checksum });
    const vb = await validated(bytesB, o); expect(vb.errors, JSON.stringify(vb.errors)).toEqual([]);
    expect(vb.batch.id).not.toBe(va.batch.id);
    await commit(vb.batch, o);
    expect((await testsByTag(TENANT_A, A.t)).every((t: any) => t.tenant_id === TENANT_A)).toBe(true);
    expect(await testsByTag(TENANT_B, A.t)).toHaveLength(2);
  });
  it("tenant A's master values are unknown to tenant B (dropdowns and validation are per tenant)", { timeout: T }, async () => {
    const A = await fresh(TENANT_A);
    const r = await validated(build(A), { tenant: TENANT_B });
    expect(r.batch.status).toBe('rejected'); expect(errorsOf(r).some((e) => e.includes('|unknown_master'))).toBe(true);
  });
});

describe('permissions', () => {
  const noManage = { grants: ['catalog.test.read'] as readonly string[] };
  it('without catalog.test.manage: upload, commit, get, list, template and errors-file are all forbidden (403 auth.forbidden) and nothing is recorded', { timeout: T }, async () => {
    const X = await fresh(); const bytes = build(X); const v = await validated(build(X, (d) => { d[SHEET.tests]![0]!['Test Name'] = '=1'; }));
    expectCode(await uploadFails(bytes, noManage), 'auth.forbidden', 403);
    expect(await batchRows(TENANT_A, sha(bytes))).toHaveLength(0);
    for (const [op, r] of [
      ['commitCatalogImport', req({ params: { batch_id: v.batch.id }, headers: { 'idempotency-key': uid(), ...im(1) }, body: { confirm: true } })],
      ['getCatalogImport', req({ params: { batch_id: v.batch.id } })], ['listCatalogImports', req()], ['downloadCatalogImportTemplate', req()],
      ['downloadCatalogImportErrors', req({ params: { batch_id: v.batch.id } })],
    ] as const) expectCode(await fails(op, r, noManage), 'auth.forbidden', 403);
  });
});

describe('history: list, get, errors file', () => {
  it('listCatalogImports: newest first, status and mode filters, contract-shaped; getCatalogImport returns ETag = version', { timeout: T }, async () => {
    const X = await fresh();
    const ok = await validated(build(X)); const bad = await validated(build(X, (d) => { d[SHEET.tests]![0]!['Test Name'] = ''; }));
    const all = await call('listCatalogImports', req({ query: { limit: 200 } }));
    expect(schemaErrors('CatalogImportBatchPage', all.body)).toEqual([]);
    const ids = all.body.data.map((b: any) => b.id);
    expect(ids.indexOf(bad.batch.id)).toBeLessThan(ids.indexOf(ok.batch.id));
    const rejected = (await call('listCatalogImports', req({ query: { status: 'rejected', limit: 200 } }))).body.data;
    expect(rejected.every((b: any) => b.status === 'rejected') && rejected.some((b: any) => b.id === bad.batch.id)).toBe(true);
    expect((await call('listCatalogImports', req({ query: { mode: 'update', limit: 200 } }))).body.data.every((b: any) => b.mode === 'update')).toBe(true);
    const g = await getBatch(ok.batch.id);
    expect(schemaErrors('CatalogImportBatch', g.body)).toEqual([]); expect(g.headers?.etag).toBe('"1"');
    expect(JSON.stringify(g.body), 'the normalized payload is kept by the server, not returned').not.toContain('payload');
  });
  it('errors file: the uploaded rows with an Errors column holding each row error, as an xlsx attachment', { timeout: T }, async () => {
    const X = await fresh(); const v = await validated(build(X, (d) => { d[SHEET.tests]![1]!['Test Name'] = '@evil'; }));
    const r = await call('downloadCatalogImportErrors', req({ params: { batch_id: v.batch.id } }));
    expect(r.status).toBe(200);
    expect(String(r.headers?.['content-disposition'])).toMatch(/^attachment;.*test-import-errors\.xlsx/);
    const tests = readWorkbook(Buffer.from(r.body)).sheets.get(SHEET.tests)!;
    expect(tests.header.at(-1)).toBe('Errors');
    expect(tests.rows[1]!.at(-1)).toContain('formula_injection');
    expect(tests.rows[0]!.at(-1) ?? '').toBe('');
    expect(tests.rows[1]![0]).toBe(X.g.codes.t2);
  });
});

describe('table guards (import_batch is history)', () => {
  const sqlErr = async (sql: string, vals: unknown[]) => { try { await appTx(TENANT_A, (tx) => tx.query(sql, vals)); } catch (e: any) { return e.code as string; } return 'ok'; };
  it('lims_app cannot DELETE a batch (42501); the stored payload, hash and counts never change (23514); a committed batch is final (23514)', { timeout: T }, async () => {
    const X = await fresh(); const v = await validated(build(X)); const id = v.batch.id;
    expect(await sqlErr('DELETE FROM catalog.import_batch WHERE id = $1', [id])).toBe('42501');
    expect(await sqlErr(`UPDATE catalog.import_batch SET payload = '{}'::jsonb WHERE id = $1`, [id])).toBe('23514');
    expect(await sqlErr(`UPDATE catalog.import_batch SET file_sha256 = repeat('a', 64) WHERE id = $1`, [id])).toBe('23514');
    await commit(v.batch);
    expect(await sqlErr(`UPDATE catalog.import_batch SET status = 'expired' WHERE id = $1`, [id])).toBe('23514');
  });
});
