// T0B-TESTIMPORT-1 (done_when 5, 7) VALIDATION: one failing fixture per rule, all errors listed (sheet, row = Excel row, column, code, message), at most 1000, the dry run writes no catalog row.
// Pinned error codes (the lead may overrule; columns.ts + this file change together): required_missing, code_duplicate, code_exists, unknown_master, value_not_allowed, not_a_number, not_a_boolean,
// value_out_of_range, orphan_row, unknown_member, panel_inconsistent, unknown_parameter_reference, formula_self_reference, formula_cycle, formula_division_by_zero, formula_invalid,
// range_from_ge_to, range_overlap, normal_low_gt_high, critical_inside_normal, auto_approved_outside_normal, default_range_duplicate, workbook_empty. Golden row map (Excel rows):
// Tests 2 = lipid, 3 = glucose; Parameters 2 TG, 3 CHOL, 4 HDL, 5 VLDL(equation), 6 GLU; Reference Ranges 2-3 TG, 4-5 CHOL, 6-7 HDL, 8-9 VLDL, 10-11 GLU (male, female); Panels 2-3.
import { beforeAll, describe, expect, it } from 'vitest';
import { COLUMNS, DATA_SHEETS, SHEET, requiredLabels, type DataSheet } from './columns.js';
import { GOLDEN_COUNTS, type Row } from './xlsx.js';
import { T, TENANT_A, build, call, errorsOf, expectError, fresh, mkTest, req, snapshot, uid, upload, validated, expectInvalid, ownerRows, type Ctx } from './helpers.js';

let C: Ctx;
beforeAll(async () => { C = await fresh(); }, T);
type D = Record<DataSheet, Row[]>;
const run = (edit: (d: D, c: Ctx['g']['codes']) => void, mode?: 'create_only' | 'update') => validated(build(C, (d) => edit(d, C.g.codes)), { mode });
const TESTS = SHEET.tests, PARAMS = SHEET.params, RANGES = SHEET.ranges, PANELS = SHEET.panels;

describe('the golden workbook', () => {
  it('is clean: validated, counts, preview, and the dry run writes no catalog row (only the batch history row)', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A, C.t);
    const r = await validated(build(C));
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.called.status, 'a new batch is 201').toBe(201);
    expect(r.batch).toMatchObject({ status: 'validated', mode: 'create_only', template_version: '1', counts: GOLDEN_COUNTS, file_name: 'tests-synthetic.xlsx' });
    expect(r.batch.file_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.preview.tests.map((t: any) => [t.code, t.action, t.analytes, t.ranges])).toEqual([[C.g.codes.t1, 'create', 4, 8], [C.g.codes.t2, 'create', 1, 2]]);
    expect(await snapshot(TENANT_A, C.t), 'no catalog row from a dry run').toEqual(before);
    expect(r.called.headers?.etag ?? `"${r.batch.version}"`).toBe('"1"');
  });
  it('mode is create_only when omitted; booleans accept yes/no/true/false and real boolean cells; numbers typed as text are numbers', { timeout: T }, async () => {
    const r = await run((d) => {
      Object.assign(d[TESTS][0]!, { Popular: 'yes', 'Smart Report': 'no', NABL: true, 'Auto Approval': 'false', 'Loyalty Points': '10' });
      Object.assign(d[PARAMS][0]!, { Decimals: '2' }); d[RANGES][0]!['Normal High'] = '150.5';
    });
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.batch.mode).toBe('create_only');
  });
  it('gender Any is accepted (expanded by the server); third_gender is a valid sex', { timeout: T }, async () => {
    const r = await run((d, c) => { d[RANGES].splice(2, 2, { 'Test Code': c.t1, 'Short Name': c.chol, Sex: 'any', Kind: 'numeric', 'Age From': 0, 'Age From Unit': 'year', 'Age To': 150, 'Age To Unit': 'year', 'Normal Low': 0, 'Normal High': 200 }, { 'Test Code': c.t1, 'Short Name': c.chol, Sex: 'third_gender', Kind: 'numeric'  , 'Age From': 0, 'Age From Unit': 'year', 'Age To': 150, 'Age To Unit': 'year', 'Normal Low': 0, 'Normal High': 200 }); });
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  });
  it('critical limits 0 and 0 mean none: the golden TG row (Normal Low 0, Critical 0/0) is not a critical-inside-normal error', { timeout: T }, async () => {
    expect((await run(() => undefined)).errors).toEqual([]);
  });
  it('a workbook with headers only is rejected as workbook_empty', { timeout: T }, async () => {
    const r = await run((d) => { for (const s of DATA_SHEETS) d[s] = []; });
    expect(r.batch.status).toBe('rejected'); expect(r.errors.map((e: any) => e.code)).toContain('workbook_empty');
  });
});

