// T-24 (C3) worker integration: catalog.export_build — AC-16.2 (price-list export), AC-17.6 (referrer export, data side), 02-TRD §8.7, §10, §9.1;
// 07-SECURITY S-9 (no <f>, neutraliseFormula on every text cell, round-trip), S-13 (log scan), REQ-SEC-096/100, 08 A13 P-9/D-22.
// Task under test: services/worker/src/jobs/catalog/tasks/catalog.export_build.ts, exporting
//   EXPORT_BUILD = 'catalog.export_build' and exportBuild: TaskHandler; payload { tenant_id, export_id }.
//   All DB access via ctx.tx.query in the dialect of services/api/.../helpers/exportsDb.ts (the writer adapts the SQL, not the fake).
//   The workbook is built with the T-21 writer (xlsx/XlsxWriter.ts) in the import-template format (xlsx/templates TEMPLATE_SHEETS), so it re-imports.
// ASSUMED (spec silent) — the writer may NOT change these tests, only raise a CR:
//   * price_list rows = the items of the version in params.price_list_version_id (one row per orderable priced in it), not the whole catalog.
//     `department` cell = the orderable's department code OR name; `orderable_kind` = 'test' | 'panel'; price = unit_price_paisa / 100 as a number cell.
//   * workbook = Instructions, data sheet(s) in TEMPLATE_SHEETS order, hidden `_meta` (as templates): template_kind, template_version, tenant_catalog_revision
//     (catalog_state.catalog_revision), exported_at (= ctx.now()), and for price_list price_list_id, price_list_code, base_version_no (= the exported version_no).
//   * catalog_master: every TEMPLATE_SHEETS.catalog_master sheet is present with its exact header row; rows are asserted here only for Departments
//     (the other tables' columns are not fixed by this fixture).
//   * the REPEATABLE READ snapshot (§8.7) cannot be opened mid-transaction (the core opens the job tx and runs set_config first; ctx.db.tx reuses it).
//     Mechanism = CR (C3.T-24, reviewer item 1) — the snapshot test below is `it.todo` until the CR is ruled; assert the mechanism it defines then.
//   * export completion: exports.status 'ready', file_id -> catalog.files(purpose 'export'), exports.expires_at = files.expires_at = ctx.now() + 30 d,
//     files.sha256/byte_size match the bytes; no event, no revision bump, nothing written outside exports/files (§9.1).
//   * final attempt (ctx.attempt >= ctx.maxAttempts) with a failing build leaves exports.status 'failed' + last_error_code. ctx.db.tx reuses the job tx, so a throw
//     rolls the write back: it persists only if the handler resolves (a core final-failure hook is CR-pending, reviewer item 2).
//   * catalog_master: Tests, Analytes, Panels, PanelMembers rows come from catalog.tests/analytes(+published analyte_versions)/panels/panel_members (05-SCHEMA §3).
//   * metric lims_catalog_exports_total{kind, outcome} outcome ∈ {ready, failed} (02-TRD §12 gives the names, not the outcome values).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { EXPORT_BUILD, exportBuild } from '../../tasks/catalog.export_build.js';
import { importValidate } from '../../tasks/catalog.import_validate.js';
import { TEMPLATE_SHEETS } from '../../xlsx/templates/index.js';
import { readXlsx, type Sheet } from '../../xlsx/XlsxReader.js';
import { textRuns, unzip } from '../unit/xlsx/zipfixtures.js';
import { CAT, DAY, NAME_FORMULA, NAME_PLUS, NOW, PLANTED_DOCTORS, PLV3, PRICE_LIST_ID, SYS, TENANT_A, TENANT_B, USER, makeExportsDb, makeRunner, seedCatalog, seedDoctors, uid, type ExportsDb } from '../helpers/exportRunner.js';
import { IMPORT_ID, makeRunner as makeValidateRunner, makeValidateDb, seedCatalog as seedValidateCatalog, seedImport } from '../helpers/validateDb.js';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PLV3_B = PLV3.replace('0190c322', '0190c3b2');

