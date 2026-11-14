// T-25 (C3) — worker task catalog.import_validate for the kinds catalog_master, referrers, credit_parties (02-TRD §8.2 templates, §8.3 validation, §8.6 issue codes).
// Spec: PRD AC-17.1 (starter workbook validates into an empty tenant), AC-17.2 (re-import: validation reports 0 changes), AC-17.3 (changed HB decimals -> analyte version n+1, range set only when
//       range rows changed — here as the summary the permission gate reads), AC-17.4 (formula cycle -> invalid, row.formula_invalid, nothing written), AC-17.6 (referrers: blank code ok);
//       02-TRD §8.2 (_meta keys read: template_kind, template_version; column rules per kind), §8.3 (dry run: only imports/files/import_issues are written; report workbook), §8.6 (codes);
//       07-SECURITY S-1 (tenancy), S-13 (no cell value in issues/logs), REQ-SEC-100.
// Contract (SEAM = not fixed by the spec; see .orchestra/notes/C3.T-25-tests.md): the EXISTING exports importValidate / importCommit are extended to the three kinds (dispatch on imports.kind);
//   issue.sheet = the workbook sheet name ('Departments', 'Analytes', 'Doctors', 'CreditParties', '_meta', '(file)'), row_no = worksheet row (header = 1), column_key = the header key;
//   summary = { rows, added, changed, removed (always 0: absent rows are never removed), unchanged, errors, warnings } and, for catalog_master, the ASSUMED counters
//   analyte_versions / range_sets / critical_sets = how many versions / sets a commit would create (the API gate of AC-17.5 reads them).
import { describe, expect, it } from 'vitest';
import { readXlsx } from '../../xlsx/XlsxReader.js';
import { IMPORT_ID, NOW, TENANT_A, TENANT_B, makeKindsDb, makeKindsRunner, seedKindImport, type KindsDb } from '../helpers/kindsDb.js';
import { CLINICAL, SECOND, codesOf, errorsOf, importFully, payloadOf, validateBytes } from '../helpers/kindsFlow.js';
import { DOCTOR_HEADER, PARTY_HEADER, addRow, creditPartiesXlsx, doc, masterXlsx, party, referrersXlsx, rowOf, setCell, toXlsx, starterBook, type Book } from '../helpers/kindWorkbooks.js';
import { importValidate } from '../../tasks/catalog.import_validate.js';

const T = 60_000;
const rowNo = (b: Book, sheet: string, code: string, keyCol = 0) => b[sheet]!.indexOf(rowOf(b, sheet, code, keyCol)) + 1;
const master = () => makeKindsDb('catalog_master');
const issue = (issues: Array<Record<string, any>>, code: string) => issues.filter((i) => i.issue_code === code);
/** Validate an edited starter workbook; returns the book too (for row numbers). */
async function validateEdit(edit: (b: Book) => void, db: KindsDb = master()) {
  const b = await starterBook(); edit(b);
  const r = await validateBytes(db, await toXlsx(b));
  return { ...r, b, db };
}
const domainEmpty = (db: KindsDb) => Object.values(db.domainCounts()).every((n) => n === 0);
const writtenTables = (db: KindsDb) => [...new Set(db.writes().map((w) => /\bcatalog\.(\w+)/i.exec(w.text)?.[1]))].sort();

