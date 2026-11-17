// T0D-17 ctx.uploads.accept. Prescribed API (uploads/index.ts):
//   createUploads({ files:{scan}, storage, module, tenantId, log?, metrics? }) -> { accept(file, opts) }
//   IncomingFile (not defined by the spec; ASSUMED) = { filename: string; mimeType: string /* declared */; bytes: Uint8Array }
// Errors: bad type/extension/magic -> 415 common.unsupported_media_type; > maxBytes -> 413 common.payload_too_large;
// scan hit or sanitisation failure -> 422 common.upload_quarantined.
import { describe, expect, it, vi } from 'vitest';
import { PDF, UUIDV7, TENANT_A, TENANT_B, ZIPISH, fakeRaw, png, pngBomb, recorders, sha256, storageOpts } from '../../storage/__tests__/helpers.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PATH = `${TENANT_A}/2026/11/0190a000-0000-7000-8000-000000000002.pdf`;
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 2)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

async function setup(scanResult: 'clean' | 'infected' | 'unavailable' | Error = 'clean', module = 'reporting') {
  const f = fakeRaw(); const r = recorders();
  const { createStorage } = await import('../../storage/index.js');
  const { createUploads } = await import('../index.js');
  const storage = await createStorage(storageOpts(f, r, module));
  const scan = vi.fn(async (_b: Uint8Array) => { if (scanResult instanceof Error) throw scanResult; return scanResult; });
  const up = createUploads({ files: { scan }, storage, module, tenantId: TENANT_A, log: r.log, metrics: r.metrics });
  const opts = (o: Record<string, unknown> = {}) => ({ allow: ['application/pdf'], maxBytes: 1024 * 1024, bucket: 'reports', objectPath: PATH, scan: 'required', ...o });
  const file = (bytes: Uint8Array, filename: string, mimeType: string) => ({ filename, mimeType, bytes });
  return { f, r, up, scan, opts, file };
}
const fail = (p: Promise<unknown>) => p.then(() => undefined, (x: any) => x as { name: string; code: string; statusCode: number });
const untouched = (f: ReturnType<typeof fakeRaw>) => expect(f.calls).toEqual([]);

