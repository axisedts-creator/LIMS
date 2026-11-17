// SEC-AUTHZ-2 review item 2: the BOOT validates authz-exceptions.json against the real operationIds (done_when: "existing operationId").
// bootPipeline must fail when the file names an operationId that no loaded module contract has; an empty list boots.
import { afterEach, describe, expect, it, vi } from 'vitest';

let fileContent = '[]';
vi.mock('node:fs', async (orig) => {
  const real: any = await orig();
  const readFileSync = (p: any, ...rest: any[]) => (String(p).endsWith('authz-exceptions.json') ? fileContent : real.readFileSync(p, ...rest));
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const metrics = { set() {}, inc() {}, observe() {} };
const boot = async () => {
  vi.resetModules();
  const { loadConfig } = await import('../../config.js');
  const { bootPipeline } = await import('../boot.js');
  const config = loadConfig({ ...process.env, LIMS_CORE_ENV: 'ci', LIMS_CORE_DATABASE_URL: '' } as Record<string, string>);
  return bootPipeline({ config, modules: [], log: quiet as any, metrics: metrics as any });
};
afterEach(() => { fileContent = '[]'; });

describe('bootPipeline and authz-exceptions.json', () => {
  it('an empty list boots', async () => {
    const b = await boot();
    await b.close();
  });
  it('an entry naming an unknown operationId stops the boot, naming it', async () => {
    fileContent = JSON.stringify([{ operationId: 'noSuchOperationAnywhere', handlerPermission: 'frontdesk.order.manage', reason: 'synthetic' }]);
    await expect(boot()).rejects.toThrow(/noSuchOperationAnywhere/);
  });
  it('an entry with an empty reason stops the boot', async () => {
    fileContent = JSON.stringify([{ operationId: 'noSuchOperationAnywhere', handlerPermission: 'frontdesk.order.manage', reason: ' ' }]);
    await expect(boot()).rejects.toThrow(/authz-exceptions/);
  });
});
