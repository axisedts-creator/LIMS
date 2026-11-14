// T0D-17 integration against the dev-stack clamd and Storage. NOT run in the default verify (no container runtime, LD-51):
// set LIMS_TEST_CLAMD_URL=tcp://host:3310 and/or LIMS_TEST_STORAGE_URL + LIMS_CORE_STORAGE_KEY_FILE to run. Skipped otherwise by design.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TENANT_A, recorders } from '../../storage/__tests__/helpers.js';

const clamd = process.env.LIMS_TEST_CLAMD_URL;
const storageUrl = process.env.LIMS_TEST_STORAGE_URL;
const keyFile = process.env.LIMS_CORE_STORAGE_KEY_FILE;
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe.skipIf(!clamd)('live clamd', () => {
  it('EICAR => infected, plain text => clean', async () => {
    const { createFiles } = await import('../index.js');
    const files = createFiles({ env: { LIMS_CORE_SCANNER_URL: clamd, LIMS_CORE_SCANNER_TIMEOUT_MS: '30000' } });
    expect(await files.scan(Buffer.from(EICAR))).toBe('infected');
    expect(await files.scan(Buffer.from('synthetic lab report body'))).toBe('clean');
  });
});

describe.skipIf(!storageUrl || !keyFile)('live Storage', () => {
  it('put -> read -> move -> signedUrl -> delete round trip in an owned bucket, tenant-first', async () => {
    const { createStorage } = await import('../../storage/index.js');
    const r = recorders();
    const s = await createStorage({ env: { LIMS_CORE_STORAGE_KEY_FILE: keyFile }, readFile: (p: string) => readFileSync(p, 'utf8'), url: storageUrl,
      module: 'frontdesk', tenantId: TENANT_A, log: r.log, metrics: r.metrics });
    const a = `${TENANT_A}/live/${Date.now()}-a.bin`; const b = `${TENANT_A}/live/${Date.now()}-b.bin`;
    const body = new Uint8Array([1, 2, 3]);
    await s.put('frontdesk-trf', a, body, { contentType: 'application/octet-stream', ifAbsent: true });
    await expect(s.put('frontdesk-trf', a, body, { contentType: 'application/octet-stream', ifAbsent: true })).rejects.toThrow();
    expect([...(await s.read('frontdesk-trf', a))]).toEqual([1, 2, 3]);
    await s.move('frontdesk-trf', a, b);
    expect(typeof (await s.signedUrl('frontdesk-trf', b, 60))).toBe('string');
    await s.delete('frontdesk-trf', b);
    await expect(s.read('frontdesk-trf', b)).rejects.toThrow();
    expect(JSON.stringify(r.lines)).not.toMatch(/https?:\/\//);
  });
});
