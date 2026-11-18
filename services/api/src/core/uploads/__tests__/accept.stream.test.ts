// T0B-FILESTREAM-1 (LD-312) done_when 4, 5: ctx.uploads.accept takes a STREAM as well as bytes. Plain pass through uploads (TRF, instrument attachments)
// enforce the size limit while the body flows and stop reading at the limit; scan, magic byte, extension, quarantine and image re-encode rules are
// unchanged and give the same answers as the bytes form. Inspected / re-encoded kinds (PNG re-encode REQ-SEC-083..085, CSV UTF-8 + NUL) are buffered inside accept.
// Prescribed API: IncomingFile = { filename, mimeType, bytes } (unchanged)  |  { filename, mimeType, stream: Readable | web ReadableStream | AsyncIterable<Uint8Array>, declaredSize?: number }
// declaredSize (the multipart / Content-Length value) above maxBytes is refused with 413 before any byte is read; a lying declaredSize does not widen the limit.
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TENANT_A, TENANT_B, png, pngBomb } from '../../storage/__tests__/helpers.js';
import { CHUNK, MiB, SLACK, bytesOf, makeStreamStorage, memProbe, source } from '../../storage/__tests__/stream.helpers.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';   // split: no AV flags this source
const BUCKET = 'frontdesk-trf'; const P = `${TENANT_A}/2026/11/up.pdf`;
const PDF_HEAD = Buffer.from('%PDF-1.7\n');
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection'); };
const pick = (a: any) => ({ bucket: a.bucket, objectPath: a.objectPath, sha256: a.sha256, byteSize: a.byteSize, mime: a.mime, scanState: a.scanState, image: a.image });

async function setup(module = 'frontdesk') {
  const { f, r, storage } = await makeStreamStorage(module);
  const scan = vi.fn(async (b: Uint8Array) => (Buffer.from(b).includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'infected' as const : 'clean' as const));
  const { createUploads } = await import('../index.js');
  const uploads = createUploads({ files: { scan }, storage, module, tenantId: TENANT_A, log: r.log });
  const opts = (o: Record<string, unknown> = {}) => ({ allow: ['application/pdf'], maxBytes: 10 * MiB, bucket: BUCKET, objectPath: P, scan: 'required', ...o }) as any;
  const stream = (body: Buffer | Readable, o: { filename?: string; mimeType?: string; declaredSize?: number } = {}) =>
    ({ filename: o.filename ?? 'trf-scan.pdf', mimeType: o.mimeType ?? 'application/pdf', stream: Buffer.isBuffer(body) ? Readable.from([body], { objectMode: false }) : body, ...(o.declaredSize !== undefined ? { declaredSize: o.declaredSize } : {}) });
  return { f, r, storage, scan, uploads, opts, stream };
}
const pdfBody = (total: number) => Buffer.concat([PDF_HEAD, bytesOf(0, total - PDF_HEAD.length)]);

describe('accept(stream): same result as accept(bytes)', () => {
  it('a PDF given as a stream is stored under the same key with the same sha256 / byteSize / mime / scanState as the bytes form', async () => {
    const body = pdfBody(3 * CHUNK + 17);
    const a = await setup(); const viaBytes = await a.uploads.accept({ filename: 'trf-scan.pdf', mimeType: 'application/pdf', bytes: body }, a.opts());
    const b = await setup(); const viaStream = await b.uploads.accept(b.stream(body) as any, b.opts());
    expect(pick(viaStream)).toEqual(pick(viaBytes)); expect(viaStream.scanState).toBe('clean'); expect(viaStream.byteSize).toBe(body.length);
    expect(b.f.stored(BUCKET, P)).toMatchObject({ size: body.length, sha256: viaBytes.sha256 });
    expect(b.f.stored(BUCKET, P)?.bytes?.equals(body)).toBe(true);
    expect(b.scan).toHaveBeenCalledTimes(1);
  });
  it('a web ReadableStream and an async iterable are accepted too', async () => {
    const body = pdfBody(CHUNK + 5);
    const s = await setup(); const web = await s.uploads.accept({ ...s.stream(body), stream: Readable.toWeb(Readable.from([body], { objectMode: false })) } as any, s.opts());
    const t = await setup(); const it_ = await t.uploads.accept({ ...t.stream(body), stream: (async function* () { yield body; })() } as any, t.opts());
    expect(web.byteSize).toBe(body.length); expect(it_.sha256).toBe(web.sha256);
  });
  it('chunk boundaries do not matter: the magic bytes split across 2-byte chunks are still recognised', async () => {
    const body = pdfBody(1000); const s = await setup();
    const split = Readable.from([body.subarray(0, 2), body.subarray(2, 4), body.subarray(4)], { objectMode: false });
    const a = await s.uploads.accept(s.stream(split) as any, s.opts());
    expect(a.mime).toBe('application/pdf'); expect(a.byteSize).toBe(1000);
  });
});

