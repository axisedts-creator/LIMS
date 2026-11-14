// T-21 (C3) — XlsxWriter wrapper + import templates (02-TRD §8.2 guard + templates, §3.1 deps; 07-SECURITY REQ-SEC-087, AB-13, S-9; 08 R12e, A13 P-9).
// ASSUMED interface (spec names files and behaviour only):
//   xlsx/XlsxWriter.ts   export function writeXlsx(sheets: { name: string; rows: unknown[][]; hidden?: boolean }[]): Promise<Uint8Array>
//                        cells: string | number | boolean | Date | null; wraps write-excel-file 4.1.1 (`write-excel-file/node`);
//                        EVERY string cell (header rows included) goes through @lims/shared-ts/spreadsheet.neutraliseFormula; numbers are number cells; no `<f>`.
//   xlsx/templates/index.ts  export function buildImportTemplate(kind: 'price_list'|'catalog_master'|'referrers'|'credit_parties',
//                        meta: { tenantCatalogRevision: number; exportedAt: string; priceList?: { id: string; code: string; baseVersionNo: number } }): Promise<Uint8Array>
//                        (sheets Instructions + data sheets + hidden `_meta` key/value rows; header row = column keys of 02-TRD §8.2).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLDEN, neutraliseFormula, textRuns, unzip, XLSX_DIR, WORKER_CATALOG_DIR, REPO_ROOT } from './zipfixtures.js';

type SheetIn = { name: string; rows: unknown[][]; hidden?: boolean };
const write = async (sheets: SheetIn[]): Promise<Uint8Array> => ((await import('../../../xlsx/XlsxWriter.js')) as any).writeXlsx(sheets);
const read = async (b: Uint8Array): Promise<{ name: string; rows: unknown[][] }[]> => ((await import('../../../xlsx/XlsxReader.js')) as any).readXlsx(b);
const inspect = async (b: Uint8Array) => ((await import('../../../xlsx/ZipInspector.js')) as any).inspectZip(b);

const HOSTILE = ['=HYPERLINK("http://x","click")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', "'=1", "'"];

describe('formula-injection guard on every text cell (08 A13 P-9, AB-13, S-9)', () => {
  it.each(HOSTILE)('text cell %j is stored neutralised, never raw', async (s) => {
    const parts = unzip(await write([{ name: 'Doctors', rows: [['display_name'], [s]] }]));
    const runs = textRuns(parts);
    expect(runs).toContain(neutraliseFormula(s));
    expect(neutraliseFormula(s)).not.toBe(s);
    expect(runs).not.toContain(s);
  });
  it('no <f> formula element anywhere in the package, and no formula-typed cell', async () => {
    const parts = unzip(await write([{ name: 'Doctors', rows: [['=A1', 'n'], [...HOSTILE, 1, 2.5, true]] }]));
    for (const [name, xml] of parts) if (name.startsWith('xl/')) { expect(xml, name).not.toMatch(/<f[\s>/]/); expect(xml, name).not.toMatch(/t="e"/); }
  });
  it('header (first-row) cells are text cells too: `=x` header is neutralised', async () => {
    expect(textRuns(unzip(await write([{ name: 'S', rows: [['=cmd|calc', 'ok']] }])))).toContain("'=cmd|calc");
  });
  it('untrusted cells re-emitted from an upload (annotated report) are neutralised again (raw `\'=x` becomes `\'\'=x`)', async () => {
    const runs = textRuns(unzip(await write([{ name: 'Issues', rows: [["'=x", "=y"]] }])));
    expect(runs).toContain("''=x"); expect(runs).toContain("'=y");
  });
  it('safe strings are written verbatim (no stray apostrophes)', async () => {
    const runs = textRuns(unzip(await write([{ name: 'S', rows: [['CBC', 'Dr. Sita Rai', '12abc', '']] }])));
    expect(runs).toEqual(expect.arrayContaining(['CBC', 'Dr. Sita Rai', '12abc']));
    expect(runs.some((r) => r.startsWith("'") && r !== "'")).toBe(false);
  });
  it('numbers stay number cells (not strings), booleans/null do not become text', async () => {
    const xml = unzip(await write([{ name: 'S', rows: [['n'], [12.5], [-3], [null]] }])).get('xl/worksheets/sheet1.xml')!;
    const cells = [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].filter((m) => /<v>(12\.5|-3)<\/v>/.test(m[2]!));
    expect(cells).toHaveLength(2);
    for (const c of cells) expect(c[1]).not.toMatch(/t="(s|str|inlineStr)"/);
    expect(textRuns(unzip(await write([{ name: 'S', rows: [[-3, 12.5]] }])))).toEqual([]);
  });
  it('golden corpus (C0-0A): written text == neutraliseFormula(input) and re-import restores the input', async () => {
    const cases = GOLDEN.filter((c) => c.input !== '');
    const bytes = await write([{ name: 'G', rows: cases.map((c) => [c.input]) }]);
    const runs = textRuns(unzip(bytes));
    for (const c of cases) expect(runs, JSON.stringify(c.input)).toContain(c.neutralised);
    expect((await read(bytes))[0]!.rows.map((r) => r[0])).toEqual(cases.map((c) => c.input));
  });
});

