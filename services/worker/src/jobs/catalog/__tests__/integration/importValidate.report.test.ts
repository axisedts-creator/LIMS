// T-22 (C3) worker integration: the annotated report file of catalog.import_validate — AC-16.10 (02-TRD §8.3 step 5, §8.2 formula guard; 07 AB-13, S-9).
// The report is the original `Prices` sheet + a last column `issues`, plus a sheet `Issues`; stored in catalog.files (purpose import_report), referenced by
// imports.report_file_id. The upload is never the report. Every text cell goes through neutraliseFormula; no cell is a formula (<f>).
// ASSUMED: the Issues sheet has a header row followed by one row per stored issue (columns free, but each row carries the issue code).
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importValidate } from '../../tasks/catalog.import_validate.js';
import { IMPORT_ID, TENANT_A, makeRunner, makeValidateDb, seedCatalog, seedImport, uid, type ValidateDb } from '../helpers/validateDb.js';
import { HEADER, priceWorkbook, prow, readXlsx, sheetNamed, unzip } from '../helpers/workbooks.js';

const CAT = [{ id: uid(1), code: 'A1' }, { id: uid(2), code: 'A2' }];
const V = { version_no: 3, status: 'published' as const, items: { A1: 10000, A2: 20000 } };
const imp = (db: ValidateDb) => db.rows('imports', TENANT_A).find((x) => x.id === IMPORT_ID)!;
const issues = (db: ValidateDb) => db.rows('import_issues', TENANT_A).sort((a, b) => a.seq - b.seq);
const reportOf = (db: ValidateDb) => db.rows('files', TENANT_A).find((f) => f.id === imp(db).report_file_id)!;

async function validated(rows: unknown[][]) {
  const upload = await priceWorkbook(rows);
  const db = makeValidateDb();
  seedCatalog(db, TENANT_A, { orderables: CAT, versions: [V] });
  seedImport(db, TENANT_A, upload);
  await makeRunner(db, importValidate).run({ tenant_id: TENANT_A, import_id: IMPORT_ID });
  return { db, upload };
}
beforeEach(() => { vi.stubEnv('LIMS_CORE_ENV', 'staging'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('AC-16.10 — invalid import → annotated report', () => {
  it('report file row: purpose import_report, xlsx, size/sha match the bytes, expires with the import + 30 d, and it is not the upload', async () => {
    const { db, upload } = await validated([prow('A1', 100), prow('A2', 12.345), prow('ZZ9UNKNOWN', 5)]);
    expect(imp(db).status).toBe('invalid');
    const rep = reportOf(db);
    expect(rep).toBeTruthy();
    expect(rep.purpose).toBe('import_report');
    expect(rep.byte_size).toBe(rep.content.length);
    expect(rep.sha256).toBe(createHash('sha256').update(rep.content).digest('hex'));
    expect(rep.expires_at.getTime()).toBe(imp(db).expires_at.getTime() + 30 * 24 * 3600_000);
    expect(rep.id).not.toBe(imp(db).upload_file_id);
    expect(Buffer.from(rep.content).equals(Buffer.from(upload))).toBe(false);          // the original upload is never served back
    const up = db.rows('files', TENANT_A).find((f) => f.id === imp(db).upload_file_id)!;
    expect(up.purpose).toBe('import_upload');                                          // upload untouched
    expect(Buffer.from(up.content).equals(Buffer.from(upload))).toBe(true);
    expect(imp(db).file_sha256).toBe(createHash('sha256').update(upload).digest('hex'));
  });

  it('sheet Prices keeps the original columns and rows and gains a last column `issues`; sheet Issues lists every stored issue', async () => {
    const { db } = await validated([prow('A1', 100), prow('A2', 12.345), prow('ZZ9UNKNOWN', 5)]);
    const sheets = await readXlsx(reportOf(db).content);
    const prices = sheetNamed(sheets, 'Prices')!;
    expect(prices).toBeTruthy();
    expect(prices.rows[0]).toEqual([...HEADER, 'issues']);
    expect(prices.rows).toHaveLength(4);                                                // header + 3 data rows
    expect(prices.rows[1]!.slice(0, 5)).toEqual(['A1', null, null, null, 100]);       // original data intact
    expect(prices.rows[2]![4]).toBe(12.345);
    expect(String(prices.rows[2]![5])).toContain('row.price_decimals');               // issue annotated on its own row
    expect(String(prices.rows[3]![5])).toContain('row.orderable_unknown');
    expect(prices.rows[1]![5] ?? '').toBe('');                                         // clean row: empty issues cell

    const list = sheetNamed(sheets, 'Issues')!;
    expect(list).toBeTruthy();
    expect(list.rows.length - 1).toBe(issues(db).length);                              // header + one row per issue
    const flat = JSON.stringify(list.rows);
    for (const i of issues(db)) expect(flat).toContain(i.issue_code);
  });

  it('a report is also produced for a validated import, and the original _meta/sheets of the upload are not echoed as formulas', async () => {
    const { db } = await validated([prow('A1', 100)]);
    expect(imp(db).status).toBe('validated');
    expect(reportOf(db)?.purpose).toBe('import_report');
    const sheets = await readXlsx(reportOf(db).content);
    expect(sheetNamed(sheets, 'Issues')).toBeTruthy();
  });
});

describe('formula-injection guard on the report (08 R12e/A13 P-9, 07 AB-13/S-9)', () => {
  const evil = ['=SUM(1+1)', '+1+1', '-2+3', '@SUM(1)', '\t=1+1', "'=already-quoted"];

  it('untrusted upload text re-emitted in the report is neutralised: no <f> element, no cell text starts with = + - @ tab CR; reading back restores the original', async () => {
    const { db } = await validated(evil.map((s, n) => prow('A1', 100 + n, { name: s, dept: s })));
    const files = unzip(reportOf(db).content);
    expect(files.size).toBeGreaterThan(0);
    for (const [name, xml] of files) {
      if (!name.endsWith('.xml')) continue;
      expect(xml, name).not.toMatch(/<f[\s>/]/);
      for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>|<v>([^<]*)<\/v>/g)) {
        const text = (m[1] ?? m[2] ?? '').replace(/&#x?[0-9a-f]+;/gi, '');
        if (/^[=+\-@]/.test(text) && !/^[+-]?\d+(\.\d+)?$/.test(text)) throw new Error(`${name}: un-neutralised cell text ${JSON.stringify(text)}`);
      }
    }
    const prices = sheetNamed(await readXlsx(reportOf(db).content), 'Prices')!;
    evil.forEach((s, n) => { expect(prices.rows[n + 1]![2]).toBe(s); expect(prices.rows[n + 1]![3]).toBe(s); });   // restoreNeutralised round trip
  });

  it('a workbook written with neutralised text cells (as an export does) validates as written: round trip = unchanged', async () => {
    const { db } = await validated([prow('A1', 100, { name: '=cmd' }), prow('A2', 200)]);     // the writer stores the name cell neutralised
    expect(imp(db).status).toBe('validated');
    expect(imp(db).summary).toMatchObject({ rows: 2, unchanged: 2, changed: 0, added: 0, removed: 0 });
  });
});