describe('accept(stream): the size limit is enforced while streaming (done_when 4)', () => {
  it('a stream longer than maxBytes: 413 common.payload_too_large, reading stops at the limit (+ slack), nothing stored, scanner not called', async () => {
    const s = await setup(); const pulled = { bytes: 0, chunks: 0 };
    const e = await rejection(s.uploads.accept(s.stream(source(50 * MiB, { pulled, prefix: PDF_HEAD })) as any, s.opts({ maxBytes: 5 * MiB })));
    expect(e.code).toBe('common.payload_too_large'); expect(e.statusCode).toBe(413);
    expect(pulled.bytes).toBeLessThanOrEqual(5 * MiB + SLACK);
    expect(s.f.objects.size).toBe(0); expect(s.scan).not.toHaveBeenCalled();
  });
  it('a stream of exactly maxBytes is accepted; one byte more is refused', async () => {
    const s = await setup(); const max = 1 * MiB;
    expect((await s.uploads.accept(s.stream(pdfBody(max)) as any, s.opts({ maxBytes: max }))).byteSize).toBe(max);
    const t = await setup(); expect((await rejection(t.uploads.accept(t.stream(pdfBody(max + 1)) as any, t.opts({ maxBytes: max })))).code).toBe('common.payload_too_large');
  });
  it('declaredSize above maxBytes: 413 before the first byte is read', async () => {
    const s = await setup(); const pulled = { bytes: 0, chunks: 0 };
    const e = await rejection(s.uploads.accept(s.stream(source(CHUNK, { pulled, prefix: PDF_HEAD }), { declaredSize: 6 * MiB }) as any, s.opts({ maxBytes: 5 * MiB })));
    expect(e.code).toBe('common.payload_too_large'); expect(pulled.bytes).toBe(0); expect(s.f.objects.size).toBe(0);
  });
  it('a lying declaredSize (small) does not widen the limit: the real body is still cut at maxBytes', async () => {
    const s = await setup(); const pulled = { bytes: 0, chunks: 0 };
    const e = await rejection(s.uploads.accept(s.stream(source(50 * MiB, { pulled, prefix: PDF_HEAD }), { declaredSize: 100 }) as any, s.opts({ maxBytes: 2 * MiB })));
    expect(e.code).toBe('common.payload_too_large'); expect(pulled.bytes).toBeLessThanOrEqual(2 * MiB + SLACK); expect(s.f.objects.size).toBe(0);
  });
  it('maxBytes above the 15 MiB cap is still a programming error (common.internal), before the stream is touched', async () => {
    const s = await setup(); const pulled = { bytes: 0, chunks: 0 };
    expect((await rejection(s.uploads.accept(s.stream(source(10, { pulled })) as any, s.opts({ maxBytes: 16 * MiB })))).code).toBe('common.internal'); expect(pulled.bytes).toBe(0);
  });
});