function setup(o: { kind?: 'price_list' | 'catalog_master' | 'referrers'; params?: Record<string, unknown>; status?: string; doctors?: boolean } = {}) {
  const db = makeExportsDb();
  seedCatalog(db, TENANT_A);
  seedCatalog(db, TENANT_B);
  if (o.doctors) seedDoctors(db);
  const kind = o.kind ?? 'price_list';
  const e = db.seed.export(TENANT_A, { kind, status: o.status ?? 'queued', params: o.params ?? (kind === 'price_list' ? { price_list_version_id: PLV3 } : {}) });
  const r = makeRunner(db, exportBuild);
  return { db, r, e, go: (attempt?: number, max?: number) => r.run({ tenant_id: TENANT_A, export_id: e.id }, attempt, max) };
}
type Ctx = ReturnType<typeof setup>;
const exp = (c: { db: ExportsDb; e: { id: string } }) => c.db.rows('exports', TENANT_A).find((x) => x.id === c.e.id)!;
const fileOf = (c: Ctx) => { const x = exp(c); return x.file_id ? c.db.rows('files', TENANT_A).find((f) => f.id === x.file_id) : undefined; };
const bytesOf = (c: Ctx): Uint8Array => { const f = fileOf(c); expect(f, 'export file row').toBeDefined(); return new Uint8Array(f!.content); };
const sheetsOf = async (c: Ctx) => readXlsx(bytesOf(c));
const sheet = (ss: Sheet[], name: string) => { const s = ss.find((x) => x.name === name); expect(s, `sheet ${name}`).toBeDefined(); return s!; };
const metaOf = (ss: Sheet[]) => Object.fromEntries(sheet(ss, '_meta').rows.map((r) => [String(r[0]), r[1]]));
const dataRows = (s: Sheet) => s.rows.slice(1);
const asObjects = (s: Sheet) => dataRows(s).map((r) => Object.fromEntries((s.rows[0] as string[]).map((h, i) => [h, r[i] ?? null])));
const blank = (v: unknown) => v === null || v === undefined || v === '';