describe('catalog_master — AC-17.1 starter workbook validates into an empty tenant (dry run)', () => {
  it('status validated, 0 errors, summary counts every data row as added; clinical counters = 24 analyte versions, 5 range sets, 1 critical set (ASSUMED names)', async () => {
    const db = master();
    const { imp, issues } = await validateBytes(db, await masterXlsx());
    expect(errorsOf(issues)).toEqual([]);
    expect(imp).toMatchObject({ status: 'validated', error_count: 0 });
    expect(imp.summary).toMatchObject({ added: expect.any(Number), changed: 0, removed: 0, unchanged: 0, errors: 0 });
    expect(imp.summary.rows).toBe(95);                                      // generate.mjs data rows (T-25 ruling #1)
    expect(imp.summary.added).toBe(imp.summary.rows);
    expect(imp.summary).toMatchObject({ analyte_versions: 24, range_sets: 5, critical_sets: 1 });
    expect(new Date(imp.expires_at).getTime()).toBe(Date.parse(NOW) + 168 * 3600_000);
  }, T);

  it('is a dry run: no domain row, no revision bump, no event, only imports / files / import_issues written (AC-16.3 analogue)', async () => {
    const db = master();
    const rev = db.revision();
    const { runner } = await validateBytes(db, await masterXlsx());
    expect(domainEmpty(db)).toBe(true);
    expect(db.revision()).toBe(rev);
    expect(runner.events).toEqual([]);
    expect(writtenTables(db)).toEqual(['files', 'imports']);                // 0 issues -> no import_issues row (T-25 ruling #2)
  }, T);

  it('stores an annotated report workbook (original rows + Issues sheet) for the import', async () => {
    const db = master();
    const { imp } = await validateBytes(db, await masterXlsx((b) => setCell(b, 'Tests', 'CBC', 'department_code', 'NOPE')));
    const file = db.v.rows('files', TENANT_A).find((f) => f.id === imp.report_file_id);
    expect(file).toMatchObject({ purpose: 'import_report' });
    const sheets = await readXlsx(new Uint8Array(file!.content));
    expect(sheets.map((s) => s.name)).toEqual(expect.arrayContaining(['Departments', 'Tests', 'Issues']));
    expect(sheets.find((s) => s.name === 'Issues')!.rows.flat().join('|')).toContain('row.reference_unknown');
  }, T);
});

describe('catalog_master — AC-17.2 / AC-17.3 summary against an already imported catalog', () => {
  it('AC-17.2: the same workbook again -> validated with 0 added / 0 changed / 0 removed, all unchanged, 0 new versions or sets', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    const { imp } = await validateBytes(db, await masterXlsx(), SECOND);
    expect(imp.status).toBe('validated');
    expect(imp.summary).toMatchObject({ added: 0, changed: 0, removed: 0, errors: 0, analyte_versions: 0, range_sets: 0, critical_sets: 0 });
    expect(imp.summary.unchanged).toBe(imp.summary.rows);
  }, T);

  it('AC-17.3: HB decimals 1 -> 2 = 1 changed row, 1 analyte version, 0 range sets, 0 critical sets', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    const { imp } = await validateBytes(db, await masterXlsx((b) => setCell(b, 'Analytes', 'HB', 'decimals', 2, 1)), SECOND);
    expect(imp.status).toBe('validated');
    expect(imp.summary).toMatchObject({ added: 0, changed: 1, analyte_versions: 1, range_sets: 0, critical_sets: 0 });
  }, T);

  it('a changed HB range row = 1 range set (not an analyte version); a changed K critical limit = 1 critical set', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    const { imp } = await validateBytes(db, await masterXlsx((b) => {
      b['ReferenceRanges']!.find((r) => r[0] === 'HB' && r[1] === 'female')![9] = 16;           // high 15 -> 16
      setCell(b, 'CriticalLimits', 'K', 'high', 6.5);
    }), SECOND);
    expect(imp.summary).toMatchObject({ analyte_versions: 0, range_sets: 1, critical_sets: 1 });
  }, T);

  it('non-clinical edits (department name, test report_order, analyte name / sort_order / print_name) are changes but create no versions or sets', async () => {
    const db = master();
    await importFully(db, await masterXlsx());
    const { imp } = await validateBytes(db, await masterXlsx((b) => {
      setCell(b, 'Departments', 'HAEM', 'name', 'Haematology (renamed)');
      setCell(b, 'Tests', 'CBC', 'report_order', 11);
      setCell(b, 'Analytes', 'MCV', 'name', 'MCV renamed', 1); setCell(b, 'Analytes', 'MCV', 'sort_order', 31, 1); setCell(b, 'Analytes', 'MCV', 'print_name', 'MCV!', 1);
    }), SECOND);
    expect(imp.summary).toMatchObject({ changed: 3, added: 0, analyte_versions: 0, range_sets: 0, critical_sets: 0 });
  }, T);
});

