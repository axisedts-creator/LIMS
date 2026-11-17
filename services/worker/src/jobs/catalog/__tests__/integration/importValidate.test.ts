// T-22 (C3) worker integration: catalog.import_validate for kind `price_list` — AC-16.3, AC-16.4, AC-16.5 (+ 02-TRD §8.3, §8.6, §10).
// Task under test: services/worker/src/jobs/catalog/tasks/catalog.import_validate.ts, exporting
//   IMPORT_VALIDATE = 'catalog.import_validate' and importValidate: TaskHandler (billing/tasks/*.ts pattern); payload { tenant_id, import_id }.
// ASSUMED (spec silent) — the writer may NOT change these tests, only raise a CR:
//   * row_no is the worksheet row number (header = row 1, first data row = 2); column_key is the header key; sheet is the sheet name ('Prices').
//   * import_issues.seq starts anywhere but is unique per import; `message` is template text — it never contains a cell value (05-SCHEMA §9: "no cell values stored").
//   * summary = { rows, added, changed, removed, unchanged, errors, warnings } (AC-16.3), imports.error_count/warning_count mirror errors/warnings.
//   * import.expires_at = ctx.now() + 168 h; upload file and report file expires_at = import.expires_at + 30 d; import_issues.expires_at = the same value (§8.3 step 6).
//   * the report file (purpose 'import_report') is built for every validated/invalid import (incl. file-level file.* rejections, which get an `Issues` sheet only), and imports.report_file_id points to it.
//   * metric lims_catalog_imports_total{kind:'price_list', outcome} is incremented once per terminal outcome (02-TRD §12).
//   * a duplicate row (same normalised code twice) is flagged on the second occurrence (the first may also be flagged).
//   * every statement binds tenant_id (RLS alone is not enough); validation writes nothing outside imports/files/import_issues (the fake rejects it with 42501).
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_VALIDATE, importValidate } from '../../tasks/catalog.import_validate.js';
import { IMPORT_ID, NOW, PRICE_LIST_ID, TENANT_A, TENANT_B, makeRunner, makeValidateDb, seedCatalog, seedImport, uid, type ValidateDb } from '../helpers/validateDb.js';
import { HEADER, metaFor, priceWorkbook, prow, readXlsx, sheetNamed } from '../helpers/workbooks.js';

const CAT = [
  { id: uid(1), code: 'A1' }, { id: uid(2), code: 'A2' }, { id: uid(3), code: 'A3' }, { id: uid(4), code: 'A4' },
  { id: uid(5), code: 'OLD9', is_active: false }, { id: uid(6), code: 'PNL1', kind: 'panel' as const },
];
const V3 = { version_no: 3, status: 'published' as const, items: { A1: 10000, A2: 20000, A3: 30000, A4: 40000 } };   // paise: 100.00 200.00 300.00 400.00
const H = 3600_000, D = 24 * H;
const T = (iso: string) => new Date(iso).getTime();
const EXP = T(NOW) + 168 * H;

async function setup(bytes: Uint8Array, o: { versions?: Parameters<typeof seedCatalog>[2]['versions']; status?: string } = {}) {
  const db = makeValidateDb();
  seedCatalog(db, TENANT_A, { orderables: CAT, versions: o.versions ?? [V3] });
  seedImport(db, TENANT_A, bytes, { status: o.status });
  const r = makeRunner(db, importValidate);
  return { db, r, go: () => r.run({ tenant_id: TENANT_A, import_id: IMPORT_ID }) };
}
const imp = (db: ValidateDb) => db.rows('imports', TENANT_A).find((x) => x.id === IMPORT_ID)!;
const issues = (db: ValidateDb) => db.rows('import_issues', TENANT_A).filter((x) => x.import_id === IMPORT_ID).sort((a, b) => a.seq - b.seq);
const find = (db: ValidateDb, code: string, row?: number) => issues(db).filter((i) => i.issue_code === code && (row === undefined || i.row_no === row));