describe('accept(stream): scan, magic, extension and quarantine rules are unchanged', () => {
  it.each([
    ['wrong magic (a PNG named .pdf)', () => png(), 'trf-scan.pdf', 'application/pdf'],
    ['declared type does not match the extension', () => pdfBody(100), 'trf-scan.pdf', 'image/png'],
    ['extension not allowed', () => pdfBody(100), 'trf-scan.exe', 'application/pdf'],
    ['no extension', () => pdfBody(100), 'trf-scan', 'application/pdf'],
    ['empty body', () => Buffer.alloc(0), 'trf-scan.pdf', 'application/pdf'],
  ])('%s: 415 common.unsupported_media_type, nothing stored, scanner not called', async (_n, mk, filename, mimeType) => {
    const s = await setup();
    const e = await rejection(s.uploads.accept(s.stream(mk() as Buffer, { filename, mimeType }) as any, s.opts()));
    expect(e.code).toBe('common.unsupported_media_type'); expect(e.statusCode).toBe(415); expect(s.f.objects.size).toBe(0); expect(s.scan).not.toHaveBeenCalled();
  });
  it('a wrong-magic body is refused from its first chunk: the rest of a large body is not read', async () => {
    const s = await setup(); const pulled = { bytes: 0, chunks: 0 };
    const e = await rejection(s.uploads.accept(s.stream(source(50 * MiB, { pulled })) as any, s.opts({ maxBytes: 10 * MiB })));   // pattern bytes do not start with %PDF-
    expect(e.code).toBe('common.unsupported_media_type'); expect(pulled.bytes).toBeLessThanOrEqual(SLACK);
  });
  it('infected (EICAR) -> 422 common.upload_quarantined, nothing stored, a quarantine warning without the file name', async () => {
    const s = await setup();
    const e = await rejection(s.uploads.accept(s.stream(Buffer.concat([PDF_HEAD, Buffer.from(EICAR)]), { filename: 'NAMESENTINEL.pdf' }) as any, s.opts()));
    expect(e.code).toBe('common.upload_quarantined'); expect(e.statusCode).toBe(422); expect(s.f.objects.size).toBe(0);
    expect(JSON.stringify(s.r.lines)).not.toContain('NAMESENTINEL');
  });
  it('scanner down: the upload is stored with scanState unavailable (08 §4.13), exactly as the bytes form', async () => {
    const s = await setup(); s.scan.mockRejectedValueOnce(new Error('clamd down'));
    const a = await s.uploads.accept(s.stream(pdfBody(500)) as any, s.opts());
    expect(a.scanState).toBe('unavailable'); expect(s.f.has(BUCKET, P)).toBe(true);
  });
  it('bucket owner, tenant path and create-only are checked before the stream is read', async () => {
    const s = await setup(); const pulled = { bytes: 0, chunks: 0 };
    for (const o of [{ bucket: 'reports' }, { objectPath: `${TENANT_B}/2026/11/x.pdf` }, { objectPath: 'x.pdf' }])
      expect((await rejection(s.uploads.accept(s.stream(source(CHUNK, { pulled, prefix: PDF_HEAD })) as any, s.opts(o)))).code).toBe('common.internal');
    expect(pulled.bytes).toBe(0);
    await s.uploads.accept(s.stream(pdfBody(100)) as any, s.opts());
    await rejection(s.uploads.accept(s.stream(pdfBody(100)) as any, s.opts()));   // second create of the same key must not overwrite
    expect(s.f.stored(BUCKET, P)?.size).toBe(100);
  });
  it('a source that fails in the middle: rejected, nothing stored, the source error text is not echoed', async () => {
    const s = await setup();
    const e = await rejection(s.uploads.accept(s.stream(source(4 * CHUNK, { prefix: PDF_HEAD, failAfter: 2 * CHUNK, failMessage: 'SOURCE-SECRET-TEXT' })) as any, s.opts()));
    expect(String(e?.message)).not.toContain('SOURCE-SECRET-TEXT'); expect(s.f.objects.size).toBe(0);
  });
  it('neither bytes nor stream, or a stream that is not one: 415, as a bad bytes field is today', async () => {
    const s = await setup();
    for (const f of [{ filename: 'a.pdf', mimeType: 'application/pdf' }, { filename: 'a.pdf', mimeType: 'application/pdf', stream: 12 }, { filename: 'a.pdf', mimeType: 'application/pdf', stream: {} }])
      expect((await rejection(s.uploads.accept(f as any, s.opts()))).code).toBe('common.unsupported_media_type');
  });
});