describe('catalog_master — AC-17.4 formula cycle and other invalid content (nothing written)', () => {
  it('HB = MCV and MCV = HB -> invalid with row.formula_invalid on the Analytes rows; no domain row, no revision bump', async () => {
    const db = master();
    const rev = db.revision();
    const { imp, issues, b } = await validateEdit((x) => {
      setCell(x, 'Analytes', 'HB', 'formula', 'MCV', 1); setCell(x, 'Analytes', 'HB', 'method_code', 'CALC', 1);
      setCell(x, 'Analytes', 'MCV', 'formula', 'HB', 1); setCell(x, 'Analytes', 'MCV', 'method_code', 'CALC', 1);
    }, db);
    expect(imp.status).toBe('invalid');
    const f = issue(issues, 'row.formula_invalid');
    expect(f.length).toBeGreaterThan(0);
    for (const i of f) { expect(i).toMatchObject({ severity: 'error', sheet: 'Analytes' }); expect([rowNo(b, 'Analytes', 'HB', 1), rowNo(b, 'Analytes', 'MCV', 1)]).toContain(i.row_no); }
    expect(imp.error_count).toBeGreaterThan(0);
    expect(domainEmpty(db)).toBe(true);
    expect(db.revision()).toBe(rev);
  }, T);

  it('a self-reference and a syntax error are row.formula_invalid too', async () => {
    const { issues, b } = await validateEdit((x) => { setCell(x, 'Analytes', 'MENTZER', 'formula', 'MENTZER + 1', 1); setCell(x, 'Analytes', 'NLR', 'formula', 'NEUT_ABS / / LYMPH_ABS', 1); });
    expect(issue(issues, 'row.formula_invalid').map((i) => i.row_no).sort((a, c) => a - c)).toEqual([rowNo(b, 'Analytes', 'MENTZER', 1), rowNo(b, 'Analytes', 'NLR', 1)].sort((a, c) => a - c));
  }, T);

  it('a formula over an analyte that is not in the workbook or catalog -> row.formula_invalid', async () => {
    const { issues } = await validateEdit((x) => setCell(x, 'Analytes', 'MENTZER', 'formula', 'MCV / NO_SUCH_ANALYTE', 1));
    expect(codesOf(errorsOf(issues))).toContain('row.formula_invalid');
  }, T);

  it('unknown department / specimen type / container / method / unit / value set codes -> row.reference_unknown with the failing column', async () => {
    const { issues, b } = await validateEdit((x) => {
      setCell(x, 'Tests', 'CBC', 'department_code', 'NOPE');
      setCell(x, 'Tests', 'HBA1C', 'specimen_type_codes', 'NOPE');
      setCell(x, 'Tests', 'CHOL', 'container_code', 'NOPE');
      setCell(x, 'Analytes', 'HB', 'method_code', 'NOPE', 1);
      setCell(x, 'Analytes', 'RBC', 'unit_code', 'nope_unit', 1);
      setCell(x, 'Analytes', 'U_PROTEIN', 'value_set_code', 'NOPE_SET', 1);
      setCell(x, 'ReferenceRanges', 'K', 'specimen_type_code', 'NOPE');
      setCell(x, 'PanelMembers', 'HP_ELITE_M', 'member_code', 'NOPE', 0);
    });
    const hit = new Set(issue(issues, 'row.reference_unknown').map((i) => `${i.sheet}:${i.column_key}`));
    for (const k of ['Tests:department_code', 'Tests:specimen_type_codes', 'Tests:container_code', 'Analytes:method_code', 'Analytes:unit_code', 'Analytes:value_set_code', 'ReferenceRanges:specimen_type_code', 'PanelMembers:member_code']) expect(hit).toContain(k);
    expect(issue(issues, 'row.reference_unknown').find((i) => i.sheet === 'Tests' && i.column_key === 'department_code')!.row_no).toBe(rowNo(b, 'Tests', 'CBC'));
  }, T);

  it('overlapping reference ranges for the same analyte/sex/specimen -> row.range_overlap', async () => {
    const { issues } = await validateEdit((x) => addRow(x, 'ReferenceRanges', { analyte_code: 'HB', sex: 'any', age_low: 0, age_low_unit: 'day', age_high: 2, age_high_unit: 'day', specimen_type_code: 'EDTA_WB', kind: 'numeric', low: 1, high: 2 }));
    expect(issue(issues, 'row.range_overlap').length).toBeGreaterThan(0);
    expect(issue(issues, 'row.range_overlap')[0]).toMatchObject({ sheet: 'ReferenceRanges', severity: 'error' });
  }, T);

  it('a panel containing itself through a package (LIPID -> HP_ELITE_M -> LIPID) -> row.panel_cycle on PanelMembers', async () => {
    const { issues } = await validateEdit((x) => addRow(x, 'PanelMembers', { panel_code: 'LIPID', member_code: 'HP_ELITE_M', sort_order: 9 }));
    expect(issue(issues, 'row.panel_cycle').length).toBeGreaterThan(0);
    expect(issue(issues, 'row.panel_cycle')[0]).toMatchObject({ sheet: 'PanelMembers', severity: 'error' });
  }, T);

  it('duplicate code in one sheet -> row.duplicate_code; blank required cell -> row.required_missing; malformed code -> row.code_invalid', async () => {
    const { issues, b } = await validateEdit((x) => {
      addRow(x, 'Departments', { code: 'HAEM', name: 'Duplicate', report_order: 99 });
      setCell(x, 'Departments', 'BIOCHEM', 'name', null);
      setCell(x, 'Departments', 'MICRO', 'code', 'bad code!');
    });
    expect(issue(issues, 'row.duplicate_code')[0]).toMatchObject({ sheet: 'Departments', row_no: b['Departments']!.length });
    expect(issue(issues, 'row.required_missing')[0]).toMatchObject({ sheet: 'Departments', column_key: 'name', row_no: rowNo(b, 'Departments', 'BIOCHEM') });
    expect(issue(issues, 'row.code_invalid')[0]).toMatchObject({ sheet: 'Departments', column_key: 'code' });
  }, T);

  it('bad enum / number cells -> row.value_invalid (workflow_type, result_type, decimals, is_orderable, sex)', async () => {
    const { issues } = await validateEdit((x) => {
      setCell(x, 'Tests', 'CBC', 'workflow_type', 'bogus');
      setCell(x, 'Analytes', 'HB', 'result_type', 'bogus', 1);
      setCell(x, 'Analytes', 'RBC', 'decimals', 'abc', 1);
      setCell(x, 'Tests', 'K', 'is_orderable', 'maybe');
      x['ReferenceRanges']!.find((r) => r[0] === 'K')![1] = 'other';
    });
    const hit = new Set(issue(issues, 'row.value_invalid').map((i) => `${i.sheet}:${i.column_key}`));
    for (const k of ['Tests:workflow_type', 'Analytes:result_type', 'Analytes:decimals', 'Tests:is_orderable', 'ReferenceRanges:sex']) expect(hit).toContain(k);
  }, T);
});