describe('required cells', () => {
  const cases = DATA_SHEETS.flatMap((s) => requiredLabels(s).map((l) => [s, l] as const));
  it.each(cases)('%s / %s blank -> required_missing at row 2', { timeout: T }, async (sheet, label) => {
    const r = await run((d) => { d[sheet][0]![label] = ''; });
    expectError(r, sheet, 2, label, 'required_missing');
  });
  it('an age bound with a value but no unit -> required_missing on the unit', { timeout: T }, async () => {
    expectError(await run((d) => { d[RANGES][0]!['Age From Unit'] = ''; }), RANGES, 2, 'Age From Unit', 'required_missing');
  });
  it('a coded parameter without a value set -> required_missing on Value Set Code', { timeout: T }, async () => {
    expectError(await run((d) => { Object.assign(d[PARAMS][4]!, { 'Result Type': 'coded', 'Unit Code': '', Decimals: '' }); d[RANGES].splice(8, 2); }), PARAMS, 6, 'Value Set Code', 'required_missing');
  });
});

describe('duplicates (in the file and against the catalog)', () => {
  it('two test rows with the same code -> code_duplicate on the second', { timeout: T }, async () => {
    expectError(await run((d, c) => { d[TESTS][1]!['Test Code'] = c.t1; }), TESTS, 3, 'Test Code', 'code_duplicate');
  });
  it('the same parameter short name twice in one test -> code_duplicate', { timeout: T }, async () => {
    expectError(await run((d, c) => { d[PARAMS][1]!['Short Name'] = c.tg; d[RANGES].splice(2, 2); }), PARAMS, 3, 'Short Name', 'code_duplicate');
  });
  it('the same panel member twice -> code_duplicate', { timeout: T }, async () => {
    expectError(await run((d, c) => { d[PANELS][1]!['Member Code'] = c.t1; }), PANELS, 3, 'Member Code', 'code_duplicate');
  });
  it('create_only refuses a test code that exists in the catalog; every other row is still checked and listed', { timeout: T }, async () => {
    const X = await fresh();
    await mkTest(X.w, { code: X.g.codes.t1 });
    const r = await validated(build(X, (d) => { d[TESTS][1]!['Department Code'] = 'NOPE'; }));
    expectError(r, TESTS, 2, 'Test Code', 'code_exists'); expectError(r, TESTS, 3, 'Department Code', 'unknown_master');
  });
  it('update mode accepts the existing code and previews action update; a new code in update mode previews create', { timeout: T }, async () => {
    const X = await fresh();
    await mkTest(X.w, { code: X.g.codes.t1 });
    const r = await validated(build(X), { mode: 'update' });
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.batch.mode).toBe('update');
    expect(Object.fromEntries(r.preview.tests.map((t: any) => [t.code, t.action]))).toEqual({ [X.g.codes.t1]: 'update', [X.g.codes.t2]: 'create' });
  });
  it('a panel code that exists in the catalog -> code_exists (create_only)', { timeout: T }, async () => {
    const X = await fresh();
    const t = await mkTest(X.w);
    const p = await call('createPanel', req({ headers: { 'idempotency-key': uid() }, body: { code: X.g.codes.panel, name: 'Existing', panel_kind: 'clinical', members: [{ kind: 'test', orderable_id: t.id, sort_order: 0 }] } }), { tenant: X.w.tenant });
    expect(p.status).toBe(201);
    expectError(await validated(build(X)), PANELS, 2, 'Panel Code', 'code_exists');
  });
});