beforeEach(() => { vi.stubEnv('LIMS_CORE_ENV', 'staging'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('task identity', () => {
  it('is registered under catalog.import_validate', () => {
    expect(IMPORT_VALIDATE).toBe('catalog.import_validate');
    expect(typeof importValidate).toBe('function');
  });
});

describe('AC-16.3 — upload → validated / invalid with counts, dry run', () => {
  it('0 errors → validated; counts added/changed/removed/unchanged against the latest published version; bookkeeping set', async () => {
    // base v3: A1 100, A2 200, A3 300, A4 400. File: a1 (lower-case, normalised) 100 = unchanged; A2 '250.00' (text cell) = changed; NEW row for A3 absent+A4 absent = removed 2; PNL1 50 = added.
    const bytes = await priceWorkbook([prow('a1', 100), prow('A2', '250.00'), prow('PNL1', 50)]);
    const { db, r, go } = await setup(bytes);
    await go();

    const i = imp(db);
    expect(i.status).toBe('validated');
    expect(i.summary).toEqual({ rows: 3, added: 1, changed: 1, removed: 2, unchanged: 1, errors: 0, warnings: 0 });
    expect([i.error_count, i.warning_count]).toEqual([0, 0]);
    expect(i.base_version_no).toBe(3);                                         // from _meta.base_version_no
    expect(i.validated_at).toBeInstanceOf(Date);
    expect(i.expires_at.getTime()).toBe(EXP);                                  // now + 168 h
    expect(issues(db)).toEqual([]);
    expect(find(db, 'file.stale_base')).toEqual([]);                           // base 3 == latest published 3

    // upload + report file retention = import expiry + 30 d (§8.3 step 6)
    const up = db.rows('files', TENANT_A).find((f) => f.purpose === 'import_upload')!;
    expect(up.expires_at.getTime()).toBe(EXP + 30 * D);
    const rep = db.rows('files', TENANT_A).find((f) => f.id === i.report_file_id)!;
    expect(rep.purpose).toBe('import_report');
    expect(rep.expires_at.getTime()).toBe(EXP + 30 * D);

    // exactly one scan, on the uploaded bytes, before anything else
    expect(r.scanCalls).toHaveLength(1);
    expect(Buffer.from(r.scanCalls[0]!).equals(Buffer.from(bytes))).toBe(true);
    expect(r.metrics.filter((m) => m.name === 'lims_catalog_imports_total')).toEqual([{ kind: 'inc', name: 'lims_catalog_imports_total', labels: { kind: 'price_list', outcome: 'validated' } }]);
  });

  it('invalid import increments lims_catalog_imports_total{outcome:invalid} exactly once', async () => {
    const { r, go } = await setup(await priceWorkbook([prow('ZZ9UNKNOWN', 5)]));
    await go();
    expect(r.metrics.filter((m) => m.name === 'lims_catalog_imports_total').map((m) => m.labels)).toEqual([{ kind: 'price_list', outcome: 'invalid' }]);
  });

  it('is a dry run: nothing published, no revision bump, no event; every statement binds tenant_id', async () => {
    const bytes = await priceWorkbook([prow('A1', 100), prow('A2', 999)]);
    const { db, r, go } = await setup(bytes);
    const before = { v: db.rows('price_list_versions'), it: db.rows('price_list_items'), o: db.rows('orderables') };
    await go();                                   // a write to price_list_* / orderables / catalog_state would throw (42501 / unsupported) and fail here
    expect(db.rows('price_list_versions')).toEqual(before.v);
    expect(db.rows('price_list_items')).toEqual(before.it);
    expect(db.rows('orderables')).toEqual(before.o);
    expect(r.events).toEqual([]);
    expect(db.stmts.length).toBeGreaterThan(0);
    for (const s of db.stmts) { expect(s.text).toMatch(/tenant_id/); expect(s.values).toContain(TENANT_A); }
  });

  it('≥1 error → invalid; summary and import columns match the stored issues', async () => {
    const bytes = await priceWorkbook([prow('A1', 100), prow('ZZ9UNKNOWN', 5), prow('OLD9', 7)]);
    const { db, go } = await setup(bytes);
    await go();
    const i = imp(db);
    expect(i.status).toBe('invalid');
    const errs = issues(db).filter((x) => x.severity === 'error').length, warns = issues(db).filter((x) => x.severity === 'warning').length;
    expect([errs, warns]).toEqual([1, 1]);
    expect(i.summary).toMatchObject({ rows: 3, errors: errs, warnings: warns });
    expect([i.error_count, i.warning_count]).toEqual([errs, warns]);
    expect(i.expires_at.getTime()).toBe(EXP);
    for (const x of issues(db)) expect(x.expires_at.getTime()).toBe(EXP + 30 * D);   // issues expire with the files
  });

  it('empty template (base_version_no 0, list has no published version) → every row is added', async () => {
    const bytes = await priceWorkbook([prow('A1', 100), prow('A2', 200)], { meta: metaFor({ baseVersionNo: 0 }) });
    const { db, go } = await setup(bytes, { versions: [] });
    await go();
    expect(imp(db).status).toBe('validated');
    expect(imp(db).base_version_no).toBe(0);
    expect(imp(db).summary).toMatchObject({ rows: 2, added: 2, changed: 0, removed: 0, unchanged: 0, errors: 0 });
  });

  it('informational _meta keys blank or missing are accepted (C18 hand-off, 02-TRD §8.2); only template_kind/version/price_list_id/base_version_no are read', async () => {
    const bytes = await priceWorkbook([prow('A1', 100)], { meta: [...metaFor({ informational: false }), ['price_list_code', null]] });
    const { db, go } = await setup(bytes);
    await go();
    expect(imp(db).status).toBe('validated');
    expect(issues(db).filter((x) => /^file\.meta_/.test(x.issue_code))).toEqual([]);
  });

  it('columns may be reordered; an unknown column is a warning file.unknown_column (ignored), import stays validated', async () => {
    const header = ['unit_price_npr', 'notes', 'orderable_code'];
    const bytes = await priceWorkbook([[100, 'free text', 'A1'], [250, 'x', 'A2']], { header });
    const { db, go } = await setup(bytes);
    await go();
    expect(imp(db).status).toBe('validated');
    const u = find(db, 'file.unknown_column');
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ severity: 'warning', sheet: 'Prices' });
    expect(imp(db).summary).toMatchObject({ rows: 2, changed: 1, unchanged: 1, errors: 0, warnings: 1 });
  });

  it('structure errors: missing sheet, missing required column, missing/foreign _meta → invalid with the file.* code', async () => {
    const cases: Array<[string, Uint8Array | Promise<Uint8Array>, string]> = [
      ['sheet missing', priceWorkbook([prow('A1', 1)], { sheet: 'Sheet1' }), 'file.sheet_missing'],
      ['required column missing', priceWorkbook([['A1', 'x']], { header: ['orderable_code', 'orderable_name'] }), 'file.header_mismatch'],
      ['_meta sheet absent', priceWorkbook([prow('A1', 100)], { meta: false }), 'file.meta_missing'],
      ['base_version_no absent', priceWorkbook([prow('A1', 100)], { meta: metaFor({ baseVersionNo: null }) }), 'file.meta_missing'],
      ['other price list', priceWorkbook([prow('A1', 100)], { meta: metaFor({ priceListId: uid(999) }) }), 'file.meta_mismatch'],
      ['wrong template kind', priceWorkbook([prow('A1', 100)], { meta: metaFor({ kind: 'referrers' }) }), 'file.meta_mismatch'],
    ];
    for (const [label, bytes, code] of cases) {
      const { db, go } = await setup(await bytes);
      await go();
      expect(imp(db).status, label).toBe('invalid');
      expect(find(db, code).length, label).toBeGreaterThanOrEqual(1);
      expect(find(db, code)[0]!.severity, label).toBe('error');
    }
  });
});

describe('AC-16.4 — row issues', () => {
  it('price_decimals, orderable_unknown, orderable_inactive (warning), duplicate_code, kind_mismatch, price_invalid, code_invalid, required_missing — with sheet/row/column', async () => {
    const bytes = await priceWorkbook([
      prow('A1', 100),                      // row 2 ok
      prow('A2', 12.345),                   // row 3  price_decimals @ unit_price_npr
      prow('ZZ9UNKNOWN', 5),                // row 4  orderable_unknown @ orderable_code
      prow('OLD9', 7),                      // row 5  orderable_inactive (warning)
      prow('A1', 100),                      // row 6  duplicate_code
      prow('PNL1', 50, { kind: 'test' }),   // row 7  kind_mismatch (PNL1 is a panel)
      prow('A4', -5),                       // row 8  price_invalid (negative)
      prow('A 4!', 5),                      // row 9  code_invalid
      prow('A3', null),                     // row 10 required_missing @ unit_price_npr
      prow('A3', '1,000'),                  // row 11 price_invalid (comma text) — and duplicates A3 of row 10? no: row 10 is missing → still a duplicate code occurrence
    ]);
    const { db, go } = await setup(bytes);
    await go();

    expect(imp(db).status).toBe('invalid');
    const one = (code: string, row: number) => { const f = find(db, code, row); expect(f.length, `${code}@${row}`).toBeGreaterThanOrEqual(1); return f[0]!; };
    expect(one('row.price_decimals', 3)).toMatchObject({ severity: 'error', sheet: 'Prices', column_key: 'unit_price_npr' });
    expect(one('row.orderable_unknown', 4)).toMatchObject({ severity: 'error', sheet: 'Prices', column_key: 'orderable_code' });
    expect(one('row.orderable_inactive', 5)).toMatchObject({ severity: 'warning', sheet: 'Prices', column_key: 'orderable_code' });
    expect(one('row.duplicate_code', 6)).toMatchObject({ severity: 'error', sheet: 'Prices', column_key: 'orderable_code' });
    expect(one('row.kind_mismatch', 7)).toMatchObject({ severity: 'error', sheet: 'Prices' });
    expect(one('row.price_invalid', 8)).toMatchObject({ severity: 'error', sheet: 'Prices', column_key: 'unit_price_npr' });
    expect(one('row.code_invalid', 9)).toMatchObject({ severity: 'error', sheet: 'Prices' });
    expect(one('row.required_missing', 10)).toMatchObject({ severity: 'error', sheet: 'Prices', column_key: 'unit_price_npr' });
    expect(one('row.price_invalid', 11)).toMatchObject({ severity: 'error', sheet: 'Prices', column_key: 'unit_price_npr' });
    expect(find(db, 'row.duplicate_code').every((x) => x.row_no !== 3)).toBe(true);      // A2 appears once
    for (const x of issues(db)) { expect(x.message.length).toBeGreaterThan(0); expect(x.message.length).toBeLessThanOrEqual(300); expect(x.issue_code).toMatch(/^[a-z_]+\.[a-z_]+$/); }
  });

  it('price bounds: 9,999,999.99 is accepted, 10,000,000 is price_invalid; 0 is accepted', async () => {
    const bytes = await priceWorkbook([prow('A1', 9999999.99), prow('A2', 10000000), prow('A3', 0)]);
    const { db, go } = await setup(bytes);
    await go();
    expect(find(db, 'row.price_invalid').map((x) => x.row_no)).toEqual([3]);
    expect(issues(db).filter((x) => x.severity === 'error')).toHaveLength(1);
  });

  it('a change of more than 50 % is the warning row.price_change_large (does not make the import invalid)', async () => {
    const bytes = await priceWorkbook([prow('A1', 300), prow('A2', 250)]);      // A1 100→300 (+200 %), A2 200→250 (+25 %)
    const { db, go } = await setup(bytes);
    await go();
    expect(find(db, 'row.price_change_large').map((x) => [x.row_no, x.severity])).toEqual([[2, 'warning']]);
    expect(imp(db).status).toBe('validated');
    expect(imp(db).summary).toMatchObject({ changed: 2, errors: 0, warnings: 1 });
  });

  it('issues never store cell values; logs never contain them (07 S-13, 05-SCHEMA §9)', async () => {
    const bytes = await priceWorkbook([prow('ZZ9UNKNOWN', 12.345, { name: 'Sita Karki secret-name' })]);
    const { db, r, go } = await setup(bytes);
    await go();
    const dump = JSON.stringify(issues(db));
    for (const secret of ['ZZ9UNKNOWN', '12.345', 'secret-name']) { expect(dump).not.toContain(secret); expect(r.log.text()).not.toContain(secret); }
  });

  it('a tenant sees only its own catalog: another tenant\'s code is orderable_unknown', async () => {
    const db = makeValidateDb();
    seedCatalog(db, TENANT_A, { orderables: CAT, versions: [V3] });
    seedCatalog(db, TENANT_B, { orderables: [{ id: uid(70), code: 'ONLYB' }], versions: [], priceListId: uid(501) });
    seedImport(db, TENANT_A, await priceWorkbook([prow('ONLYB', 10)]));
    await makeRunner(db, importValidate).run({ tenant_id: TENANT_A, import_id: IMPORT_ID });
    expect(find(db, 'row.orderable_unknown', 2)).toHaveLength(1);
  });

  it('caps: >20,000 rows → file.too_many_rows (invalid); >5,000 issues are truncated with the warning file.too_many_issues, all rows still counted', async () => {
    const big = await priceWorkbook(Array.from({ length: 20001 }, (_, n) => prow(`R${n}`, 1)));
    const a = await setup(big);
    await a.go();
    expect(imp(a.db).status).toBe('invalid');
    expect(find(a.db, 'file.too_many_rows').length).toBeGreaterThanOrEqual(1);

    const many = await priceWorkbook(Array.from({ length: 5100 }, (_, n) => prow(`U${String(n).padStart(5, '0')}`, 1)));
    const b = await setup(many);
    await b.go();
    expect(imp(b.db).status).toBe('invalid');
    const stored = issues(b.db);
    expect(stored.length).toBeGreaterThanOrEqual(5000);
    expect(stored.length).toBeLessThanOrEqual(5001);
    expect(find(b.db, 'file.too_many_issues')).toHaveLength(1);
    expect(find(b.db, 'file.too_many_issues')[0]!.severity).toBe('warning');
    expect(imp(b.db).summary).toMatchObject({ rows: 5100, errors: 5100 });
  }, 120_000);
});

describe('AC-16.5 — stale base', () => {
  it('list published as v4 after the export (base 3) → warning file.stale_base; still validated; compared against v4', async () => {
    const v4 = { version_no: 4, status: 'published' as const, items: { A1: 11000, A2: 20000, A3: 30000, A4: 40000 } };
    const bytes = await priceWorkbook([prow('A1', 110), prow('A2', 200), prow('A3', 300), prow('A4', 400)], { meta: metaFor({ baseVersionNo: 3 }) });
    const { db, go } = await setup(bytes, { versions: [{ ...V3, status: 'superseded' }, v4] });
    await go();
    const s = find(db, 'file.stale_base');
    expect(s).toHaveLength(1);
    expect(s[0]!.severity).toBe('warning');
    expect(imp(db).status).toBe('validated');
    expect(imp(db).base_version_no).toBe(3);                                  // the file's base, not the current one
    expect(imp(db).summary).toMatchObject({ rows: 4, unchanged: 4, changed: 0, added: 0, removed: 0, errors: 0, warnings: 1 });
  });
});

describe('crafted files are rejected as file.* issues (never parsed by the library; 07 AB-11/AB-12)', () => {
  it('macro workbook → invalid file.macro_present; random bytes → invalid file.not_xlsx', async () => {
    const { macroXlsx } = await import('../helpers/workbooks.js');
    // AC-16.10: file-level rejections still get a report file with an `Issues` sheet carrying the file.* row (no `Prices` copy: nothing was parsed)
    const reportIssues = async (db: ValidateDb) => {
      const rep = db.rows('files', TENANT_A).find((f) => f.id === imp(db).report_file_id)!;
      expect(rep).toBeTruthy();
      expect(rep.purpose).toBe('import_report');
      const list = sheetNamed(await readXlsx(rep.content), 'Issues')!;
      expect(list).toBeTruthy();
      return JSON.stringify(list.rows);
    };
    const a = await setup(macroXlsx());
    await a.go();
    expect(imp(a.db).status).toBe('invalid');
    expect(find(a.db, 'file.macro_present').length).toBeGreaterThanOrEqual(1);
    expect(await reportIssues(a.db)).toContain('file.macro_present');
    const b = await setup(new TextEncoder().encode('this is not a zip archive at all, just text'));
    await b.go();
    expect(imp(b.db).status).toBe('invalid');
    expect(find(b.db, 'file.not_xlsx').length).toBeGreaterThanOrEqual(1);
    expect(await reportIssues(b.db)).toContain('file.not_xlsx');
  });
});

describe('AC-16.3 / §8.3 — idempotent, duplicate job is a no-op', () => {
  it('running the same job twice changes nothing the second time (no second scan, no duplicate issues/files)', async () => {
    const bytes = await priceWorkbook([prow('A1', 100), prow('ZZ9UNKNOWN', 5)]);
    const { db, r, go } = await setup(bytes);
    await go();
    const snap = { i: imp(db), is: issues(db), f: db.rows('files', TENANT_A) };
    await go();                                                                // duplicate delivery
    expect(imp(db)).toEqual(snap.i);
    expect(issues(db)).toEqual(snap.is);
    expect(db.rows('files', TENANT_A)).toEqual(snap.f);
    expect(r.scanCalls).toHaveLength(1);
  });

  it.each(['validated', 'invalid', 'quarantined', 'committing', 'committed', 'commit_failed', 'discarded', 'expired', 'failed'])(
    'an import already in status %s is left untouched (success, no scan)', async (status) => {
      const { db, r, go } = await setup(await priceWorkbook([prow('A1', 100)]), { status });
      const before = imp(db);
      await go();
      expect(imp(db)).toEqual(before);
      expect(issues(db)).toEqual([]);
      expect(r.scanCalls).toHaveLength(0);
    });

  it.each(['scanning', 'validating'])('an import left in %s by a crashed attempt is resumed to a final state', async (status) => {
    const { db, go } = await setup(await priceWorkbook([prow('A1', 100)]), { status });
    await go();
    expect(imp(db).status).toBe('validated');
  });

  it('another tenant\'s import, a mismatching payload tenant and an unknown import id touch nothing', async () => {
    const db = makeValidateDb();
    seedCatalog(db, TENANT_A, { orderables: CAT, versions: [V3] });
    seedCatalog(db, TENANT_B, { orderables: [{ id: uid(70), code: 'ONLYB' }], versions: [], priceListId: uid(501) });
    seedImport(db, TENANT_B, await priceWorkbook([prow('ONLYB', 10)]), { importId: uid(601), fileId: uid(701), priceListId: uid(501) });
    const r = makeRunner(db, importValidate);                                  // ctx tenant = A
    const before = db.rows('imports', TENANT_B);
    await r.run({ tenant_id: TENANT_A, import_id: uid(601) }).catch(() => undefined);          // B's import id under A's claims
    await r.run({ tenant_id: TENANT_B, import_id: uid(601) }).catch(() => undefined);          // payload says B while the job runs as A
    await r.run({ tenant_id: TENANT_A, import_id: uid(666) }).catch(() => undefined);          // unknown
    expect(db.rows('imports', TENANT_B)).toEqual(before);
    expect(db.rows('import_issues')).toEqual([]);
    expect(db.rows('files', TENANT_B)).toHaveLength(1);
    expect(r.scanCalls).toHaveLength(0);
  });
});