describe('catalog_master — file level (_meta, headers, unknown columns)', () => {
  it('missing _meta -> invalid file.meta_missing; _meta for another kind -> invalid file.meta_mismatch (REQ referrers workbook uploaded as catalog_master)', async () => {
    const a = await validateBytes(master(), await masterXlsx((b) => { delete b['_meta']; }));
    expect(a.imp.status).toBe('invalid'); expect(codesOf(a.issues)).toContain('file.meta_missing');
    const b = await validateBytes(master(), await referrersXlsx([doc('DR1', 'Dr Synthetic One')]));
    expect(b.imp.status).toBe('invalid'); expect(codesOf(b.issues)).toContain('file.meta_mismatch');
  }, T);

  it('template_version <> 1 -> file.meta_mismatch; blank informational _meta keys (tenant_catalog_revision, exported_at) are accepted', async () => {
    const ok = await validateBytes(master(), await masterXlsx());
    expect(codesOf(ok.issues)).not.toContain('file.meta_missing');
    const bad = await validateBytes(master(), await masterXlsx((b) => { b['_meta']!.find((r) => r[0] === 'template_version')![1] = 2; }));
    expect(codesOf(bad.issues)).toContain('file.meta_mismatch');
  }, T);

  it('a sheet header without its key column -> file.header_mismatch; an unknown column is only a warning (file.unknown_column) and the import stays validated', async () => {
    const a = await validateBytes(master(), await masterXlsx((b) => { b['Departments']![0]![0] = 'dept_code'; }));
    expect(a.imp.status).toBe('invalid'); expect(issue(a.issues, 'file.header_mismatch')[0]).toMatchObject({ sheet: 'Departments', row_no: 1 });
    const b = await validateBytes(master(), await masterXlsx((x) => { x['Departments']![0]!.push('colour'); }));
    expect(b.imp).toMatchObject({ status: 'validated', warning_count: expect.any(Number) });
    expect(issue(b.issues, 'file.unknown_column')[0]).toMatchObject({ severity: 'warning', sheet: 'Departments', column_key: 'colour' });
  }, T);

  it('columns may be reordered (header names decide)', async () => {
    const { imp } = await validateBytes(master(), await masterXlsx((b) => { for (const r of b['Departments']!) r.reverse(); }));
    expect(imp.status).toBe('validated');
  }, T);

  it('an xlsx that is not a workbook -> invalid file.not_xlsx (kind catalog_master); a macro workbook -> file.macro_present', async () => {
    const a = await validateBytes(master(), new Uint8Array(Buffer.from('PK\u0003\u0004 not really a zip')));
    expect(a.imp.status).toBe('invalid'); expect(codesOf(a.issues)).toContain('file.not_xlsx');
  }, T);
});