beforeEach(() => { vi.stubEnv('LIMS_CORE_ENV', 'staging'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('contract', () => {
  it('exports the task identifier', () => { expect(EXPORT_BUILD).toBe('catalog.export_build'); });
});

describe('AC-16.2 — price_list export of version 3', () => {
  it('Instructions + Prices + hidden _meta; Prices header = the import template header', async () => {
    const c = setup(); await c.go();
    const ss = await sheetsOf(c);
    expect(ss.map((s) => s.name)).toEqual(['Instructions', 'Prices', '_meta']);
    expect(sheet(ss, 'Prices').rows[0]).toEqual(TEMPLATE_SHEETS.price_list.Prices);
    const wb = unzip(bytesOf(c)).get('xl/workbook.xml')!;
    const tags = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0]);
    expect(tags.find((t) => /name="_meta"/.test(t))).toMatch(/state="hidden"/);
    expect(tags.filter((t) => /state="hidden"/.test(t))).toHaveLength(1);
  });

  it('one row per orderable priced in v3 — code, kind, name, department, NPR price with 2 decimals — nothing else', async () => {
    const c = setup(); await c.go();
    const rows = asObjects(sheet(await sheetsOf(c), 'Prices'));
    expect(rows.map((r) => r.orderable_code).sort()).toEqual(['A1', 'A2', 'PNL1']);        // A4 has no price in v3; draft v4 and tenant B are absent
    const by = Object.fromEntries(rows.map((r) => [r.orderable_code as string, r]));
    expect(by.A1).toMatchObject({ orderable_kind: 'test', orderable_name: 'Glucose fasting', unit_price_npr: 100 });
    expect(by.A2!.unit_price_npr).toBe(200.5);
    expect(by.PNL1).toMatchObject({ orderable_kind: 'panel', unit_price_npr: 123.45 });
    expect(['CHEM', 'Chemistry']).toContain(by.A1!.department);
    expect(['HAEM', 'Haematology']).toContain(by.PNL1!.department);
    for (const r of rows) expect(typeof r.unit_price_npr).toBe('number');                 // number cells, never text
    expect(JSON.stringify(rows)).not.toContain('TENANT-B');
    expect(JSON.stringify(rows)).not.toContain('777');                                    // draft v4 price (777.00) must not leak
  });

  it('_meta carries price_list_id and base_version_no = 3, plus the template keys and revision', async () => {
    const c = setup(); await c.go();
    const m = metaOf(await sheetsOf(c));
    expect(m).toMatchObject({ template_kind: 'price_list', template_version: 1, price_list_id: PRICE_LIST_ID, price_list_code: 'RETAIL', base_version_no: 3, exported_at: NOW });
    expect(Number(m.tenant_catalog_revision)).toBe(7);
  });

  it('export row + file row are complete: ready, 30-day expiry on both, sha/size match, purpose export', async () => {
    const c = setup(); await c.go();
    const x = exp(c), f = fileOf(c)!;
    expect(x.status).toBe('ready');
    expect(x.last_error_code ?? null).toBeNull();
    const expires = Date.parse(NOW) + 30 * DAY;
    expect(new Date(x.expires_at).getTime()).toBe(expires);
    expect(f).toMatchObject({ tenant_id: TENANT_A, purpose: 'export', content_type: XLSX_CT });
    expect(new Date(f.expires_at).getTime()).toBe(expires);
    const bytes = new Uint8Array(f.content);
    expect(f.byte_size).toBe(bytes.length);
    expect(f.sha256).toBe(sha256(bytes));
    expect(f.file_name).toMatch(/^[^\\/\u0000-\u001f]{1,200}\.xlsx$/i);
    expect([SYS, USER]).toContain(f.created_by);
    expect(Buffer.from(bytes.subarray(0, 4)).toString('hex')).toBe('504b0304');
    expect(c.r.metrics).toContainEqual({ name: 'lims_catalog_exports_total', labels: expect.objectContaining({ kind: 'price_list', outcome: 'ready' }) });
  });
});

describe('S-9 — cell typing and formula neutralisation', () => {
  it('no <f> element and no error/formula-typed cell in any part of the package', async () => {
    const c = setup(); await c.go();
    for (const [name, xml] of unzip(bytesOf(c))) if (name.startsWith('xl/')) { expect(xml, name).not.toMatch(/<f[\s>/]/); expect(xml, name).not.toMatch(/t="e"/); }
  });

  it('text cells starting with = + @ \' are written with a leading quote; no written text run starts with a formula trigger', async () => {
    const c = setup(); await c.go();
    const runs = textRuns(unzip(bytesOf(c)));
    for (const raw of [NAME_FORMULA, NAME_PLUS]) expect(runs).toContain(`'${raw}`);
    for (const t of runs) expect(t, `run ${JSON.stringify(t)}`).not.toMatch(/^[=+\-@\t\r]/);
  });

  it('reading back + restoreNeutralised gives the original catalog text', async () => {
    const c = setup(); await c.go();
    const by = Object.fromEntries(asObjects(sheet(await sheetsOf(c), 'Prices')).map((r) => [r.orderable_code as string, r]));
    expect(by.A2!.orderable_name).toBe(NAME_FORMULA);
    expect(by.PNL1!.orderable_name).toBe(NAME_PLUS);
    expect(by.A1!.orderable_name).toBe('Glucose fasting');
  });

  it('export → import round trip: the T-22 validator reports 0 changes, 0 errors, 0 warnings, nothing added or removed', async () => {
    const c = setup(); await c.go();
    const vdb = makeValidateDb();
    seedValidateCatalog(vdb, TENANT_A, {
      orderables: CAT.map((o) => ({ id: o.id, code: o.code, kind: o.kind, name: o.name })),
      versions: [{ version_no: 3, status: 'published', items: Object.fromEntries(CAT.filter((o) => o.paise !== null).map((o) => [o.code, o.paise!])) }],
    });
    seedImport(vdb, TENANT_A, bytesOf(c));
    await makeValidateRunner(vdb, importValidate).run({ tenant_id: TENANT_A, import_id: IMPORT_ID });
    const imp = vdb.rows('imports', TENANT_A).find((x) => x.id === IMPORT_ID)!;
    expect(imp.status).toBe('validated');
    expect(imp.summary).toEqual({ rows: 3, added: 0, changed: 0, removed: 0, unchanged: 3, errors: 0, warnings: 0 });
  });
});

describe('REPEATABLE READ snapshot (§8.7)', () => {
  // [CR-pending] C3.T-24 reviewer item 1: `SET TRANSACTION ISOLATION LEVEL` mid-tx is rejected by Postgres (25001); the core has no per-task isolation option.
  // Intended assertion once the CR defines the mechanism: a price + name change committed by another session during the export (c.db.onRead, n === 1 →
  // c.db.update('price_list_items'…{unit_price_paisa: 99900}) and c.db.update('orderables'…{name: 'CHANGED-MID-EXPORT'})) is invisible: A1 stays 100 / 'Glucose fasting'.
  it.todo('a concurrent price + name change committed mid-export is invisible: the file is one consistent snapshot [CR-pending: isolation mechanism]');
});

describe('AC-17.6 (data side) — referrers export', () => {
  it('Instructions + Doctors + _meta(template_kind referrers); header = template header; contacts present', async () => {
    const c = setup({ kind: 'referrers', doctors: true }); await c.go();
    const ss = await sheetsOf(c);
    expect(ss.map((s) => s.name)).toEqual(['Instructions', 'Doctors', '_meta']);
    expect(sheet(ss, 'Doctors').rows[0]).toEqual(TEMPLATE_SHEETS.referrers.Doctors);
    const m = metaOf(ss);
    expect(m).toMatchObject({ template_kind: 'referrers', template_version: 1, exported_at: NOW });
    expect(m.price_list_id).toBeUndefined();
    const by = Object.fromEntries(asObjects(sheet(ss, 'Doctors')).map((r) => [r.doctor_code as string, r]));
    expect(Object.keys(by).sort()).toEqual(['DR1', 'DR2']);                              // tenant B's doctor is absent
    expect(by.DR1).toMatchObject({ qualification: 'MD General Medicine', registration_council: 'NMC', registration_no: '12345', phone_e164: '+9779800000001', email: 'dr1@example.test' });
    expect(by.DR2).toMatchObject({ display_name: 'Dr. Sita Example' });
    for (const k of ['qualification', 'registration_council', 'registration_no', 'phone_e164', 'email']) expect(blank(by.DR2![k]), k).toBe(true);
    expect(JSON.stringify(ss)).not.toContain('TENANT-B');
  });

  it('a doctor name that looks like a formula is neutralised and restores to the original; no <f>', async () => {
    const c = setup({ kind: 'referrers', doctors: true }); await c.go();
    const dr1 = asObjects(sheet(await sheetsOf(c), 'Doctors')).find((r) => r.doctor_code === 'DR1')!;
    expect(dr1.display_name).toBe(PLANTED_DOCTORS[0]!.display_name);
    for (const [name, xml] of unzip(bytesOf(c))) if (name.startsWith('xl/')) expect(xml, name).not.toMatch(/<f[\s>/]/);
  });

  it('doctor contacts, names and notes never reach the logs (S-13)', async () => {
    const c = setup({ kind: 'referrers', doctors: true }); await c.go();
    const text = c.r.log.text();
    for (const secret of ['+9779800000001', 'dr1@example.test', 'Dr. Sita Example', 'cmd|calc', 'PLANTED-NOTE-1']) expect(text, secret).not.toContain(secret);
    expect(c.r.metrics).toContainEqual({ name: 'lims_catalog_exports_total', labels: expect.objectContaining({ kind: 'referrers', outcome: 'ready' }) });
  });
});

describe('catalog_master export (D-22: P0 master data)', () => {
  it('every template sheet in order with its exact header; Departments rows from the catalog; tenant B absent', async () => {
    const c = setup({ kind: 'catalog_master' }); await c.go();
    const ss = await sheetsOf(c);
    expect(ss.map((s) => s.name)).toEqual(['Instructions', ...Object.keys(TEMPLATE_SHEETS.catalog_master), '_meta']);
    for (const [name, cols] of Object.entries(TEMPLATE_SHEETS.catalog_master)) expect(sheet(ss, name).rows[0], name).toEqual(cols);
    expect(metaOf(ss)).toMatchObject({ template_kind: 'catalog_master', template_version: 1 });
    const depts = asObjects(sheet(ss, 'Departments'));
    expect(depts.map((d) => d.code).sort()).toEqual(['CHEM', 'HAEM']);
    expect(depts.find((d) => d.code === 'CHEM')).toMatchObject({ name: 'Chemistry', report_order: 10, report_heading: 'Clinical chemistry' });
    expect(blank(depts.find((d) => d.code === 'HAEM')!.report_heading)).toBe(true);
    expect(JSON.stringify(ss)).not.toContain('TENANT-B');
    for (const [name, xml] of unzip(bytesOf(c))) if (name.startsWith('xl/')) expect(xml, name).not.toMatch(/<f[\s>/]/);
  });
});

describe('catalog_master export — Tests, Analytes, Panels, PanelMembers are filled, not header-only (02-TRD §8.7 round-trip)', () => {
  const AN = uid(31), ANV = uid(32), STAMP = { version: 1, is_active: true, created_at: new Date(NOW), created_by: USER, updated_at: new Date(NOW), updated_by: USER };
  const seedMaster = (db: ExportsDb) => {
    for (const t of [TENANT_A, TENANT_B]) {
      const b = t === TENANT_B, id = (x: string) => (b ? x.replace('0190c322', '0190c3b2') : x);
      db.seed.rows('tests', { id: id(CAT[0].id), tenant_id: t, kind: 'test', workflow_type: 'standard', report_order: 30, uses_existing_material: false, ...STAMP });
      db.seed.rows('analytes', { id: id(AN), tenant_id: t, test_id: id(CAT[0].id), code: b ? 'B_GLU' : 'GLU', name: b ? 'TENANT-B analyte' : 'Glucose', print_name: null, report_subheading: null, sort_order: 10, is_reportable: true, ...STAMP });
      db.seed.rows('analyte_versions', { id: id(ANV), tenant_id: t, analyte_id: id(AN), version_no: 1, status: 'published', result_type: 'numeric', unit_code: 'mg_dl', decimals: 1,
        method_id: null, value_set_code: null, formula_expression: null, formula_inputs: [], formula_input_units: null, ...STAMP });
      db.seed.rows('panels', { id: id(CAT[2].id), tenant_id: t, kind: 'panel', panel_kind: 'clinical', ...STAMP });
      db.seed.rows('panel_members', { tenant_id: t, panel_id: id(CAT[2].id), member_orderable_id: id(CAT[0].id), sort_order: 1, created_at: new Date(NOW), created_by: USER });
    }
  };

  it('a seeded Test, Analyte, Panel and PanelMember come back with their codes; tenant B absent; no <f>', async () => {
    const c = setup({ kind: 'catalog_master' }); seedMaster(c.db); await c.go();
    expect(exp(c).status).toBe('ready');
    const ss = await sheetsOf(c);
    const tests = asObjects(sheet(ss, 'Tests'));
    expect(tests.find((r) => r.code === 'A1')).toMatchObject({ name: 'Glucose fasting', department_code: 'CHEM', workflow_type: 'standard', report_order: 30 });
    const analytes = asObjects(sheet(ss, 'Analytes'));
    expect(analytes).toHaveLength(1);
    expect(analytes[0]).toMatchObject({ test_code: 'A1', analyte_code: 'GLU', name: 'Glucose', sort_order: 10, result_type: 'numeric', unit_code: 'mg_dl', decimals: 1 });
    const panels = asObjects(sheet(ss, 'Panels'));
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ code: 'PNL1', panel_kind: 'clinical', department_code: 'HAEM' });
    expect(asObjects(sheet(ss, 'PanelMembers'))).toEqual([expect.objectContaining({ panel_code: 'PNL1', member_code: 'A1', sort_order: 1 })]);
    expect(JSON.stringify(ss)).not.toContain('TENANT-B');
    expect(JSON.stringify(ss)).not.toContain('B-A1');
    for (const [name, xml] of unzip(bytesOf(c))) if (name.startsWith('xl/')) expect(xml, name).not.toMatch(/<f[\s>/]/);
  });
});