describe('masters and enums (every dropdown value must exist)', () => {
  const master: [DataSheet, string][] = [[TESTS, 'Department Code'], [TESTS, 'Category Name'], [TESTS, 'Specimen Code'], [PARAMS, 'Specimen Code'], [PARAMS, 'Unit Code'], [PARAMS, 'Method Code'], [RANGES, 'Specimen Code'], [RANGES, 'Method Code'], [PANELS, 'Department Code']];
  it.each(master)('%s / %s not in the masters -> unknown_master', { timeout: T }, async (sheet, label) => {
    expectError(await run((d) => { d[sheet][0]![label] = 'NOSUCH'; }), sheet, 2, label, 'unknown_master');
  });
  it('a unit that exists only in another tenant is unknown (unknown unit)', { timeout: T }, async () => {
    const B = await fresh('01a1a98a-ac40-7000-8000-00000000b001');
    expectError(await run((d) => { d[PARAMS][0]!['Unit Code'] = B.masters.unit; }), PARAMS, 2, 'Unit Code', 'unknown_master');
  });
  it('a list parameter naming a value set that does not exist -> unknown_master on Value Set Code', { timeout: T }, async () => {
    expectError(await run((d) => { Object.assign(d[PARAMS][4]!, { 'Result Type': 'coded', 'Value Set Code': 'NOSUCHSET', 'Unit Code': '', Decimals: '' }); d[RANGES].splice(8, 2); }), PARAMS, 6, 'Value Set Code', 'unknown_master');
  });
  it('a list parameter naming an existing value set is fine', { timeout: T }, async () => {
    const r = await run((d, c) => { Object.assign(d[PARAMS][4]!, { 'Result Type': 'coded', 'Value Set Code': C.masters.valueSet, 'Unit Code': '', Decimals: '' }); d[RANGES].splice(8, 2); void c; });
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  });
  const enums: [DataSheet, string][] = [[TESTS, 'Workflow Type'], [TESTS, 'Report Type'], [TESTS, 'Processing Type'], [PARAMS, 'Result Type'], [PARAMS, 'Result Display Type'], [RANGES, 'Sex'], [RANGES, 'Kind'], [RANGES, 'Age From Unit'], [RANGES, 'Age To Unit'], [PANELS, 'Panel Kind'], [PANELS, 'Member Kind'], [PANELS, 'Sex Restriction']];
  it.each(enums)('%s / %s outside the list -> value_not_allowed', { timeout: T }, async (sheet, label) => {
    expectError(await run((d) => { d[sheet][0]![label] = 'bogus'; }), sheet, 2, label, 'value_not_allowed');
  });
});

describe('numbers are numbers', () => {
  const bad: [DataSheet, string, string, string][] = [
    [TESTS, 'Loyalty Points', 'abc', 'not_a_number'], [TESTS, 'Display Order', '1.5', 'not_a_number'], [TESTS, 'TAT Result Minutes', 'soon', 'not_a_number'], [TESTS, 'TAT Release Minutes', '43201', 'value_out_of_range'],
    [PARAMS, 'Decimals', 'abc', 'not_a_number'], [PARAMS, 'Decimals', '9', 'value_out_of_range'], [PARAMS, 'Sort Order', 'x', 'not_a_number'],
    [RANGES, 'Normal Low', 'low', 'not_a_number'], [RANGES, 'Normal High', '1e999', 'not_a_number'], [RANGES, 'Age From', '-1', 'value_out_of_range'], [RANGES, 'Critical Low', 'n/a', 'not_a_number'],
    [PANELS, 'Loyalty Points', 'many', 'not_a_number'], [TESTS, 'Popular', 'maybe', 'not_a_boolean'],
  ];
  it.each(bad)('%s / %s = %s -> %s', { timeout: T }, async (sheet, label, value, code) => {
    expectError(await run((d) => { d[sheet][0]![label] = value; }), sheet, 2, label, code);
  });
});

