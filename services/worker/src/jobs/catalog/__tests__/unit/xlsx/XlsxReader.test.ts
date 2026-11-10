// T-21 (C3) — XlsxReader wrapper (02-TRD §8.3 steps 2-4, §8.4, §8.2 guard; 01-PRD AC-16.9; 07-SECURITY REQ-SEC-087, AB-11, AB-12, S-7, S-9).
// ASSUMED interface (spec names the file and the behaviour only) — services/worker/src/jobs/catalog/xlsx/XlsxReader.ts:
//   export type Sheet = { name: string; rows: unknown[][] }           // cells: string | number | boolean | Date | null
//   export function createXlsxReader(o?: { parse?: (bytes: Uint8Array, signal: AbortSignal) => Promise<Sheet[]>; timeoutMs?: number; maxRows?: number }):
//          { read(bytes: Uint8Array): Promise<Sheet[]> }               // parse defaults to read-excel-file 9.3.14 (`read-excel-file/node`); timeoutMs 60_000; maxRows 20_000
//   export const readXlsx: (bytes: Uint8Array) => Promise<Sheet[]>    // = createXlsxReader().read
//   read(): inspectZip first (library never reached on rejection) -> parse under timeout (AbortSignal-guarded race) -> row cap -> restoreNeutralised on every text cell.
//   Failures are thrown as errors carrying `.code` (file.not_xlsx | file.zip_unsafe | file.macro_present | file.external_links | file.parse_timeout | file.too_many_rows).
// The `parse` seam is the test seam for S-7 ("spy asserts the library is not invoked for rejected files") and for a deterministic timeout.
import { describe, expect, it, vi } from 'vitest';
import {
  buildZip, EICAR, GOLDEN, minimalXlsx, minimalXlsxEntries, padEntries, rejectCode, restoreNeutralised, neutraliseFormula, type ZEntry,
} from './zipfixtures.js';

type Sheet = { name: string; rows: unknown[][] };
async function mk(o: Record<string, unknown> = {}) { const m: any = await import('../../../xlsx/XlsxReader.js'); return m.createXlsxReader(o) as { read(b: Uint8Array): Promise<Sheet[]> }; }
const GOOD = minimalXlsx();
const spy = (sheets: Sheet[] = [{ name: 'Prices', rows: [['orderable_code', 'unit_price_npr'], ['CBC', 350]] }]) =>
  vi.fn(async (_b: Uint8Array, _s: AbortSignal) => sheets);