describe('accept(stream): kinds that must be inspected stay buffered inside accept (and say so)', () => {
  const imgOpts = { allow: ['image/png', 'image/jpeg'], bucket: 'anatomic-images', objectPath: `${TENANT_A}/2026/11/img.png`, images: { reencode: true, stripMetadata: true } };
  it('PNG with images.reencode: the stored object is the re-encoded one without the planted metadata; same dimensions and bytes as the bytes form', async () => {
    const img = png(4, 3, 'GPS-LAT-27.7172N-SENTINEL');
    const a = await setup('anatomic'); const viaBytes = await a.uploads.accept({ filename: 'a.png', mimeType: 'image/png', bytes: img }, a.opts(imgOpts));
    const b = await setup('anatomic'); const viaStream = await b.uploads.accept(b.stream(img, { filename: 'a.png', mimeType: 'image/png' }) as any, b.opts(imgOpts));
    expect(viaStream.image).toEqual({ width: 4, height: 3 }); expect(pick(viaStream)).toEqual(pick(viaBytes));
    expect(b.f.stored('anatomic-images', imgOpts.objectPath)?.bytes?.includes('GPS-LAT')).toBe(false);
    expect(b.f.stored('anatomic-images', imgOpts.objectPath)?.bytes?.equals(a.f.stored('anatomic-images', imgOpts.objectPath)!.bytes!)).toBe(true);
  });
  it('JPEG with images.reencode is refused (only PNG is re-encoded today): 422 common.upload_quarantined, as the bytes form', async () => {
    const s = await setup('anatomic'); const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from('Exif\0\0GPS'), Buffer.from([0xff, 0xd9])]);
    const e = await rejection(s.uploads.accept(s.stream(jpg, { filename: 'a.jpg', mimeType: 'image/jpeg' }) as any, s.opts({ ...imgOpts, objectPath: `${TENANT_A}/2026/11/img.jpg` })));
    expect(e.code).toBe('common.upload_quarantined'); expect(s.f.objects.size).toBe(0);
  });
  it('a decompression-bomb PNG over maxMegapixels is refused while streaming, nothing stored', async () => {
    const s = await setup('anatomic');
    const e = await rejection(s.uploads.accept(s.stream(pngBomb(20000, 20000), { filename: 'a.png', mimeType: 'image/png' }) as any, s.opts({ ...imgOpts, images: { ...imgOpts.images, maxMegapixels: 10 } })));
    expect(e.code).toBe('common.upload_quarantined'); expect(s.f.objects.size).toBe(0);
  });
  it('CSV: UTF-8 and NUL checks still apply to a stream (NUL -> 415, invalid UTF-8 -> 415); a valid CSV is stored with scan not_applicable', async () => {
    const csv = (b: Buffer) => ({ allow: ['text/csv'], bucket: 'micro-imports', objectPath: `${TENANT_A}/2026/11/in.csv`, scan: 'not_applicable', maxBytes: 1 * MiB, _b: b });
    for (const bad of [Buffer.from('a,b\n1,\0\n'), Buffer.from([0x61, 0x2c, 0xff, 0xfe, 0x0a])]) {
      const s = await setup('micro'); const { _b, ...o } = csv(bad);
      expect((await rejection(s.uploads.accept(s.stream(_b, { filename: 'in.csv', mimeType: 'text/csv' }) as any, s.opts(o)))).code).toBe('common.unsupported_media_type'); expect(s.f.objects.size).toBe(0);
    }
    const s = await setup('micro'); const { _b, ...o } = csv(Buffer.from('a,b\n1,2\n'));
    const a = await s.uploads.accept(s.stream(_b, { filename: 'in.csv', mimeType: 'text/csv' }) as any, s.opts(o));
    expect(a).toMatchObject({ mime: 'text/csv', scanState: 'clean', byteSize: 8 }); expect(s.scan).not.toHaveBeenCalled();
  });
});

describe('accept(stream): memory (done_when 5)', () => {
  it('a 50 MB body against a 5 MiB limit: rejected at the limit with growth <= 20 MB (the body is never held whole)', async () => {
    const s = await setup(); const probe = memProbe(); let n = 0; const pulled = { bytes: 0, chunks: 0 };
    const src = source(50 * MiB, { pulled, prefix: PDF_HEAD });
    const watched = Readable.from((async function* () { for await (const c of src) { if (++n % 8 === 0) probe.sample(); yield c; } })(), { objectMode: false });
    const e = await rejection(s.uploads.accept(s.stream(watched) as any, s.opts({ maxBytes: 5 * MiB })));
    probe.sample();
    expect(e.code).toBe('common.payload_too_large'); expect(pulled.bytes).toBeLessThanOrEqual(5 * MiB + SLACK);
    expect(probe.growthMiB(), `grew ${probe.growthMiB().toFixed(1)} MiB`).toBeLessThanOrEqual(20);
  }, 60_000);
  it('an 8 MiB PDF within a 10 MiB limit is accepted with growth <= 20 MB (at most one copy of the body is held for the scanner)', async () => {
    const s = await setup(); const probe = memProbe(); let n = 0;
    const src = source(8 * MiB, { prefix: PDF_HEAD });
    const watched = Readable.from((async function* () { for await (const c of src) { if (++n % 8 === 0) probe.sample(); yield c; } })(), { objectMode: false });
    const a = await s.uploads.accept(s.stream(watched) as any, s.opts());
    probe.sample();
    expect(a.byteSize).toBe(8 * MiB); expect(probe.growthMiB(), `grew ${probe.growthMiB().toFixed(1)} MiB`).toBeLessThanOrEqual(20);
  }, 60_000);
});
