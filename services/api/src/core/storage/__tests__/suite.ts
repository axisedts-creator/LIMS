// T0D-17 storage adapter contract, run against BOTH services (api: ../index.js, worker: ../index.js). Prescribed API:
//   createStorage({ env, readFile, connect(credential)->raw, module, tenantId, log?, metrics?, url? }) -> StorageAdapter  (async or sync)
//   raw = { put(bucket,key,bytes,{contentType,ifAbsent}), get(bucket,key), move(bucket,from,to), remove(bucket,key), sign(bucket,key,ttl) }
import { describe, expect, it } from 'vitest';
import { BUCKETS, CREDENTIAL, KEY_FILE, MODULES, OWNERS, SIGNED, TENANT_A, TENANT_B, fakeRaw, recorders, sha256, storageOpts } from './helpers.js';

type Load = () => Promise<{ createStorage: (o: any) => any }>;
const mk = async (load: Load, module = 'reporting', tweak: (o: any) => void = () => {}) => {
  const f = fakeRaw(); const r = recorders(); const o = storageOpts(f, r, module); tweak(o);
  const { createStorage } = await load();
  return { f, r, s: await createStorage(o) };
};
const A = (p: string) => `${TENANT_A}/${p}`;
const OK = A('2026/11/r-v1.pdf');