describe('ctx.uploads.accept - magic bytes + extension', () => {
  it('accepts a clean PDF and stores it exactly at bucket/objectPath', async () => {
    const { f, up, scan, opts, file } = await setup();
    const out = await up.accept(file(PDF, 'Lab Report.PDF', 'application/pdf'), opts());
    expect(out).toMatchObject({ bucket: 'reports', objectPath: PATH, sha256: sha256(PDF), byteSize: PDF.length, mime: 'application/pdf', scanState: 'clean' });
    expect(out.objectId).toMatch(UUIDV7);
    expect(scan).toHaveBeenCalledTimes(1); expect(Buffer.compare(Buffer.from(scan.mock.calls[0]![0]), PDF)).toBe(0);
    expect([...f.objects.keys()]).toEqual([`reports|${PATH}`]);
  });
  it.each([
    ['PNG bytes named .pdf', png(), 'a.pdf', 'application/pdf'],
    ['PDF bytes named .png', PDF, 'a.png', 'application/pdf'],
    ['EXE bytes named .pdf', EXE, 'a.pdf', 'application/pdf'],
    ['HTML bytes named .pdf', HTML, 'a.pdf', 'application/pdf'],
    ['double extension', PDF, 'a.pdf.exe', 'application/pdf'],
    ['no extension', PDF, 'report', 'application/pdf'],
    ['declared mime lies', PDF, 'a.pdf', 'image/png'],
    ['empty file', Buffer.alloc(0), 'a.pdf', 'application/pdf'],
    ['magic only half there', Buffer.from('%PD'), 'a.pdf', 'application/pdf'],
  ])('rejects %s with 415 before scan or store', async (_n, bytes, filename, mime) => {
    const { f, scan, up, opts, file } = await setup();
    const e = await fail(up.accept(file(bytes, filename, mime), opts()));
    expect(e?.code).toBe('common.unsupported_media_type'); expect(e?.statusCode).toBe(415);
    expect(scan).not.toHaveBeenCalled(); untouched(f);
  });
  it('a type outside opts.allow is refused even if magic and extension agree', async () => {
    const { f, up, opts, file } = await setup();
    const e = await fail(up.accept(file(png(), 'a.png', 'image/png'), opts()));
    expect(e?.code).toBe('common.unsupported_media_type'); untouched(f);
  });
  it('xlsx = ZIP magic + .xlsx; a .zip or a non-ZIP .xlsx is refused', async () => {
    const x = await setup(); const p = `${TENANT_A}/2026/11/s.xlsx`;
    const ok = await x.up.accept(x.file(ZIPISH, 'tests.xlsx', XLSX), x.opts({ allow: [XLSX], bucket: 'reports', objectPath: p }));
    expect(ok.mime).toBe(XLSX);
    for (const [b, n] of [[ZIPISH, 'tests.zip'], [PDF, 'tests.xlsx']] as const)
      expect((await fail(x.up.accept(x.file(b, n, XLSX), x.opts({ allow: [XLSX], objectPath: `${TENANT_A}/2026/11/t.xlsx` }))))?.code).toBe('common.unsupported_media_type');
  });
  it('text/csv: UTF-8 without NUL; scan may be not_applicable (scanner not called)', async () => {
    const x = await setup(); const p = `${TENANT_A}/2026/11/c.csv`;
    const o = x.opts({ allow: ['text/csv'], objectPath: p, scan: 'not_applicable' });
    const ok = await x.up.accept(x.file(Buffer.from('code,name\nA,कोड\n', 'utf8'), 'c.csv', 'text/csv'), o);
    expect(ok.mime).toBe('text/csv'); expect(ok.scanState).toBe('clean'); expect(x.scan).not.toHaveBeenCalled();
    for (const b of [Buffer.from('a,b\0c\n'), Buffer.from([0x61, 0x2c, 0xff, 0xfe, 0x0a])])
      expect((await fail(x.up.accept(x.file(b, 'c.csv', 'text/csv'), x.opts({ allow: ['text/csv'], objectPath: `${TENANT_A}/2026/11/d.csv` }))))?.code).toBe('common.unsupported_media_type');
  });
  it('scan: not_applicable is refused for anything but text/csv', async () => {
    const { f, scan, up, opts, file } = await setup();
    await expect(up.accept(file(PDF, 'a.pdf', 'application/pdf'), opts({ scan: 'not_applicable' }))).rejects.toThrow();
    expect(scan).not.toHaveBeenCalled(); untouched(f);
  });
  it('the client filename never influences the stored key', async () => {
    const { f, up, opts, file } = await setup();
    const out = await up.accept(file(PDF, '../../etc/x\\..\\y/../../z.pdf', 'application/pdf'), opts()).then((o) => o, () => undefined);
    if (out) expect([...f.objects.keys()]).toEqual([`reports|${PATH}`]);
    else untouched(f);
  });
});

describe('ctx.uploads.accept - limits, tenant, ownership', () => {
  it('size: maxBytes is inclusive, one byte more is 413, maxBytes above 15 MB is a programming error', async () => {
    const x = await setup(); const pdf = (n: number) => Buffer.concat([PDF, Buffer.alloc(n - PDF.length, 0x20)]);
    await x.up.accept(x.file(pdf(512), 'a.pdf', 'application/pdf'), x.opts({ maxBytes: 512 }));
    const y = await setup();
    const e = await fail(y.up.accept(y.file(pdf(513), 'a.pdf', 'application/pdf'), y.opts({ maxBytes: 512 })));
    expect(e?.code).toBe('common.payload_too_large'); expect(e?.statusCode).toBe(413); expect(y.scan).not.toHaveBeenCalled(); untouched(y.f);
    const z = await setup();
    await expect(z.up.accept(z.file(PDF, 'a.pdf', 'application/pdf'), z.opts({ maxBytes: 15 * 1024 * 1024 + 1 }))).rejects.toThrow(); untouched(z.f);
  });
  it('first path segment must be ctx.tenantId', async () => {
    const { f, scan, up, opts, file } = await setup();
    for (const p of [`${TENANT_B}/2026/11/a.pdf`, 'a.pdf', `${TENANT_A}/../${TENANT_B}/a.pdf`, `${TENANT_A.toUpperCase()}/a.pdf`])
      await expect(up.accept(file(PDF, 'a.pdf', 'application/pdf'), opts({ objectPath: p }))).rejects.toThrow();
    expect(scan).not.toHaveBeenCalled(); untouched(f);
  });
  it('writes only to the calling module\'s own buckets', async () => {
    const { f, scan, up, opts, file } = await setup('clean', 'frontdesk');
    await expect(up.accept(file(PDF, 'a.pdf', 'application/pdf'), opts({ bucket: 'reports' }))).rejects.toThrow();
    await expect(up.accept(file(PDF, 'a.pdf', 'application/pdf'), opts({ bucket: 'not-a-bucket' }))).rejects.toThrow();
    expect(scan).not.toHaveBeenCalled(); untouched(f);
    const ok = await up.accept(file(PDF, 'a.pdf', 'application/pdf'), opts({ bucket: 'frontdesk-trf' }));
    expect(ok.bucket).toBe('frontdesk-trf');
  });
});