describe('AC-16.9 / AB-11 — crafted files are rejected and the spreadsheet library is never called (S-7)', () => {
  const big = (i: number): ZEntry => ({ name: `xl/worksheets/big${i}.xml`, data: 'x', claimCompressed: 250_000, claimUncompressed: 20_000_000 });
  const cases: [string, Uint8Array, string][] = [
    ['PDF renamed .xlsx', Buffer.from('%PDF-1.7\n%%EOF\n'), 'file.not_xlsx'],
    ['HTML polyglot', Buffer.concat([Buffer.from('<html>'), GOOD]), 'file.not_xlsx'],
    ['empty', Buffer.alloc(0), 'file.not_xlsx'],
    ['truncated (no EOCD)', minimalXlsx([], { noEocd: true }), 'file.not_xlsx'],
    ['zip without workbook', buildZip(minimalXlsxEntries().filter((e) => e.name !== 'xl/workbook.xml')), 'file.not_xlsx'],
    ['201 entries', minimalXlsx(padEntries(197)), 'file.zip_unsafe'],
    ['ratio 1000:1 bomb', buildZip([...minimalXlsxEntries(), { name: 'xl/worksheets/s2.xml', data: Buffer.alloc(10 * 1024 * 1024), method: 8 }]), 'file.zip_unsafe'],
    ['sum > 50 MB', minimalXlsx([big(1), big(2), big(3)]), 'file.zip_unsafe'],
    ['../ path', minimalXlsx([{ name: '../../x', data: 'x' }]), 'file.zip_unsafe'],
    ['backslash path', minimalXlsx([{ name: 'xl\\a.xml', data: 'x' }]), 'file.zip_unsafe'],
    ['ZIP64', minimalXlsx([], { zip64Eocd: true }), 'file.zip_unsafe'],
    ['encrypted flag', minimalXlsx([{ name: 'xl/worksheets/s2.xml', data: 'x', flags: 1 }]), 'file.zip_unsafe'],
    ['vbaProject.bin (.xlsm)', minimalXlsx([{ name: 'xl/vbaProject.bin', data: 'x' }]), 'file.macro_present'],
    ['externalLinks', minimalXlsx([{ name: 'xl/externalLinks/externalLink1.xml', data: '<x/>' }]), 'file.external_links'],
  ];
  it.each(cases)('%s -> %s', async (_n, bytes, code) => {
    const parse = spy(); const r = await mk({ parse });
    expect(await rejectCode(r.read(bytes))).toBe(code);
    expect(parse).not.toHaveBeenCalled();
  });
  it('a clean file reaches the library exactly once, with the original bytes and an AbortSignal', async () => {
    const parse = spy(); const r = await mk({ parse });
    await r.read(GOOD);
    expect(parse).toHaveBeenCalledTimes(1);
    const [bytes, signal] = parse.mock.calls[0]!;
    expect(Buffer.from(bytes).equals(GOOD)).toBe(true); expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('parse timeout (60 s [CONV]; AbortSignal-guarded promise race) -> file.parse_timeout', () => {
  it('a parser that never settles is cut off, and its signal is aborted', async () => {
    let sig: AbortSignal | undefined;
    const parse = vi.fn((_b: Uint8Array, s: AbortSignal) => { sig = s; return new Promise<Sheet[]>(() => {}); });
    const r = await mk({ parse, timeoutMs: 25 });
    const t0 = Date.now();
    expect(await rejectCode(r.read(GOOD))).toBe('file.parse_timeout');
    expect(Date.now() - t0).toBeLessThan(2000); expect(sig?.aborted).toBe(true);
  });
  it('default timeout is 60 s: a parser that settles in 50 ms is not cut off', async () => {
    const r = await mk({ parse: () => new Promise<Sheet[]>((res) => setTimeout(() => res([{ name: 'A', rows: [['x']] }]), 50)) });
    expect(await r.read(GOOD)).toEqual([{ name: 'A', rows: [['x']] }]);
  });
  it('default timeoutMs is exactly 60_000 (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const r = await mk({ parse: () => new Promise<Sheet[]>(() => {}) });
      const p = rejectCode(r.read(GOOD));
      await vi.advanceTimersByTimeAsync(59_999); let settled = false; void p.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2); expect(await p).toBe('file.parse_timeout');
    } finally { vi.useRealTimers(); }
  });
  it('a parser error is surfaced, not swallowed as an empty workbook', async () => {
    const r = await mk({ parse: async () => { throw new Error('corrupt'); } });
    expect(await rejectCode(r.read(GOOD))).not.toBe('');
  });
});

describe('row cap (20,000 [CONV]) -> file.too_many_rows (AB-12)', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => [i]);
  it('20,000 rows pass; 20,002 rows fail (default cap)', async () => {
    expect((await (await mk({ parse: async () => [{ name: 'Prices', rows: rows(20_000) }] })).read(GOOD))[0]!.rows).toHaveLength(20_000);
    expect(await rejectCode((await mk({ parse: async () => [{ name: 'Prices', rows: rows(20_002) }] })).read(GOOD))).toBe('file.too_many_rows');
  });
  it('1,000,000 rows fail', async () => {
    expect(await rejectCode((await mk({ parse: async () => [{ name: 'Prices', rows: rows(1_000_000) }] })).read(GOOD))).toBe('file.too_many_rows');
  });
  it('cap is per sheet, applied to every sheet (a big second sheet is not skipped)', async () => {
    const r = await mk({ maxRows: 5, parse: async () => [{ name: 'A', rows: rows(2) }, { name: 'B', rows: rows(9) }] });
    expect(await rejectCode(r.read(GOOD))).toBe('file.too_many_rows');
  });
  it('maxRows option is honoured', async () => {
    const r = await mk({ maxRows: 3, parse: async () => [{ name: 'A', rows: rows(4) }] });
    expect(await rejectCode(r.read(GOOD))).toBe('file.too_many_rows');
  });
});

