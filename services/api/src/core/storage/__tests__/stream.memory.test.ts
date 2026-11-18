// T0B-FILESTREAM-1 (LD-312) done_when 5: a 50 MB object goes through download and through upload; the test fails if the memory still held
// (heap + Buffer memory, measured after a forced collection every 2 MiB, so garbage does not count) grows by more than 20 MB.
// Fails now: no readStream / putStream, and read() holds the whole 50 MB.
import { describe, expect, it, vi } from 'vitest';
import { TENANT_A } from './helpers.js';
import { MiB, expectedSha, makeStreamStorage, memProbe, sink, source } from './stream.helpers.js';

const BIG = 50 * MiB; const LIMIT_MIB = 20;
const PATH = `${TENANT_A}/2026/11/0190a000-0000-7000-8000-000000000001-v1.pdf`;

describe('50 MB through the API process stays flat', () => {
  it('the probe is not vacuous: holding a 50 MB buffer is seen as >= 45 MB of growth', () => {
    const p = memProbe(); const held = Buffer.alloc(BIG, 1); p.sample();
    expect(p.growthMiB()).toBeGreaterThan(45); expect(held.length).toBe(BIG);
  });

  it('download: 50 MB from storage to a slow-ish consumer; growth <= 20 MB; every byte intact; read() never used', async () => {
    const { f, storage } = await makeStreamStorage();
    f.seed('reports', PATH, { size: BIG, etag: '"big"' });
    const { createDownload } = await import('../download.js');
    const audit = { access: vi.fn(async () => {}) };
    const dl = createDownload({ storage, audit });
    const readSpy = vi.spyOn(storage, 'read');
    const probe = memProbe();
    const res = await dl.stream({ bucket: 'reports', objectPath: PATH, filename: 'big.pdf', contentType: 'application/pdf', scanState: 'clean', access: { action: 'report.download', entityType: 'report', entityId: 'x', outcome: 'allowed' } as any });
    expect(res.headers['content-length']).toBe(String(BIG));
    const got = await sink(res.body, probe);
    expect(got).toEqual({ size: BIG, sha256: expectedSha(BIG) });
    expect(readSpy).not.toHaveBeenCalled(); expect(f.count('get')).toBe(0);
    expect(probe.growthMiB(), `download grew ${probe.growthMiB().toFixed(1)} MiB`).toBeLessThanOrEqual(LIMIT_MIB);
  }, 120_000);

  it('download of a 50 MB object by Range (a PDF viewer reading the tail): only that range is read, growth <= 20 MB', async () => {
    const { f, storage } = await makeStreamStorage();
    f.seed('reports', PATH, { size: BIG, etag: '"big"' });
    const { createDownload } = await import('../download.js');
    const dl = createDownload({ storage, audit: { access: async () => {} } });
    const probe = memProbe();
    const res = await dl.stream({ bucket: 'reports', objectPath: PATH, filename: 'big.pdf', contentType: 'application/pdf', scanState: 'clean', access: { action: 'report.download', entityType: 'report', entityId: 'x', outcome: 'allowed' } as any, requestHeaders: { range: `bytes=${BIG - 5 * MiB}-` } } as any);
    expect(res.status).toBe(206);
    expect((await sink(res.body, probe)).size).toBe(5 * MiB); expect(f.pulled.bytes).toBe(5 * MiB);
    expect(probe.growthMiB()).toBeLessThanOrEqual(LIMIT_MIB);
  }, 120_000);

  it('upload: 50 MB from a source to storage through putStream; sha256 and size computed on the way; growth <= 20 MB', async () => {
    const { f, storage } = await makeStreamStorage('frontdesk');
    const p = `${TENANT_A}/2026/11/big-upload.pdf`;
    const probe = memProbe();
    // sample while the bytes flow: a tee that samples every 32 chunks without keeping anything
    let n = 0; const src = source(BIG);
    const watched = (async function* () { for await (const c of src) { if (++n % 32 === 0) probe.sample(); yield c; } })();
    const res = await storage.putStream('frontdesk-trf', p, watched, { contentType: 'application/pdf', ifAbsent: true });
    probe.sample();
    expect(res).toEqual({ sha256: expectedSha(BIG), byteSize: BIG });
    expect(f.count('putStream')).toBe(1); expect(f.count('put'), 'the whole-object put() must not be used for a stream').toBe(0);
    expect(f.stored('frontdesk-trf', p)).toMatchObject({ size: BIG, sha256: expectedSha(BIG) });
    expect(probe.growthMiB(), `upload grew ${probe.growthMiB().toFixed(1)} MiB`).toBeLessThanOrEqual(LIMIT_MIB);
  }, 120_000);
});
