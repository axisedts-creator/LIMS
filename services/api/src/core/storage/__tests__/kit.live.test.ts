// CR TENANT-LOGO-1 (storage wiring), LIVE: the pieces boot.ts puts behind ctx.storage / ctx.uploads / ctx.download, composed the same way,
// against a REAL S3 compatible server (Supabase Storage with the S3 protocol on). Skipped without LIMS_TEST_STORAGE=1.
// Run: bash tests/core/STORAGE-KIT-1.pg.sh (throwaway containers). The scanner is a stub ('clean'): clamd is not part of this run.
// Synthetic bytes only; every object written here is deleted again.
import { describe, expect, it } from 'vitest';
import { createDownload } from '../download.js';
import { createStorage } from '../index.js';
import { createS3RawStorage, parseStorageConfig } from '../s3.js';
import { createUploads } from '../../uploads/index.js';
import { png } from './helpers.js';

const LIVE = process.env['LIMS_TEST_STORAGE'] === '1';
const A = '0190a000-0000-7000-8000-00000000aaaa', B = '0190a000-0000-7000-8000-00000000bbbb';
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const collect = async (body: unknown): Promise<Buffer> => {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const parts: Buffer[] = []; for await (const c of body as AsyncIterable<Uint8Array>) parts.push(Buffer.from(c)); return Buffer.concat(parts);
};

describe.skipIf(!LIVE)('file kit over a real S3 compatible server', () => {
  const cfg = LIVE ? parseStorageConfig(process.env) : undefined;
  const raw = cfg && cfg.provider === 's3_compatible' ? createS3RawStorage(cfg) : undefined;
  const access: any[] = [];
  /** exactly what boot.ts fileKit returns for (module, tenant) */
  const kit = (tenantId: string, module = 'identity') => {
    const storage = createStorage({ raw: raw!, module, tenantId });
    return {
      storage,
      uploads: createUploads({ files: { scan: async () => 'clean' as const }, storage, module, tenantId }),
      download: createDownload({ storage, audit: { access: async (e) => { access.push(e); } } }),
    };
  };
  const id = () => `${Date.now().toString(16)}${Math.floor(Math.random() * 1e9).toString(16)}`;

  it('a logo uploaded for tenant A is stored under A, read back byte for byte, served by the download helper, then deleted', async () => {
    const k = kit(A); const path = `${A}/branding/${id()}.png`;
    const acc = await k.uploads.accept({ filename: 'logo.png', mimeType: 'image/png', bytes: png(40, 12) },
      { allow: ['image/png', 'image/jpeg'], maxBytes: 2 * 1024 * 1024, bucket: 'identity-assets', objectPath: path, images: { reencode: true, stripMetadata: true, maxMegapixels: 16 }, scan: 'required' });
    expect(acc).toMatchObject({ mime: 'image/png', scanState: 'clean', image: { width: 40, height: 12 }, objectPath: path });
    const stored = Buffer.from(await k.storage.read('identity-assets', path));
    expect(stored.length).toBe(acc.byteSize); expect(stored.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    const res: any = await k.download.stream({ bucket: 'identity-assets', objectPath: path, filename: 'logo.png', contentType: 'image/png', scanState: 'clean',
      access: { action: 'branding_asset.download', entityType: 'branding_asset', outcome: 'allowed' } as any });
    expect(res.status).toBe(200); expect(res.headers['content-type']).toBe('image/png'); expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect((await collect(res.body)).equals(stored)).toBe(true);
    await k.storage.delete('identity-assets', path);
    expect((await rejection(k.storage.read('identity-assets', path))).code).toBe('common.dependency_unavailable');
  });

  it('tenant separation at the storage layer: the kit of tenant B refuses A keys for read, write, download and delete, and A object stays intact', async () => {
    const a = kit(A), b = kit(B); const path = `${A}/branding/${id()}.png`; const bytes = png(8, 8);
    await a.storage.put('identity-assets', path, bytes, { contentType: 'image/png', ifAbsent: true });
    expect((await rejection(b.storage.read('identity-assets', path))).code).toBe('common.internal');
    expect((await rejection(b.storage.put('identity-assets', path, png(2, 2), { contentType: 'image/png' }))).code).toBe('common.internal');
    expect((await rejection(b.storage.delete('identity-assets', path))).code).toBe('common.internal');
    expect((await rejection(b.download.stream({ bucket: 'identity-assets', objectPath: path, filename: 'x.png', contentType: 'image/png', scanState: 'clean', access: {} as any }))).code).toBe('common.internal');
    expect((await rejection(b.uploads.accept({ filename: 'logo.png', mimeType: 'image/png', bytes: png(2, 2) },
      { allow: ['image/png'], maxBytes: 1024 * 1024, bucket: 'identity-assets', objectPath: path, scan: 'required' }))).code).toBe('common.internal');
    expect(Buffer.from(await a.storage.read('identity-assets', path)).equals(Buffer.from(bytes))).toBe(true);
    // same file name under B is a different object
    const pathB = path.replace(A, B);
    expect((await rejection(b.storage.read('identity-assets', pathB))).code).toBe('common.dependency_unavailable');
    await a.storage.delete('identity-assets', path);
  });

  it('a module cannot write into another module bucket (owner rule), and an existing object is not overwritten (create only)', async () => {
    const other = kit(A, 'billing'); const path = `${A}/branding/${id()}.png`;
    expect((await rejection(other.storage.put('identity-assets', path, png(2, 2), { contentType: 'image/png' }))).code).toBe('common.internal');
    const k = kit(A); const first = png(4, 4);
    await k.storage.put('identity-assets', path, first, { contentType: 'image/png', ifAbsent: true });
    await rejection(k.storage.put('identity-assets', path, png(6, 6), { contentType: 'image/png', ifAbsent: true }));
    expect(Buffer.from(await k.storage.read('identity-assets', path)).equals(Buffer.from(first))).toBe(true);
    await k.storage.delete('identity-assets', path);
  });
});