describe('state machine, idempotency, isolation', () => {
  it('`building` (crashed earlier attempt) is resumed and completed', async () => {
    const c = setup({ status: 'building' }); await c.go();
    expect(exp(c).status).toBe('ready');
    expect(c.db.rows('files', TENANT_A)).toHaveLength(1);
  });

  it('duplicate delivery after success is a no-op: same file, no second build', async () => {
    const c = setup(); await c.go();
    const first = exp(c); const files = c.db.rows('files', TENANT_A);
    const writesBefore = c.db.writes().length;
    await c.go();
    expect(exp(c)).toEqual(first);
    expect(c.db.rows('files', TENANT_A)).toEqual(files);
    expect(c.db.writes().length).toBe(writesBefore);
  });

  it.each(['ready', 'failed', 'expired'])('export already %s: no-op (no file, no write)', async (status) => {
    const c = setup({ status });
    const before = exp(c);
    await c.go();
    expect(exp(c)).toEqual(before);
    expect(c.db.rows('files', TENANT_A)).toHaveLength(0);
    expect(c.db.writes()).toHaveLength(0);
  });

  it('unknown export id, malformed id, or payload tenant ≠ job tenant: no-op, nothing written', async () => {
    const c = setup();
    await c.r.run({ tenant_id: TENANT_A, export_id: uid(7777) });
    await c.r.run({ tenant_id: TENANT_A, export_id: 'not-a-uuid' });
    await c.r.run({ tenant_id: TENANT_B, export_id: c.e.id });
    await c.r.run({ tenant_id: TENANT_A });
    expect(c.db.writes()).toHaveLength(0);
    expect(exp(c).status).toBe('queued');
  });

  it("tenant B's export id in a tenant A job does nothing (RLS + explicit tenant_id)", async () => {
    const c = setup();
    const b = c.db.seed.export(TENANT_B, { kind: 'catalog_master' });
    await c.r.run({ tenant_id: TENANT_A, export_id: b.id });
    expect(c.db.rows('exports', TENANT_B).find((x) => x.id === b.id)!.status).toBe('queued');
    expect(c.db.rows('files')).toHaveLength(0);
  });

  it("a price-list version of tenant B in tenant A's export params never produces tenant B data", async () => {
    const c = setup({ params: { price_list_version_id: PLV3_B } });
    await c.go(3, 3).catch(() => undefined);                                              // final attempt: resolves or throws, both fine
    expect(exp(c).status).toBe('failed');
    expect(c.db.rows('files')).toHaveLength(0);
    expect(c.db.rows('exports', TENANT_A).find((x) => x.id === c.e.id)!.last_error_code).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it('every statement binds the tenant id; only exports/files are written; no event, no revision bump', async () => {
    const c = setup({ kind: 'referrers', doctors: true }); await c.go();
    for (const s of c.db.stmts) expect(s.values, s.text.slice(0, 80)).toContain(TENANT_A);
    for (const s of c.db.stmts) if (/^\s*(INSERT|UPDATE)\b/i.test(s.text)) expect(s.text, s.text.slice(0, 80)).toMatch(/\bcatalog\.(exports|files)\b/);
    expect(c.db.stmts.some((s) => /enqueue_job/i.test(s.text))).toBe(false);
    expect(c.r.events).toHaveLength(0);
    expect(c.db.rows('catalog_state', TENANT_A)[0]!.catalog_revision).toBe(7);
  });
});

describe('failure handling (final-attempt handler, 02-TRD §10)', () => {
  it('a failing read before the final attempt rethrows and leaves no file and no `ready` export', async () => {
    const c = setup();
    c.db.fail(/price_list_items/i);
    await expect(c.go(1, 3)).rejects.toBeDefined();
    expect(exp(c).status).not.toBe('ready');
    expect(exp(c).status).not.toBe('failed');                                              // retries remain
    expect(c.db.rows('files', TENANT_A)).toHaveLength(0);
  });

  it('the final attempt leaves status `failed` with last_error_code (common.internal for a plain error), no file', async () => {
    const c = setup();
    c.db.fail(/price_list_items/i);
    await c.go(3, 3).catch(() => undefined);
    expect(exp(c).status).toBe('failed');
    expect(exp(c).last_error_code).toBe('common.internal');
    expect(exp(c).file_id ?? null).toBeNull();
    expect(c.db.rows('files', TENANT_A)).toHaveLength(0);
    expect(c.r.metrics).toContainEqual({ name: 'lims_catalog_exports_total', labels: expect.objectContaining({ kind: 'price_list', outcome: 'failed' }) });
  });

  it('error text with data is not logged (injected error carrying a doctor phone number)', async () => {
    const c = setup({ kind: 'referrers', doctors: true });
    c.db.fail(/doctors/i, () => new Error('boom +9779800000001 dr1@example.test'));
    await c.go(3, 3).catch(() => undefined);
    expect(c.r.log.text()).not.toContain('+9779800000001');
    expect(c.r.log.text()).not.toContain('dr1@example.test');
  });
});