describe('every row points to a parent (no orphan rows)', () => {
  it('a parameter whose test code is not on the Tests sheet -> orphan_row', { timeout: T }, async () => {
    expectError(await run((d) => { d[PARAMS][4]!['Test Code'] = 'NOSUCHTEST'; }), PARAMS, 6, 'Test Code', 'orphan_row');
  });
  it('a range whose test code is not on the Tests sheet -> orphan_row', { timeout: T }, async () => {
    expectError(await run((d) => { d[RANGES][0]!['Test Code'] = 'NOSUCHTEST'; }), RANGES, 2, 'Test Code', 'orphan_row');
  });
  it('a range whose short name is not a parameter OF THE SAME TEST (it exists under another test) -> orphan_row on Short Name', { timeout: T }, async () => {
    expectError(await run((d, c) => { d[RANGES][0]!['Short Name'] = c.glu; }), RANGES, 2, 'Short Name', 'orphan_row');
  });
  it('a panel member that is neither in the file nor in the catalog -> unknown_member', { timeout: T }, async () => {
    expectError(await run((d) => { d[PANELS][1]!['Member Code'] = 'NOSUCHMEMBER'; }), PANELS, 3, 'Member Code', 'unknown_member');
  });
  it('a panel member that is a test of the catalog (not in the file) is fine', { timeout: T }, async () => {
    const X = await fresh(); const t = await mkTest(X.w);
    const r = await validated(build(X, (d) => { d[PANELS][1]!['Member Code'] = t.code; }));
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  });
  it('two rows of one panel with different names -> panel_inconsistent on the second', { timeout: T }, async () => {
    expectError(await run((d) => { d[PANELS][1]!['Panel Name'] = 'Another name'; }), PANELS, 3, 'Panel Name', 'panel_inconsistent');
  });
});

describe('equations (same rules as T0B-TESTMGMT-1; the domain validators are reused, not copied)', () => {
  const eq = (expr: string, row = 3) => run((d) => { d[PARAMS][row - 2]!['Equation'] = expr; });
  it('a valid expression over other parameters of the same test is accepted', { timeout: T }, async () => {
    const r = await run((d, c) => { d[PARAMS][3]!['Equation'] = `(${c.tg}+${c.chol})/5-${c.hdl}*2`; });
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  });
  it('unknown parameter name -> unknown_parameter_reference', { timeout: T }, async () => expectError(await eq('NOSUCH/5', 5), PARAMS, 5, 'Equation', 'unknown_parameter_reference'));
  it('a parameter of ANOTHER test -> unknown_parameter_reference', { timeout: T }, async () => {
    expectError(await run((d, c) => { d[PARAMS][3]!['Equation'] = `${c.glu}/5`; }), PARAMS, 5, 'Equation', 'unknown_parameter_reference');
  });
  it('self reference -> formula_self_reference', { timeout: T }, async () => {
    expectError(await run((d, c) => { d[PARAMS][3]!['Equation'] = `${c.vldl}+1`; }), PARAMS, 5, 'Equation', 'formula_self_reference');
  });
  it('cycle (VLDL uses TG, TG uses VLDL) -> formula_cycle', { timeout: T }, async () => {
    const r = await run((d, c) => { d[PARAMS][0]!['Equation'] = `${c.vldl}*5`; });
    expect(errorsOf(r).filter((e) => e.endsWith('|formula_cycle')).length).toBeGreaterThanOrEqual(1);
    expect(r.batch.status).toBe('rejected');
  });
  it('division by a constant zero -> formula_division_by_zero', { timeout: T }, async () => {
    expectError(await run((d, c) => { d[PARAMS][3]!['Equation'] = `${c.tg}/0`; }), PARAMS, 5, 'Equation', 'formula_division_by_zero');
  });
  it('a syntax error -> formula_invalid (validateFormula)', { timeout: T }, async () => {
    expectError(await run((d, c) => { d[PARAMS][3]!['Equation'] = `${c.tg}//5)`; }), PARAMS, 5, 'Equation', 'formula_invalid');
  });
});

