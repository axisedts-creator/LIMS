// T0D-17 / AC-0D-3.3: ctx.download.stream. Prescribed API (storage/download.ts):
//   createDownload({ storage: {read(bucket,path)}, audit: {access(entry)} }) -> { stream(input) } -> { status:200, headers, body }
//   body = Uint8Array | web ReadableStream | async iterable of bytes. Header names are matched case-insensitively.
import { describe, expect, it, vi } from 'vitest';
import { PDF, SIGNED, TENANT_A, TENANT_B, fakeRaw, png, recorders, storageOpts, toBytes } from './helpers.js';

const PATH = `${TENANT_A}/2026/11/0190a000-0000-7000-8000-000000000001-v1.pdf`;
const ACCESS = { action: 'report.download', entityType: 'report', entityId: '0190a000-0000-7000-8000-000000000001', outcome: 'allowed' as const };
const hdr = (res: { headers?: Record<string, string> }, name: string): string | undefined =>
  Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

async function setup(bytes: Uint8Array = PDF, bucket = 'reports', module = 'reporting', path = PATH) {
  const f = fakeRaw(); const r = recorders();
  const { createStorage } = await import('../index.js');
  const { createDownload } = await import('../download.js');
  const storage = await createStorage(storageOpts(f, r, module));
  await storage.put(bucket, path, bytes, { contentType: 'application/octet-stream' });
  f.calls.length = 0;
  const audit = { access: vi.fn(async () => {}) };
  const spy = { read: vi.fn((b: string, p: string) => storage.read(b, p)), signedUrl: vi.fn(storage.signedUrl.bind(storage)) };
  const dl = createDownload({ storage: spy as any, audit, log: r.log });
  const input = (o: Record<string, unknown> = {}) => ({ bucket, objectPath: path, filename: 'report.pdf', contentType: 'application/pdf', scanState: 'clean', access: ACCESS, ...o });
  return { f, r, dl, audit, spy, input };
}

describe('ctx.download.stream - clean object (AC-0D-3.3)', () => {
  it('streams the bytes with attachment / nosniff / no-store and writes the access-log row', async () => {
    const { dl, audit, input } = await setup();
    const res = await dl.stream(input());
    expect(res.status).toBe(200);
    expect(Buffer.compare(await toBytes(res.body), PDF)).toBe(0);
    expect(hdr(res, 'content-disposition')).toMatch(/^attachment(;|$)/);
    expect(hdr(res, 'content-disposition')).toContain('report.pdf');
    expect(hdr(res, 'x-content-type-options')).toBe('nosniff');
    expect(hdr(res, 'cache-control')).toBe('no-store');
    expect(hdr(res, 'content-type')).toBe('application/pdf');
    expect(audit.access).toHaveBeenCalledTimes(1);
    expect(audit.access).toHaveBeenCalledWith(ACCESS);
  });
  it('never exposes a signed URL: not requested, not in headers, body, or logs', async () => {
    const { dl, spy, r, input } = await setup();
    const res = await dl.stream(input());
    const all = JSON.stringify([res.headers, r.lines, r.incs]);
    expect(spy.signedUrl).not.toHaveBeenCalled();
    expect(all).not.toMatch(/https?:|storage\.invalid|token=|signature|location/i);
    expect(Object.keys(res.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('location');
    expect((await toBytes(res.body)).toString('latin1')).not.toContain(SIGNED);
  });
  it('encodes the filename per RFC 6266 and cannot inject headers', async () => {
    const { dl, input } = await setup();
    const evil = 'a"b\r\nSet-Cookie: x=1\r\n\r\n<html>.pdf';
    const res = await dl.stream(input({ filename: evil }));
    const cd = hdr(res, 'content-disposition')!;
    expect(cd).not.toMatch(/[\r\n]/);
    expect(Object.keys(res.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('set-cookie');
    expect((cd.match(/"/g) ?? []).length % 2 === 0 || cd.includes('\\"')).toBe(true);   // quoted fallback stays well-formed
    const uni = await dl.stream(input({ filename: 'रिपोर्ट é.pdf' }));
    expect(hdr(uni, 'content-disposition')).toMatch(/filename\*=UTF-8''%E0%A4%B0/i);
    expect(hdr(uni, 'content-disposition')).toMatch(/^attachment; filename="[\x20-\x7e]*"/);
  });
  it('rejects a content type that is not a plain type/subtype', async () => {
    const { dl, input } = await setup();
    await expect(dl.stream(input({ contentType: 'text/html\r\nX-Evil: 1' }))).rejects.toThrow();
  });
  it('fails closed when the access-log write fails: no bytes are returned', async () => {
    const { dl, audit, input } = await setup();
    audit.access.mockRejectedValueOnce(new Error('db down'));
    await expect(dl.stream(input())).rejects.toThrow();
  });
  it('tenant isolation: another tenant path never reaches the raw service or the audit log', async () => {
    const { dl, audit, f, input } = await setup();
    await expect(dl.stream(input({ objectPath: `${TENANT_B}/2026/11/x.pdf` }))).rejects.toThrow();
    expect(f.calls).toEqual([]); expect(audit.access).not.toHaveBeenCalled();
  });
});

describe('ctx.download.stream - not clean => 422 common.upload_quarantined (AC-0D-3.3)', () => {
  it.each(['pending', 'infected', 'unavailable', 'CLEAN', '', undefined, null, 'clean '])('scanState %j', async (scanState) => {
    const { dl, spy, f, input } = await setup();
    const e = await dl.stream(input({ scanState })).then(() => undefined, (x: any) => x);
    expect(e, 'must reject').toBeDefined();
    expect(e.name).toBe('LimsError'); expect(e.code).toBe('common.upload_quarantined'); expect(e.statusCode).toBe(422);
    expect(spy.read).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });
});

describe('ctx.download.stream - inline variant (D-67)', () => {
  it('re-encoded PNG/JPEG may be inline, still nosniff/no-store, with a locked-down CSP', async () => {
    for (const [ct, name] of [['image/png', 'a.png'], ['image/jpeg', 'a.jpg']] as const) {
      const p = `${TENANT_A}/2026/11/img.${name.slice(-3)}`;
      const { dl, input } = await setup(png(), 'anatomic-images', 'anatomic', p);
      const res = await dl.stream(input({ bucket: 'anatomic-images', objectPath: p, filename: name, contentType: ct, inline: { reencodedImage: true } }));
      expect(hdr(res, 'content-disposition')).toMatch(/^inline(;|$)/);
      expect(hdr(res, 'x-content-type-options')).toBe('nosniff'); expect(hdr(res, 'cache-control')).toBe('no-store');
      expect(hdr(res, 'content-security-policy')).toMatch(/default-src 'none'/); expect(hdr(res, 'content-security-policy')).toMatch(/sandbox/);
    }
  });
  it.each(['application/pdf', 'text/html', 'image/svg+xml', 'image/gif', 'text/csv'])('inline is refused for %s', async (ct) => {
    const { dl, input } = await setup();
    await expect(dl.stream(input({ contentType: ct, inline: { reencodedImage: true } }))).rejects.toThrow();
  });
  it('inline without the reencodedImage marker is refused', async () => {
    const { dl, input } = await setup();
    await expect(dl.stream(input({ contentType: 'image/png', inline: {} }))).rejects.toThrow();
  });
});
