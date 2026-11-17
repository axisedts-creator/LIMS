// T-21 (C3) — ZipInspector (02-TRD §8.4, in-house, no library; 01-PRD AC-16.9; 07-SECURITY AB-11, S-7; 02-TRD §14 "ZIP inspector against crafted fixtures").
// ASSUMED interface (spec names the file only) — services/worker/src/jobs/catalog/xlsx/ZipInspector.ts:
//   export function inspectZip(bytes: Uint8Array): { ok: true; entryCount: number; uncompressedBytes: number } | { ok: false; code: string }
//   never throws on hostile input; never decompresses (fixtures below carry lying central-directory sizes and no real payload).
// ASSUMED code mapping (spec lists the codes but not which rule gives which): not a zip / no EOCD / missing [Content_Types].xml or xl/workbook.xml -> file.not_xlsx;
//   ZIP64, encrypted, >200 entries, sum > 50 MB, ratio > 100, `..`/absolute/backslash names -> file.zip_unsafe; xl/vbaProject.bin -> file.macro_present; xl/externalLinks/ -> file.external_links.
import { describe, expect, it } from 'vitest';
import { buildZip, EICAR, minimalXlsx, minimalXlsxEntries, padEntries, type ZEntry } from './zipfixtures.js';

async function inspect(bytes: Uint8Array): Promise<{ ok: boolean; code?: string; entryCount?: number; uncompressedBytes?: number }> {
  const mod: any = await import('../../../xlsx/ZipInspector.js');
  return mod.inspectZip(bytes);
}
const reject = async (bytes: Uint8Array, code: string) => { const r = await inspect(bytes); expect(r).toMatchObject({ ok: false, code }); };
const MB = 1024 * 1024;

describe('accepts a structurally valid xlsx container', () => {
  it('minimal workbook passes and reports counts', async () => {
    const r = await inspect(minimalXlsx());
    expect(r.ok).toBe(true); expect(r.entryCount).toBe(4); expect(r.uncompressedBytes).toBeGreaterThan(0);
  });
  it('a ZIP comment after the EOCD does not hide the record', async () => {
    expect((await inspect(minimalXlsx([], { comment: Buffer.alloc(100, 0x41) }))).ok).toBe(true);
  });
  it('exactly 200 entries pass (boundary)', async () => {
    expect((await inspect(minimalXlsx(padEntries(196)))).ok).toBe(true);
  });
  it('EICAR text inside a sheet is inert data for the inspector (scanning is ctx.files.scan, 02-TRD §8.3 step 1)', async () => {
    const r = await inspect(minimalXlsx([{ name: 'xl/sharedStrings.xml', data: `<sst><si><t>${EICAR}</t></si></sst>`, method: 8 }]));
    expect(r.ok).toBe(true);
  });
  it('compressed-to-uncompressed ratio exactly 100 passes (rule is "> 100")', async () => {
    expect((await inspect(minimalXlsx([{ name: 'xl/worksheets/sheet2.xml', data: 'x', claimCompressed: 1000, claimUncompressed: 100_000 }]))).ok).toBe(true);
  });
  it('a large but honest entry (45,000,000 bytes at ratio 50) passes: sum below 50 MB', async () => {
    expect((await inspect(minimalXlsx([{ name: 'xl/worksheets/sheet2.xml', data: 'x', claimCompressed: 900_000, claimUncompressed: 45_000_000 }]))).ok).toBe(true);
  });
});

describe('not a ZIP / not an xlsx -> file.not_xlsx', () => {
  it.each([
    ['empty buffer', Buffer.alloc(0)],
    ['PDF renamed .xlsx', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')],
    ['HTML', Buffer.from('<html><body>not a workbook</body></html>')],
    ['legacy OLE .xls header', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Array(600).fill(0)])],
    ['random bytes', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) & 0xff))],
  ])('%s', async (_n, bytes) => { await reject(bytes, 'file.not_xlsx'); });

  it('EOCD missing (archive truncated)', async () => { await reject(minimalXlsx([], { noEocd: true }), 'file.not_xlsx'); });
  it('EOCD chopped to 10 bytes', async () => { const z = minimalXlsx(); await reject(z.subarray(0, z.length - 12), 'file.not_xlsx'); });
  it('HTML prefix in front of a valid archive (polyglot): no PK\\x03\\x04 magic at offset 0', async () => {
    await reject(Buffer.concat([Buffer.from('<html><!--'), minimalXlsx()]), 'file.not_xlsx');
  });
  it('missing [Content_Types].xml', async () => {
    await reject(buildZip(minimalXlsxEntries().filter((e) => e.name !== '[Content_Types].xml')), 'file.not_xlsx');
  });
  it('missing xl/workbook.xml (a docx/zip of something else)', async () => {
    await reject(buildZip(minimalXlsxEntries().filter((e) => e.name !== 'xl/workbook.xml')), 'file.not_xlsx');
  });
});