export function storageSuite(name: string, load: Load): void {
  describe(`${name}: credential only from LIMS_CORE_STORAGE_KEY_FILE`, () => {
    it('reads the file named by the env var and hands the trimmed content to connect()', async () => {
      const { f } = await mk(load);
      expect(f.credentials).toEqual([CREDENTIAL]);
    });
    it('ignores any other env source of a Storage credential', async () => {
      const { f } = await mk(load, 'reporting', (o) => { o.env = { ...o.env, LIMS_CORE_STORAGE_KEY: 'OTHER-1', SUPABASE_SERVICE_ROLE_KEY: 'OTHER-2', STORAGE_SERVICE_KEY: 'OTHER-3', SERVICE_ROLE_KEY: 'OTHER-4' }; });
      expect(f.credentials.join()).not.toMatch(/OTHER/);
    });
    it.each([
      ['env var unset', (o: any) => { o.env = {}; }],
      ['env var empty', (o: any) => { o.env = { LIMS_CORE_STORAGE_KEY_FILE: '' }; }],
      ['file unreadable', (o: any) => { o.readFile = () => { throw new Error(`ENOENT ${KEY_FILE}`); }; }],
      ['file empty', (o: any) => { o.readFile = () => ''; }],
      ['file whitespace only', (o: any) => { o.readFile = () => ' \r\n\t'; }],
    ])('fails closed when %s (no raw client is built)', async (_n, tweak) => {
      const f = fakeRaw(); const r = recorders(); const o = storageOpts(f, r, 'reporting'); tweak(o);
      const { createStorage } = await load();
      await expect((async () => createStorage(o))()).rejects.toThrow();
      expect(f.credentials).toEqual([]);
    });
  });

  describe(`${name}: first path segment = tenant`, () => {
    const bad = [
      `${TENANT_B}/2026/x.pdf`, `${TENANT_A.toUpperCase()}/x.pdf`, '', TENANT_A, `${TENANT_A}/`, `/${TENANT_A}/x.pdf`,
      `${TENANT_A}/../${TENANT_B}/x.pdf`, `${TENANT_A}/./x.pdf`, `${TENANT_A}//x.pdf`, `${TENANT_A}\\x.pdf`, `${TENANT_A}/x\0.pdf`,
      `${TENANT_A}/%2e%2e/${TENANT_B}/x.pdf`, `${TENANT_A}x/a.pdf`, `${TENANT_B}/${TENANT_A}/x.pdf`, 'x.pdf',
    ];
    it.each(bad)('rejects %j on every operation and never reaches the raw service', async (p) => {
      const { f, s } = await mk(load);
      const bytes = new Uint8Array([1]);
      await expect(s.put('reports', p, bytes, { contentType: 'application/pdf' })).rejects.toThrow();
      await expect(s.read('reports', p)).rejects.toThrow();
      await expect(s.move('reports', p, OK)).rejects.toThrow();
      await expect(s.move('reports', OK, p)).rejects.toThrow();
      await expect(s.signedUrl('reports', p, 60)).rejects.toThrow();
      await expect(s.delete('reports', p)).rejects.toThrow();
      expect(f.calls).toEqual([]);
    });
    it('accepts a normal tenant-first path and round-trips bytes', async () => {
      const { s } = await mk(load);
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const out = await s.put('reports', OK, bytes, { contentType: 'application/pdf' });
      expect(out).toEqual({ sha256: sha256(bytes), byteSize: 4 });
      expect(Buffer.from(await s.read('reports', OK))).toEqual(Buffer.from(bytes));
    });
    it('a tenant-B adapter cannot touch tenant-A objects', async () => {
      const f = fakeRaw(); const r = recorders(); const { createStorage } = await load();
      const a = await createStorage(storageOpts(f, r, 'reporting', TENANT_A));
      const b = await createStorage(storageOpts(f, r, 'reporting', TENANT_B));
      await a.put('reports', OK, new Uint8Array([9]), { contentType: 'application/pdf' });
      await expect(b.read('reports', OK)).rejects.toThrow();
      await expect(b.delete('reports', OK)).rejects.toThrow();
      expect(f.objects.size).toBe(1);
    });
  });

  describe(`${name}: owner-bucket-only writes`, () => {
    it('put/move/delete succeed only in buckets owned by the calling module (full matrix)', async () => {
      for (const module of [...MODULES, 'core']) {
        for (const bucket of BUCKETS) {
          const { f, s } = await mk(load, module);
          const owned = OWNERS[bucket] === module;
          const put = s.put(bucket, OK, new Uint8Array([1]), { contentType: 'application/pdf' });
          if (owned) await put; else await expect(put).rejects.toThrow();
          if (!owned) expect(f.calls, `${module} put ${bucket}`).toEqual([]);
          f.objects.set(`${bucket}|${OK}`, { bytes: Buffer.from([1]), contentType: 'x' }); f.calls.length = 0;
          const mv = s.move(bucket, OK, A('2026/11/moved.pdf'));
          const del = s.delete(bucket, OK);
          if (owned) { await mv; await del; } else { await expect(mv).rejects.toThrow(); await expect(del).rejects.toThrow(); expect(f.calls, `${module} move/delete ${bucket}`).toEqual([]); }
        }
      }
    });
    it('unknown and reserved buckets are refused', async () => {
      const { f, s } = await mk(load);
      for (const b of ['reporting-legacy', 'nope', '', '../reports'])
        await expect(s.put(b, OK, new Uint8Array([1]), { contentType: 'application/pdf' })).rejects.toThrow();
      expect(f.calls).toEqual([]);
    });
    it('ifAbsent never overwrites an existing object', async () => {
      const { f, s } = await mk(load);
      await s.put('reports', OK, new Uint8Array([1]), { contentType: 'application/pdf', ifAbsent: true });
      await expect(s.put('reports', OK, new Uint8Array([2]), { contentType: 'application/pdf', ifAbsent: true })).rejects.toThrow();
      expect([...f.objects.get(`reports|${OK}`)!.bytes]).toEqual([1]);
    });
  });

  describe(`${name}: signedUrl and delete accounting`, () => {
    it('signedUrl ttl is 1..300 seconds', async () => {
      const { s } = await mk(load);
      expect(await s.signedUrl('reports', OK, 300)).toContain(SIGNED.slice(0, 20));
      for (const ttl of [301, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) await expect(s.signedUrl('reports', OK, ttl)).rejects.toThrow();
    });
    it('every delete increments lims_core_storage_deletes_total{bucket,reason} exactly once', async () => {
      const { f, r, s } = await mk(load, 'frontdesk');
      const p = A('trf/1.pdf'); f.objects.set(`frontdesk-trf|${p}`, { bytes: Buffer.from([1]), contentType: 'x' });
      await s.delete('frontdesk-trf', p);
      const d = r.incs.filter((i) => i.name === 'lims_core_storage_deletes_total');
      expect(d).toHaveLength(1);
      expect(d[0]!.labels).toMatchObject({ bucket: 'frontdesk-trf' });
      expect(String(d[0]!.labels!.reason)).toMatch(/^[a-z][a-z_]*$/);
      expect(Object.keys(d[0]!.labels!).sort()).toEqual(['bucket', 'reason']);
    });
    it('a refused or failed delete is not counted', async () => {
      const { f, r, s } = await mk(load, 'frontdesk');
      await expect(s.delete('reports', OK)).rejects.toThrow();
      await expect(s.delete('frontdesk-trf', `${TENANT_B}/x.pdf`)).rejects.toThrow();
      f.state.failWith = new Error('boom');
      await expect(s.delete('frontdesk-trf', A('trf/2.pdf'))).rejects.toThrow();
      expect(r.incs.filter((i) => i.name === 'lims_core_storage_deletes_total')).toEqual([]);
    });
  });

  describe(`${name}: no secret or signed URL leaves the adapter`, () => {
    it('raw failures surface as LimsError without credential, URL or path text; logs stay clean', async () => {
      const { f, r, s } = await mk(load);
      const url = await s.signedUrl('reports', OK, 60);
      f.state.failWith = new Error(`401 Authorization: Bearer ${CREDENTIAL} at ${SIGNED} for ${OK}`);
      for (const op of [() => s.put('reports', OK, new Uint8Array([1]), { contentType: 'application/pdf' }), () => s.read('reports', OK),
        () => s.move('reports', OK, A('m.pdf')), () => s.delete('reports', OK), () => s.signedUrl('reports', OK, 60)]) {
        const e = await op().then(() => undefined, (x: unknown) => x as Error & { code?: string; detail?: string });
        expect(e, 'must reject').toBeDefined();
        expect(e!.name).toBe('LimsError');
        const dump = `${e!.message} ${e!.detail ?? ''} ${JSON.stringify(e)} ${e!.stack ?? ''}`;
        expect(dump).not.toContain(CREDENTIAL); expect(dump).not.toContain('storage.invalid');
      }
      const all = JSON.stringify([r.lines, r.incs]);
      expect(all).not.toContain(CREDENTIAL); expect(all).not.toContain('storage.invalid'); expect(all).not.toContain(url);
    });
  });
}