describe('ctx.uploads.accept - quarantine is fail-closed', () => {
  it('infected => 422 common.upload_quarantined and no infected byte stays in Storage', async () => {
    const { f, up, opts, file } = await setup('infected');
    const e = await fail(up.accept(file(PDF, 'a.pdf', 'application/pdf'), opts()));
    expect(e?.code).toBe('common.upload_quarantined'); expect(e?.statusCode).toBe(422);
    expect([...f.objects.values()].some((o) => Buffer.compare(o.bytes, PDF) === 0)).toBe(false);
  });
  it('a scanner that throws is never reported clean (rejects, or resolves unavailable)', async () => {
    const { up, opts, file } = await setup(new Error('ECONNREFUSED clamd'));
    const out = await up.accept(file(PDF, 'a.pdf', 'application/pdf'), opts()).then((o) => o, () => undefined);
    if (out) expect(out.scanState).toBe('unavailable');
  });
  it('an unavailable scan resolves as scanState "unavailable" (stays in quarantine, 08 §4.13)', async () => {
    const { up, opts, file } = await setup('unavailable');
    const out = await up.accept(file(PDF, 'a.pdf', 'application/pdf'), opts());
    expect(out.scanState).toBe('unavailable');
  });
});

describe('ctx.uploads.accept - image re-encode (REQ-SEC-085, D-67)', () => {
  const img = { reencode: true as const, stripMetadata: true as const };
  const ip = `${TENANT_A}/2026/11/img.png`;
  it('stored PNG is re-encoded: valid, metadata stripped, sha256/byteSize describe the stored bytes, width/height reported', async () => {
    const { f, up, opts, file } = await setup('clean', 'anatomic');
    const src = png(4, 3, 'GPS-SENTINEL-27.7172N-85.3240E');
    const out = await up.accept(file(src, 'x.png', 'image/png'), opts({ allow: ['image/png'], bucket: 'anatomic-images', objectPath: ip, images: img }));
    const stored = f.objects.get(`anatomic-images|${ip}`)!.bytes;
    expect(stored.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(stored.toString('latin1')).not.toContain('GPS-SENTINEL');
    expect(out.image).toEqual({ width: 4, height: 3 });
    expect(out).toMatchObject({ sha256: sha256(stored), byteSize: stored.length, mime: 'image/png' });
  });
  it('corrupt image with a valid magic => 422 common.upload_quarantined, nothing stored', async () => {
    const { f, up, opts, file } = await setup('clean', 'anatomic');
    const bad = Buffer.concat([png().subarray(0, 40), Buffer.from('garbage')]);
    const e = await fail(up.accept(file(bad, 'x.png', 'image/png'), opts({ allow: ['image/png'], bucket: 'anatomic-images', objectPath: ip, images: img })));
    expect(e?.code).toBe('common.upload_quarantined'); expect(f.objects.size).toBe(0);
  });
  it('decompression bomb (IHDR 20000x20000 > 40 MP default) is refused, nothing stored', async () => {
    const { f, up, opts, file } = await setup('clean', 'anatomic');
    const e = await fail(up.accept(file(pngBomb(20000, 20000), 'x.png', 'image/png'), opts({ allow: ['image/png'], bucket: 'anatomic-images', objectPath: ip, images: img })));
    expect(['common.upload_quarantined', 'common.payload_too_large']).toContain(e?.code); expect(f.objects.size).toBe(0);
  });
});