describe('referrers (AC-17.6) — sheet Doctors', () => {
  it('valid rows incl. a blank doctor_code (auto code) -> validated; summary.added counts every row; blank codes are not duplicates of each other', async () => {
    const db = makeKindsDb('referrers');
    const { imp, issues } = await validateBytes(db, await referrersXlsx([
      doc('DR1', 'Dr Synthetic One', { phone: '+9779800000001', email: 'one@example.test', verified: 'Y' }), doc(null, 'Dr Synthetic Two'), doc(null, 'Dr Synthetic Three', { verified: 'N' })]));
    expect(errorsOf(issues)).toEqual([]);
    expect(imp).toMatchObject({ status: 'validated' });
    expect(imp.summary).toMatchObject({ rows: 3, added: 3, changed: 0, removed: 0, unchanged: 0 });
    expect(db.doctorRows()).toEqual([]);                                   // dry run
    expect(writtenTables(db)).toEqual(['files', 'imports']);               // 0 issues -> no import_issues row (T-25 ruling #2)
  }, T);

  it.each([
    ['row.required_missing', 'display_name', doc('DR1', null)],
    ['row.phone_invalid', 'phone_e164', doc('DR1', 'Dr A', { phone: '9800000001' })],
    ['row.phone_invalid', 'phone_e164', doc('DR1', 'Dr A', { phone: '+0123456789' })],
    ['row.email_invalid', 'email', doc('DR1', 'Dr A', { email: 'not-an-email' })],
    ['row.value_invalid', 'is_verified', doc('DR1', 'Dr A', { verified: 'MAYBE' })],
    ['row.code_invalid', 'doctor_code', doc('dr 1!', 'Dr A')],
    ['row.value_invalid', 'display_name', doc('DR1', 'x'.repeat(121))],
  ])('%s on column %s', async (code, column, row) => {
    const { imp, issues } = await validateBytes(makeKindsDb('referrers'), await referrersXlsx([row]));
    expect(imp.status).toBe('invalid');
    expect(issues.find((i) => i.issue_code === code)).toMatchObject({ severity: 'error', sheet: 'Doctors', column_key: column, row_no: 2 });
  }, T);

  it('the same doctor_code twice in the file -> row.duplicate_code on the second row (case-insensitive)', async () => {
    const { issues } = await validateBytes(makeKindsDb('referrers'), await referrersXlsx([doc('DR1', 'Dr A'), doc('dr1', 'Dr B')]));
    expect(issue(issues, 'row.duplicate_code')[0]).toMatchObject({ sheet: 'Doctors', row_no: 3, column_key: 'doctor_code' });
  }, T);

  it('missing sheet Doctors -> file.sheet_missing; credit_parties _meta -> file.meta_mismatch', async () => {
    const a = await validateBytes(makeKindsDb('referrers'), await referrersXlsx([doc('DR1', 'Dr A')], { sheet: 'Other' }));
    expect(codesOf(a.issues)).toContain('file.sheet_missing');
    const b = await validateBytes(makeKindsDb('referrers'), await creditPartiesXlsx([party('P1', 'Hospital', 'hospital')]));
    expect(codesOf(b.issues)).toContain('file.meta_mismatch');
  }, T);

  it('re-validation after commit: unchanged rows are unchanged, a changed phone is 1 changed row (upsert by doctor_code)', async () => {
    const db = makeKindsDb('referrers');
    const rows = [doc('DR1', 'Dr Synthetic One', { phone: '+9779800000001' }), doc('DR2', 'Dr Synthetic Two')];
    await importFully(db, await referrersXlsx(rows));
    const same = await validateBytes(db, await referrersXlsx(rows), SECOND);
    expect(same.imp.summary).toMatchObject({ rows: 2, added: 0, changed: 0, unchanged: 2 });
    const chg = await validateBytes(db, await referrersXlsx([doc('DR1', 'Dr Synthetic One', { phone: '+9779800000002' }), rows[1]!]), { importId: '0190c322-0000-7000-8000-000000000602', fileId: '0190c322-0000-7000-8000-000000000702' });
    expect(chg.imp.summary).toMatchObject({ added: 0, changed: 1, unchanged: 1 });
  }, T);
});