describe('writer output is a safe, readable xlsx', () => {
  it('passes our own ZipInspector (no vba, no external links, ZIP64, encryption; ≤ 200 entries)', async () => {
    expect(await inspect(await write([{ name: 'A', rows: [['x', 1]] }, { name: '_meta', rows: [['k', 'v']], hidden: true }]))).toMatchObject({ ok: true });
  });
  it('keeps sheet order and marks hidden sheets state="hidden" in workbook.xml', async () => {
    const bytes = await write([{ name: 'Instructions', rows: [['hi']] }, { name: 'Prices', rows: [['a']] }, { name: '_meta', rows: [['k', 'v']], hidden: true }]);
    const wb = unzip(bytes).get('xl/workbook.xml')!;
    const tags = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0]);
    expect(tags.map((t) => /name="([^"]*)"/.exec(t)![1])).toEqual(['Instructions', 'Prices', '_meta']);
    expect(tags[2]).toMatch(/state="hidden"/); expect(tags[0]).not.toMatch(/state="hidden"/); expect(tags[1]).not.toMatch(/state="hidden"/);
    expect((await read(bytes)).map((s) => s.name)).toContain('Prices');
  });
  it('contains no macro / external-link / script parts', async () => {
    for (const n of unzip(await write([{ name: 'A', rows: [['x']] }])).keys()) expect(n).not.toMatch(/vbaProject|externalLinks|\.\.|\\/);
  });
});

