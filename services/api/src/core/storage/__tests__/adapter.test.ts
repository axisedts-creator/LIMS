// T0D-17 API storage adapter: contract suite + source-level credential confinement + real metric registry.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMetrics } from '../../observability/metrics.js';
import { TENANT_A, fakeRaw, recorders, storageOpts } from './helpers.js';
import { storageSuite } from './suite.js';
import { findCredentialMaterial } from './credential-scan.js';

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
  // T0B-DEPFIX-1 (LD-312): scan for key MATERIAL (PEM, long hex/base64, JWT, service-role assignment), not for the variable NAME
  // (core/health.ts lists LIMS_CORE_STORAGE_KEY_FILE in REQUIRED_ENV; a name is not a secret). Both directions: credential-scan.test.ts.
  it('no other core source (api or worker) holds key material', () => {
    for (const root of [CORE, WORKER_CORE]) {
      for (const f of sources(root).filter((p) => !p.includes(`${sep}storage${sep}`))) {
        expect(findCredentialMaterial(readFileSync(f, 'utf8')), f).toEqual([]);
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