describe('unsafe container -> file.zip_unsafe', () => {
  it('201 entries (one over the cap)', async () => { await reject(minimalXlsx(padEntries(197)), 'file.zip_unsafe'); });
  it('1,000 entries', async () => { await reject(minimalXlsx(padEntries(996)), 'file.zip_unsafe'); });
  it('zip bomb by ratio: 101:1 claimed', async () => {
    await reject(minimalXlsx([{ name: 'xl/worksheets/sheet2.xml', data: 'x', claimCompressed: 1000, claimUncompressed: 101_000 }]), 'file.zip_unsafe');
  });
  it('real zip bomb: 20 MB of zeros deflated (ratio ~1000:1) is judged from headers alone', async () => {
    const bomb = buildZip([...minimalXlsxEntries(), { name: 'xl/worksheets/sheet2.xml', data: Buffer.alloc(20 * MB), method: 8 }]);
    expect(bomb.length).toBeLessThan(200_000);
    await reject(bomb, 'file.zip_unsafe');
  });
  it('compressed size 0 but uncompressed > 0 (division-by-zero evasion)', async () => {
    await reject(minimalXlsx([{ name: 'xl/worksheets/sheet2.xml', data: '', claimCompressed: 0, claimUncompressed: 5000 }]), 'file.zip_unsafe');
  });
  it('sum of uncompressed sizes > 50 MB with every entry under ratio 100', async () => {
    const big = (i: number): ZEntry => ({ name: `xl/worksheets/big${i}.xml`, data: 'x', claimCompressed: 250_000, claimUncompressed: 20_000_000 });
    await reject(minimalXlsx([big(1), big(2), big(3)]), 'file.zip_unsafe');
  });
  it('two entries of 2^31 bytes (sum wraps to ~0 in uint32) are still rejected', async () => {
    const e = (i: number): ZEntry => ({ name: `xl/worksheets/o${i}.xml`, data: 'x', claimCompressed: 21_474_837, claimUncompressed: 2_147_483_648 });
    await reject(minimalXlsx([e(1), e(2)]), 'file.zip_unsafe');
  });
  it('ZIP64 end-of-central-directory record + locator', async () => { await reject(minimalXlsx([], { zip64Eocd: true }), 'file.zip_unsafe'); });
  it('ZIP64 extra field / 0xFFFFFFFF sizes in a central entry', async () => {
    await reject(minimalXlsx([{ name: 'xl/worksheets/sheet2.xml', data: 'x', zip64Extra: true }]), 'file.zip_unsafe');
  });
  it('encrypted entry (general-purpose bit 0)', async () => {
    await reject(minimalXlsx([{ name: 'xl/worksheets/sheet2.xml', data: 'x', flags: 0x0001 }]), 'file.zip_unsafe');
  });
  it('encrypted required entry (bit 0 plus bit 3), as a password-protected package would be', async () => {
    const es = minimalXlsxEntries().map((e) => (e.name === 'xl/workbook.xml' ? { ...e, flags: 0x0009 } : e));
    await reject(buildZip(es), 'file.zip_unsafe');
  });
  it.each([
    ['parent traversal', '../../etc/passwd'],
    ['nested traversal', 'xl/../../evil.xml'],
    ['absolute path', '/etc/cron.d/x'],
    ['windows drive path', 'C:\\Windows\\x.dll'],
    ['backslash separator', 'xl\\worksheets\\sheet9.xml'],
    ['UNC path', '\\\\host\\share\\x'],
  ])('entry name: %s', async (_n, name) => {
    await reject(minimalXlsx([{ name, data: 'x' }]), 'file.zip_unsafe');
  });
});

describe('macros and external links', () => {
  it('xl/vbaProject.bin -> file.macro_present (.xlsm renamed .xlsx)', async () => {
    await reject(minimalXlsx([{ name: 'xl/vbaProject.bin', data: 'MACRO' }]), 'file.macro_present');
  });
  it('xl/externalLinks/externalLink1.xml -> file.external_links', async () => {
    await reject(minimalXlsx([{ name: 'xl/externalLinks/externalLink1.xml', data: '<externalLink/>' }]), 'file.external_links');
  });
  it('xl/externalLinks/_rels/ entry alone also rejects', async () => {
    await reject(minimalXlsx([{ name: 'xl/externalLinks/_rels/externalLink1.xml.rels', data: '<Relationships/>' }]), 'file.external_links');
  });
});

describe('robustness against hostile structure', () => {
  it('central-directory offset pointing outside the buffer does not throw', async () => {
    const z = Buffer.from(minimalXlsx()); z.writeUInt32LE(0x7fffffff, z.length - 6);   // EOCD cd offset
    const r = await inspect(z); expect(r.ok).toBe(false);
  });
  it('entry count in EOCD larger than the real directory does not throw or loop', async () => {
    const z = Buffer.from(minimalXlsx()); z.writeUInt16LE(60000, z.length - 12); z.writeUInt16LE(60000, z.length - 14);
    const r = await inspect(z); expect(r.ok).toBe(false);
  });
  it('is pure: same bytes, same verdict', async () => {
    const z = minimalXlsx([{ name: 'xl/vbaProject.bin', data: 'x' }]);
    expect(await inspect(z)).toEqual(await inspect(z));
  });
});
