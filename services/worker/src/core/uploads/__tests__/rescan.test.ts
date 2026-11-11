// T0D-17 worker: ctx.files.scan for re-scan jobs (A17 P-19) = scan(await storage.read(bucket, path)); the worker never accepts multipart
// and has no download helper.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanSuite, fakeClamd } from '../../../../../api/src/core/uploads/__tests__/suite.js';
import { TENANT_A, fakeRaw, recorders, storageOpts } from '../../../../../api/src/core/storage/__tests__/helpers.js';

scanSuite('worker uploads', () => import('../index.js') as any);

describe('worker re-scan flow', () => {
  it('scan(storage.read(...)) detects an infected stored object and passes a clean one', async () => {
    const f = fakeRaw(); const r = recorders();
    const { createStorage } = await import('../../storage/index.js'); const { createFiles } = await import('../index.js');
    const s = await createStorage(storageOpts(f, r, 'reporting'));
    await s.put('reporting-inputs', `${TENANT_A}/quarantine/bad.pdf`, Buffer.from('EICAR-MARK'), { contentType: 'application/pdf' });
    await s.put('reporting-inputs', `${TENANT_A}/quarantine/ok.pdf`, Buffer.from('fine'), { contentType: 'application/pdf' });
    const c = await fakeClamd((p) => (p.includes('EICAR-MARK') ? 'stream: X FOUND\0' : 'stream: OK\0'));
    try {
      const files = createFiles({ env: { LIMS_CORE_SCANNER_URL: c.url, LIMS_CORE_SCANNER_TIMEOUT_MS: '2000' } });
      expect(await files.scan(await s.read('reporting-inputs', `${TENANT_A}/quarantine/bad.pdf`))).toBe('infected');
      expect(await files.scan(await s.read('reporting-inputs', `${TENANT_A}/quarantine/ok.pdf`))).toBe('clean');
    } finally { await c.close(); }
  });
});

describe('worker is not an upload or download surface', () => {
  const dir = fileURLToPath(new URL('../', import.meta.url));
  it('no multipart parser, no accept(), no download helper', async () => {
    const src = readdirSync(dir).filter((n) => /\.(ts|js)$/.test(n)).map((n) => readFileSync(dir + n, 'utf8')).join('\n');
    expect(src).not.toMatch(/multipart|busboy/i);
    expect((await import('../index.js') as any).createUploads).toBeUndefined();
    expect(existsSync(fileURLToPath(new URL('../../storage/download.ts', import.meta.url)))).toBe(false);
  });
});
