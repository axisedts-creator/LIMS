// CR TENANT-LOGO-1: STORAGE_SIGNING_HOST. A Supabase Storage server with STORAGE_PUBLIC_URL set verifies S3 signatures against that URL's
// host[:port], not the address the request arrived on (production finding, reproduced by tests/core/STORAGE-KIT-1.pg.sh with
// STORAGE_KIT_PUBLIC_URL). The client then signs with that host while still sending to its endpoint.
import { describe, expect, it } from 'vitest';
import { createS3RawStorage, parseStorageConfig, presignV4 } from '../s3.js';

const BASE = { STORAGE_PROVIDER: 's3_compatible', STORAGE_ENDPOINT: 'http://172.30.20.9:5000/s3', STORAGE_REGION: 'stub', STORAGE_BUCKET: 'lims-files',
  STORAGE_ACCESS_KEY_ID: 'SYNTHETICKEYID0000001', STORAGE_SECRET_ACCESS_KEY: 'synthetic-secret-not-a-real-key', STORAGE_FORCE_PATH_STYLE: 'true' };
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const sig = (u: string) => new URL(u).searchParams.get('X-Amz-Signature');
const input = (url: string, signHost?: string) => ({ method: 'PUT', url, region: 'stub', accessKeyId: BASE.STORAGE_ACCESS_KEY_ID, secretAccessKey: BASE.STORAGE_SECRET_ACCESS_KEY,
  now: NOW, expiresSeconds: 60, ...(signHost ? { signHost } : {}) });

describe('presignV4 signHost', () => {
  it('the URL keeps the real address; only the signature changes, and it equals the signature of the same request at the signing host', () => {
    const real = 'http://172.30.20.9:5000/s3/lims-files/identity-assets/t/a.png';
    const plain = presignV4(input(real)); const withHost = presignV4(input(real, 'api.example.test:8443'));
    expect(new URL(withHost).host).toBe('172.30.20.9:5000'); expect(new URL(withHost).pathname).toBe(new URL(plain).pathname);
    expect(sig(withHost)).not.toBe(sig(plain));
    expect(sig(withHost)).toBe(sig(presignV4(input('http://api.example.test:8443/s3/lims-files/identity-assets/t/a.png'))));
  });
  it('without signHost nothing changes (the host of the URL is signed)', () => {
    const real = 'http://172.30.20.9:5000/s3/lims-files/x'; expect(sig(presignV4(input(real)))).toBe(sig(presignV4(input(real, '172.30.20.9:5000'))));
  });
});

describe('STORAGE_SIGNING_HOST config', () => {
  it('absent: no signingHost key at all', () => { expect('signingHost' in parseStorageConfig(BASE)).toBe(false); });
  it.each([['api.example.test:8443', 'api.example.test:8443'], ['API.Example.Test', 'api.example.test'], ['172.30.20.9:5000', '172.30.20.9:5000']])('%s is accepted as %s', (v, want) => {
    expect((parseStorageConfig({ ...BASE, STORAGE_SIGNING_HOST: v }) as any).signingHost).toBe(want);
  });
  it.each(['https://api.example.test', 'api.example.test/storage/v1', 'user@api.example.test', 'api.example.test:port', 'a b', 'api.example.test?x=1', '-bad.example.test'])(
    '%s is refused at boot, and the message names the key, never the value', (v) => {
      let msg = ''; try { parseStorageConfig({ ...BASE, STORAGE_SIGNING_HOST: v }); } catch (e: any) { msg = String(e.message); }
      expect(msg).toMatch(/^config: STORAGE_SIGNING_HOST /); expect(msg).not.toContain(v);
    });
  it('set without a provider: boot refuses the half set, like every other STORAGE_ name', () => {
    expect(() => parseStorageConfig({ STORAGE_SIGNING_HOST: 'api.example.test' })).toThrow(/STORAGE_PROVIDER is required/);
  });
  it('the client sends to the endpoint and signs with the configured host', async () => {
    const seen: string[] = [];
    const cfg = parseStorageConfig({ ...BASE, STORAGE_SIGNING_HOST: 'api.example.test:8443' }) as any;
    const raw = createS3RawStorage(cfg, { now: () => NOW, fetch: (async (u: string) => { seen.push(String(u)); return new Response('x', { status: 200 }); }) as unknown as typeof fetch });
    await raw.get('identity-assets', 't/a.png');
    expect(new URL(seen[0]!).host).toBe('172.30.20.9:5000');
    expect(sig(seen[0]!)).toBe(sig(presignV4({ ...input('http://api.example.test:8443/s3/lims-files/identity-assets/t/a.png'), method: 'GET' })));
  });
});
