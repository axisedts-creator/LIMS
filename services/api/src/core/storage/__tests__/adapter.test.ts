// T0D-17 API storage adapter: contract suite + source-level credential confinement + real metric registry.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMetrics } from '../../observability/metrics.js';
import { TENANT_A, fakeRaw, recorders, storageOpts } from './helpers.js';
import { storageSuite } from './suite.js';

storageSuite('api storage', () => import('../index.js') as any);

const CORE = fileURLToPath(new URL('../../', import.meta.url));            // services/api/src/core
const WORKER_CORE = join(CORE, '..', '..', '..', 'worker', 'src', 'core');
function sources(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules' && n !== '__fixtures__') sources(p, out); }
    else if (/\.(ts|js|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

describe('Storage credential is read only by core/storage/**', () => {
  it('no other core source (api or worker) mentions LIMS_CORE_STORAGE_KEY_FILE or a service-role key', () => {
    for (const root of [CORE, WORKER_CORE]) {
      for (const f of sources(root).filter((p) => !p.includes(`${sep}storage${sep}`))) {
        const t = readFileSync(f, 'utf8');
        expect(t, f).not.toMatch(/STORAGE_KEY_FILE|SERVICE_ROLE|STORAGE_SERVICE_KEY/);
      }
    }
  });
  it('the adapter itself reads LIMS_CORE_STORAGE_KEY_FILE and nothing else for the credential', () => {
    const t = sources(join(CORE, 'storage')).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(t).toContain('LIMS_CORE_STORAGE_KEY_FILE');
    expect(t).not.toMatch(/SERVICE_ROLE|STORAGE_SERVICE_KEY|process\.env\.LIMS_CORE_STORAGE_KEY\b(?!_FILE)/);
  });
});

describe('lims_core_storage_deletes_total in the real registry', () => {
  it('renders bucket and reason labels', async () => {
    const m = createMetrics(); const f = fakeRaw(); const r = recorders();
    const { createStorage } = await import('../index.js');
    const s = await createStorage({ ...storageOpts(f, r, 'frontdesk'), metrics: m });
    await s.delete('frontdesk-trf', `${TENANT_A}/trf/1.pdf`);
    expect(await m.render()).toMatch(/lims_core_storage_deletes_total\{(?=[^}]*bucket="frontdesk-trf")(?=[^}]*reason="[a-z_]+")[^}]*\} 1/);
  });
});