describe('reference ranges (same band rules as T0B-TESTMGMT-1 and LD-318 follow-up)', () => {
  const band = (c: Ctx['g']['codes'], o: Row): Row => ({ 'Test Code': c.t1, 'Short Name': c.chol, Sex: 'male', Kind: 'numeric', 'Age From': 0, 'Age From Unit': 'year', 'Age To': 150, 'Age To Unit': 'year', 'Normal Low': 0, 'Normal High': 200, ...o });
  const only = (rows: (c: Ctx['g']['codes']) => Row[]) => (d: D, c: Ctx['g']['codes']) => { d[RANGES].splice(2, 2, ...rows(c)); };
  it('From >= To -> range_from_ge_to on Age To', { timeout: T }, async () => {
    expectError(await run(only((c) => [band(c, { 'Age From': 10, 'Age To': 5 }), band(c, { Sex: 'female' })])), RANGES, 4, 'Age To', 'range_from_ge_to');
    expectError(await run(only((c) => [band(c, { 'Age From': 5, 'Age To': 5 }), band(c, { Sex: 'female' })])), RANGES, 4, 'Age To', 'range_from_ge_to');
  });
  it('From and To compare across units (13 month > 1 year)', { timeout: T }, async () => {
    expectError(await run(only((c) => [band(c, { 'Age From': 13, 'Age From Unit': 'month', 'Age To': 1, 'Age To Unit': 'year' }), band(c, { Sex: 'female' })])), RANGES, 4, 'Age To', 'range_from_ge_to');
  });
  it('overlapping bands of the same gender -> range_overlap (also across units: 0-1 year vs 6-24 month)', { timeout: T }, async () => {
    expectError(await run(only((c) => [band(c, { 'Age From': 0, 'Age To': 10 }), band(c, { 'Age From': 5, 'Age To': 20 }), band(c, { Sex: 'female' })])), RANGES, 5, 'Age From', 'range_overlap');
    expectError(await run(only((c) => [band(c, { 'Age To': 1 }), band(c, { 'Age From': 6, 'Age From Unit': 'month', 'Age To': 24, 'Age To Unit': 'month' }), band(c, { Sex: 'female' })])), RANGES, 5, 'Age From', 'range_overlap');
  });
  it('the same age span for different genders is NOT an overlap; bands with a gap are fine', { timeout: T }, async () => {
    const r = await run(only((c) => [band(c, { 'Age To': 1 }), band(c, { 'Age From': 2 }), band(c, { Sex: 'female' })]));
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  });
  it('Normal Low > Normal High -> normal_low_gt_high', { timeout: T }, async () => {
    expectError(await run((d) => { Object.assign(d[RANGES][0]!, { 'Normal Low': 20, 'Normal High': 10 }); }), RANGES, 2, 'Normal Low', 'normal_low_gt_high');
  });
  it('critical limits inside the normal range -> critical_inside_normal (low and high)', { timeout: T }, async () => {
    const r = await run((d) => { Object.assign(d[RANGES][8]!, { 'Critical Low': 80, 'Critical High': 100 }); });
    expectError(r, RANGES, 10, 'Critical Low', 'critical_inside_normal'); expectError(r, RANGES, 10, 'Critical High', 'critical_inside_normal');
  });
  it('critical limits outside the normal range are fine', { timeout: T }, async () => {
    expect((await run((d) => { Object.assign(d[RANGES][8]!, { 'Critical Low': 30, 'Critical High': 500 }); })).errors).toEqual([]);
  });
  it('auto approved range must lie inside the normal range -> auto_approved_outside_normal', { timeout: T }, async () => {
    expectError(await run((d) => { Object.assign(d[RANGES][8]!, { 'Auto Approved Low': 10, 'Auto Approved High': 100 }); }), RANGES, 10, 'Auto Approved Low', 'auto_approved_outside_normal');
  });
  it('two default ranges for one gender -> default_range_duplicate', { timeout: T }, async () => {
    const r = await run(only((c) => [band(c, { 'Age To': 1, 'Default Range': 'yes' }), band(c, { 'Age From': 2, 'Default Range': 'yes' }), band(c, { Sex: 'female' })]));
    expectError(r, RANGES, 5, 'Default Range', 'default_range_duplicate');
  });
});