describe('restoreNeutralised on every text cell (08 A13 P-9; 02-TRD §8.2, §8.3 step 4)', () => {
  it('strips exactly one leading apostrophe; leaves numbers, booleans, dates, null and plain text alone', async () => {
    const d = new Date('2026-01-02T03:04:05Z');
    const r = await mk({ parse: async () => [{ name: 'Prices', rows: [
      ["'=HYPERLINK(\"http://x\",\"click\")", "'+1", "'-2", "'@SUM(A1)", "''quoted", 'plain', "'"],
      [12.5, true, d, null, 0, '', 'a\'b'],
    ] }] });
    const [s] = await r.read(GOOD);
    expect(s!.rows[0]).toEqual(['=HYPERLINK("http://x","click")', '+1', '-2', '@SUM(A1)', "'quoted", 'plain', '']);
    expect(s!.rows[1]).toEqual([12.5, true, d, null, 0, '', "a'b"]);
  });
  it('applies to header cells, to every sheet including _meta, and keeps sheet names/order', async () => {
    const r = await mk({ parse: async () => [
      { name: 'Prices', rows: [["'=h1", "h2"], ["'+x"]] },
      { name: '_meta', rows: [['template_kind', "'-price_list"]] },
    ] });
    const out = await r.read(GOOD);
    expect(out.map((s) => s.name)).toEqual(['Prices', '_meta']);
    expect(out[0]!.rows).toEqual([['=h1', 'h2'], ['+x']]);
    expect(out[1]!.rows).toEqual([['template_kind', '-price_list']]);
  });
  it('golden corpus: restoreNeutralised(neutraliseFormula(s)) === s for every C0-0A case', async () => {
    const r = await mk({ parse: async () => [{ name: 'G', rows: GOLDEN.map((c) => [c.neutralised]) }] });
    const [s] = await r.read(GOOD);
    expect(s!.rows.map((x) => x[0])).toEqual(GOLDEN.map((c) => c.input));
  });
  it('EICAR text in a cell is returned as inert text (the scan is the job\'s ctx.files.scan, not the reader)', async () => {
    const r = await mk({ parse: async () => [{ name: 'A', rows: [[EICAR]] }] });
    expect((await r.read(GOOD))[0]!.rows[0]![0]).toBe(EICAR);
  });
  it('does not mutate the parser output in place', async () => {
    const sheets: Sheet[] = [{ name: 'A', rows: [["'=x"]] }];
    await (await mk({ parse: async () => sheets })).read(GOOD);
    expect(sheets[0]!.rows[0]![0]).toBe("'=x");
  });
});

describe('real library (read-excel-file 9.3.14) through the wrappers — write -> inspect -> read round trip', () => {
  it('reads what XlsxWriter wrote: names, order, numbers, and original text incl. neutralised cells (S-9 re-import)', async () => {
    const { writeXlsx }: any = await import('../../../xlsx/XlsxWriter.js'); const { readXlsx }: any = await import('../../../xlsx/XlsxReader.js');
    const hostile = ['=HYPERLINK("http://x","click")', '+1', '-1', '@SUM(A1)', "'quoted", 'plain'];
    const bytes: Uint8Array = await writeXlsx([
      { name: 'Prices', rows: [['orderable_code', 'unit_price_npr'], ...hostile.map((h, i) => [h, 10 + i + 0.5])] },
      { name: 'Second', rows: [['a']] },
    ]);
    const out: Sheet[] = await readXlsx(bytes);
    expect(out.map((s) => s.name)).toEqual(['Prices', 'Second']);
    expect(out[0]!.rows.slice(1).map((r) => r[0])).toEqual(hostile);
    expect(out[0]!.rows.slice(1).map((r) => r[1])).toEqual(hostile.map((_h, i) => 10 + i + 0.5));
  });
  it('neutralise/restore are the shared pair (round trip identity)', () => {
    for (const c of GOLDEN) expect(restoreNeutralised(neutraliseFormula(c.input))).toBe(c.input);
  });
});