describe('import templates (02-TRD §8.2)', () => {
  const META = { tenantCatalogRevision: 7, exportedAt: '2026-11-07T08:00:00.000Z', priceList: { id: '01900000-0000-7000-8000-000000000001', code: 'RETAIL', baseVersionNo: 0 } };
  const build = async (kind: string) => ((await import('../../../xlsx/templates/index.js')) as any).buildImportTemplate(kind, META) as Promise<Uint8Array>;
  const byName = (sheets: { name: string; rows: unknown[][] }[]) => Object.fromEntries(sheets.map((s) => [s.name, s]));
  const HEADERS: Record<string, [string, string[]]> = {
    price_list: ['Prices', ['orderable_code', 'orderable_kind', 'orderable_name', 'department', 'unit_price_npr']],
    referrers: ['Doctors', ['doctor_code', 'display_name', 'qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'is_verified']],
    credit_parties: ['CreditParties', ['party_code', 'name', 'kind', 'allows_credit', 'pan', 'contact_phone_e164', 'contact_email', 'billing_address']],
    catalog_master: ['Tests', ['code', 'name', 'department_code', 'workflow_type', 'report_order', 'is_orderable', 'specimen_type_codes', 'container_code']],
  };
  it.each(Object.keys(HEADERS))('%s: Instructions + data sheet header row + hidden _meta, passes the inspector', async (kind) => {
    const bytes = await build(kind);
    expect(await inspect(bytes)).toMatchObject({ ok: true });
    const sheets = byName(await read(bytes)); const [dataSheet, cols] = HEADERS[kind]!;
    expect(sheets['Instructions']).toBeDefined(); expect(sheets[dataSheet]).toBeDefined();
    expect(sheets[dataSheet]!.rows[0]).toEqual(cols);
    expect(sheets[dataSheet]!.rows.length).toBe(1);                                       // empty template: header only
    const wb = unzip(bytes).get('xl/workbook.xml')!;
    expect([...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => m[0]).find((t) => /name="_meta"/.test(t))).toMatch(/state="hidden"/);
    const meta = Object.fromEntries((sheets['_meta']!.rows).map((r) => [String(r[0]), r[1]]));
    expect(meta['template_kind']).toBe(kind); expect(String(meta['template_version'])).toBe('1');
    expect(String(meta['tenant_catalog_revision'])).toBe('7'); expect(String(meta['exported_at'])).toBe(META.exportedAt);
  });
  it('price_list _meta carries price_list_id, price_list_code and base_version_no (0 for an empty template)', async () => {
    const meta = Object.fromEntries((byName(await read(await build('price_list')))['_meta']!.rows).map((r) => [String(r[0]), r[1]]));
    expect(meta['price_list_id']).toBe(META.priceList.id); expect(meta['price_list_code']).toBe('RETAIL'); expect(String(meta['base_version_no'])).toBe('0');
  });
  it('catalog_master has all 14 sheets of §8.2', async () => {
    const names = Object.keys(byName(await read(await build('catalog_master'))));
    for (const n of ['Departments', 'SpecimenTypes', 'Containers', 'Methods', 'Units', 'ValueSets', 'Tests', 'Analytes', 'ReferenceRanges', 'CriticalLimits', 'Panels', 'PanelMembers', 'CommentCodes', 'TatTargets']) expect(names).toContain(n);
  });
  it('Instructions sheet carries the static guidance (NPR, 2 decimals, do not edit _meta)', async () => {
    const text = JSON.stringify(byName(await read(await build('price_list')))['Instructions']!.rows);
    expect(text).toMatch(/NPR/); expect(text).toMatch(/2 decimals/); expect(text).toMatch(/_meta/);
  });
  it('a template whose meta contains a hostile price list code is neutralised, not stored raw', async () => {
    const m: any = await import('../../../xlsx/templates/index.js');
    const bytes: Uint8Array = await m.buildImportTemplate('price_list', { ...META, priceList: { ...META.priceList, code: '=HYPERLINK("http://x")' } });
    expect(textRuns(unzip(bytes))).toContain("'=HYPERLINK(\"http://x\")");
  });
});

describe('static rules for services/worker/src/jobs/catalog/xlsx (08 A13 P-9; 02-TRD §3.1 confinement)', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === '__tests__' ? [] : walk(p)) : [p]; });
  const prod = () => walk(WORKER_CATALOG_DIR).filter((p) => /\.ts$/.test(p));
  const src = (p: string) => readFileSync(p, 'utf8');
  it('writer and reader import the shared guard from @lims/shared-ts/spreadsheet', () => {
    expect(src(join(XLSX_DIR, 'XlsxWriter.ts'))).toMatch(/from\s+['"]@lims\/shared-ts\/spreadsheet['"]/);
    expect(src(join(XLSX_DIR, 'XlsxWriter.ts'))).toMatch(/neutraliseFormula/);
    expect(src(join(XLSX_DIR, 'XlsxReader.ts'))).toMatch(/from\s+['"]@lims\/shared-ts\/spreadsheet['"]/);
    expect(src(join(XLSX_DIR, 'XlsxReader.ts'))).toMatch(/restoreNeutralised/);
  });
  it('no module-local copy of neutraliseFormula / restoreNeutralised anywhere in C3 worker code', () => {
    for (const p of prod()) expect(src(p), relative(REPO_ROOT, p)).not.toMatch(/(function|const|let)\s+(neutraliseFormula|restoreNeutralised)\b/);
  });
  it('only the two wrappers import the spreadsheet libraries (read-excel-file 9.3.14 / write-excel-file 4.1.1 confinement)', () => {
    for (const p of prod()) {
      const s = src(p); const rel = relative(XLSX_DIR, p);
      if (rel !== 'XlsxReader.ts') expect(s, rel).not.toMatch(/['"]read-excel-file(\/|['"])/);
      if (rel !== 'XlsxWriter.ts') expect(s, rel).not.toMatch(/['"]write-excel-file(\/|['"])/);
    }
    expect(src(join(XLSX_DIR, 'XlsxReader.ts'))).toMatch(/['"]read-excel-file\/node['"]/);
    expect(src(join(XLSX_DIR, 'XlsxWriter.ts'))).toMatch(/['"]write-excel-file\/node['"]/);
  });
  it('ZipInspector is in-house: imports no zip/xlsx library and no zlib inflate', () => {
    const s = src(join(XLSX_DIR, 'ZipInspector.ts'));
    expect(s).not.toMatch(/from\s+['"](fflate|jszip|adm-zip|unzipper|yauzl|read-excel-file|write-excel-file|node:zlib|zlib)/);
  });
  it('library versions are pinned exactly in services/worker/package.json', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'services', 'worker', 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['read-excel-file']).toBe('9.3.14'); expect(deps['write-excel-file']).toBe('4.1.1');
  });
});