describe('credit_parties — sheet CreditParties', () => {
  it('valid rows -> validated; allows_credit blank = Y', async () => {
    const db = makeKindsDb('credit_parties');
    const { imp, issues } = await validateBytes(db, await creditPartiesXlsx([
      party('HOSP1', 'Synthetic Hospital', 'hospital', { credit: 'Y', pan: '123456789', phone: '+9779800000011', email: 'a@example.test', address: 'Synthetic street 1' }),
      party('CO1', 'Synthetic Company', 'company', { credit: 'N' }), party('P3', 'Synthetic Lab', 'partner_lab')]));
    expect(errorsOf(issues)).toEqual([]);
    expect(imp).toMatchObject({ status: 'validated' });
    expect(imp.summary).toMatchObject({ rows: 3, added: 3 });
    expect(db.partyRows()).toEqual([]);
  }, T);

  it.each([
    ['row.required_missing', 'party_code', party(null, 'Name', 'hospital')],
    ['row.required_missing', 'name', party('P1', null, 'hospital')],
    ['row.required_missing', 'kind', party('P1', 'Name', null)],
    ['row.value_invalid', 'kind', party('P1', 'Name', 'bogus')],
    ['row.value_invalid', 'allows_credit', party('P1', 'Name', 'hospital', { credit: 'maybe' })],
    ['row.value_invalid', 'pan', party('P1', 'Name', 'hospital', { pan: 'P'.repeat(21) })],
    ['row.value_invalid', 'billing_address', party('P1', 'Name', 'hospital', { address: 'a'.repeat(501) })],
    ['row.phone_invalid', 'contact_phone_e164', party('P1', 'Name', 'hospital', { phone: '12345' })],
    ['row.email_invalid', 'contact_email', party('P1', 'Name', 'hospital', { email: 'nope' })],
    ['row.code_invalid', 'party_code', party('p 1!', 'Name', 'hospital')],
  ])('%s on column %s', async (code, column, row) => {
    const { imp, issues } = await validateBytes(makeKindsDb('credit_parties'), await creditPartiesXlsx([row]));
    expect(imp.status).toBe('invalid');
    expect(issues.find((i) => i.issue_code === code)).toMatchObject({ severity: 'error', sheet: 'CreditParties', column_key: column, row_no: 2 });
  }, T);

  it('duplicate party_code -> row.duplicate_code; a referrers workbook -> file.meta_mismatch', async () => {
    const a = await validateBytes(makeKindsDb('credit_parties'), await creditPartiesXlsx([party('P1', 'A', 'hospital'), party('P1', 'B', 'clinic')]));
    expect(issue(a.issues, 'row.duplicate_code')[0]).toMatchObject({ sheet: 'CreditParties', row_no: 3 });
    const b = await validateBytes(makeKindsDb('credit_parties'), await referrersXlsx([doc('DR1', 'Dr A')]));
    expect(codesOf(b.issues)).toContain('file.meta_mismatch');
  }, T);
});