describe('all errors are listed, at most 1000', () => {
  it('mistakes in four sheets are all reported together, each with sheet, row and column; counts.errors = the list length', { timeout: T }, async () => {
    const r = await run((d, c) => {
      d[TESTS][0]!['Test Name'] = ''; d[PARAMS][1]!['Decimals'] = 'abc'; d[RANGES][2]!['Sex'] = 'bogus'; d[PANELS][1]!['Member Code'] = 'NOSUCH'; d[PARAMS][3]!['Equation'] = `${c.tg}/0`;
    });
    for (const e of [[TESTS, 2, 'Test Name'], [PARAMS, 3, 'Decimals'], [RANGES, 4, 'Sex'], [PANELS, 3, 'Member Code'], [PARAMS, 5, 'Equation']] as const) expect(errorsOf(r).some((x) => x.startsWith(`${e[0]}|${e[1]}|${e[2]}|`)), String(e)).toBe(true);
    expect(r.errors.length).toBeGreaterThanOrEqual(5);
    expect(r.batch.counts.errors).toBe(r.errors.length);
    expect(r.preview.tests, 'a rejected batch previews nothing').toEqual([]);
  });
  it('1200 bad rows -> exactly 1000 errors kept', { timeout: 180_000 }, async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ 'Test Code': `B${i}${C.t}`, 'Department Code': C.masters.dept, 'Specimen Code': C.masters.spec, 'Workflow Type': 'standard' }));
    const r = await validated(build(C, (d) => { d[TESTS] = rows as Row[]; d[PARAMS] = []; d[RANGES] = []; d[PANELS] = []; }));
    expect(r.batch.status).toBe('rejected'); expect(r.errors).toHaveLength(1000); expect(r.batch.counts.errors).toBe(1000);
  });
});

describe('upload arguments', () => {
  const bytes = () => build(C);
  const body = (b: unknown) => req({ headers: { 'idempotency-key': uid() }, body: b });
  it('an unknown mode -> 400 /mode', { timeout: T }, async () => expectInvalid('validateCatalogImport', body({ file: { filename: 'a.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: bytes() }, mode: 'merge' }), '/mode'));
  it('no file -> 400 /file', { timeout: T }, async () => expectInvalid('validateCatalogImport', body({ mode: 'create_only' }), '/file'));
  it('a refused upload never touched the batch table of another tenant (sanity)', { timeout: T }, async () => {
    const n = (await ownerRows('catalog.import_batch', 'tenant_id <> $1', [TENANT_A])).length;
    await upload(bytes());
    expect((await ownerRows('catalog.import_batch', 'tenant_id <> $1', [TENANT_A])).length).toBe(n);
  });
  it('every column of COLUMNS is a header the parser knows: a workbook built from the pinned labels has no unknown-column error', { timeout: T }, async () => {
    expect(COLUMNS[TESTS].length).toBeGreaterThan(30);
    expect(errorsOf(await validated(build(C))).filter((e) => e.includes('unknown_column'))).toEqual([]);
  });
});