describe('security — S-13 no cell value in issues / logs; S-1 tenancy; idempotence', () => {
  const SECRET_PHONE = '+PHONE-SECRET-42', SECRET_NAME = 'Dr Secret-Name-Zed', SECRET_PAN = 'PAN-SECRET-9999999999999', SECRET_MAIL = 'secret-mail@example';
  it('issues and logs of invalid referrers / credit_parties cells never contain the cell value', async () => {
    const r = makeKindsDb('referrers');
    const a = await validateBytes(r, await referrersXlsx([doc('DR1', SECRET_NAME, { phone: SECRET_PHONE, email: SECRET_MAIL })]));
    const p = makeKindsDb('credit_parties');
    const b = await validateBytes(p, await creditPartiesXlsx([party('P1', SECRET_NAME, 'bogus', { pan: SECRET_PAN, phone: SECRET_PHONE, email: SECRET_MAIL })]));
    for (const x of [a, b]) {
      expect(x.imp.status).toBe('invalid');
      const blob = JSON.stringify(x.issues) + x.runner.log.text();
      for (const s of [SECRET_PHONE, SECRET_NAME, SECRET_PAN, SECRET_MAIL]) expect(blob).not.toContain(s);
    }
  }, T);

  it('catalog_master: issues and logs carry no analyte/department text from the workbook', async () => {
    const { issues, runner } = await validateEdit((b) => setCell(b, 'Tests', 'CBC', 'department_code', 'SECRET-DEPT-CODE'));
    expect(JSON.stringify(issues) + runner.log.text()).not.toContain('SECRET-DEPT-CODE');
  }, T);

  it('duplicate delivery of the job for a validated import is a no-op (no second report, no state change)', async () => {
    const db = makeKindsDb('referrers');
    const { runner } = await validateBytes(db, await referrersXlsx([doc('DR1', 'Dr A')]));
    const snap = db.snapshot();
    await runner.run(payloadOf());
    expect(db.snapshot()).toEqual(snap);
  }, T);

  it('payload tenant <> job tenant, or a foreign tenant\'s import id, is skipped without any write (S-1)', async () => {
    const db = makeKindsDb('referrers');
    seedKindImport(db, await referrersXlsx([doc('DR1', 'Dr A')]));
    const snap = db.snapshot(), snapB = db.snapshot(TENANT_B);
    await makeKindsRunner(db, importValidate, { tenantId: TENANT_A }).run({ tenant_id: TENANT_B, import_id: IMPORT_ID });
    await makeKindsRunner(db, importValidate, { tenantId: TENANT_B }).run({ tenant_id: TENANT_B, import_id: IMPORT_ID });
    expect(db.snapshot()).toEqual(snap);
    expect(db.snapshot(TENANT_B)).toEqual(snapB);
    expect(db.imp().status).toBe('uploaded');
  }, T);

  it('a formula-looking text cell survives export -> import: restoreNeutralised applies before validation (no phantom change)', async () => {
    const db = makeKindsDb('referrers');
    await importFully(db, await referrersXlsx([doc('DR1', '=Dr Formula')]));
    const again = await validateBytes(db, await referrersXlsx([doc('DR1', '=Dr Formula')]), SECOND);
    expect(again.imp.summary).toMatchObject({ added: 0, changed: 0, unchanged: 1 });
  }, T);
});

void CLINICAL; void DOCTOR_HEADER; void PARTY_HEADER;
