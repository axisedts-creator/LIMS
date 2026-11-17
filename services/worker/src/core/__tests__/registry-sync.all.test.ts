// T0B-ASYNC-1 done_when (2): registry-sync runs for ALL manifests as one documented command and is idempotent.
//   pnpm --filter @lims/worker registry-sync   (package.json script -> src/core/registry-sync.ts, run through tools/node-ts/register.mjs)
// SEAM (writer): registry-sync.ts also exports  syncAllManifests(client: SyncClient): Promise<{ upserted: number; deactivated: number }>
//   = syncRegistry(client, buildTaskList(<inert deps>, MANIFESTS).registry), MANIFESTS from ../manifests.js. syncRegistry itself is unchanged.
//   The CLI entry (only when the file is run directly, never on import) reads LIMS_CORE_WORKER_DATABASE_URL, connects, calls syncAllManifests, exits non-zero on error.
// The registry table, its policies and the SET LOCAL ROLE lims_owner step do not change (tested in registry-sync.test.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../../../../api/src/core/module.js';

import { PAYMENTS_ENV_NAMES } from './async-env.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });   // first import of every jobs module through vite is slow
// T0B-ASYNC-3 (LD-282, done_when 5): the sync reads only task identifiers, so it must run with NO module config variable set. The stub that
// T0B-ASYNC-1 needed (jobs/payments/index.ts validates its config at import) is gone: any import-time check now fails this file.
for (const name of PAYMENTS_ENV_NAMES) delete process.env[name];

function fakeClient(existing: Array<{ identifier: string; is_active: boolean }> = []) {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  return {
    stmts,
    async query(text: string, values: unknown[] = []) {
      const t = text.replace(/\s+/g, ' ').trim();
      stmts.push({ text: t, values });
      if (/^SELECT[\s\S]*FROM\s+core\.g_task_registry/i.test(t)) return { rows: existing };
      return { rows: [] };
    },
  };
}
const written = (c: ReturnType<typeof fakeClient>): string[] =>
  c.stmts.filter((s) => /INSERT\s+INTO\s+core\.g_task_registry/i.test(s.text)).flatMap((s) => (s.values[0] as string[]) ?? []);

describe('syncAllManifests', () => {
  it('writes the identifiers of every module, including the ones the audit found missing (identity, billing, partners, quality, micro, inventory, engagement)', async () => {
    const { syncAllManifests } = await import('../registry-sync.js');
    const c = fakeClient();
    const r = await syncAllManifests(c);
    const ids = written(c);
    for (const id of ['identity.send_invitation', 'identity.send_recovery', 'core.event_fanout', 'core.retention_purge', 'core.queue_depth_probe', 'instruments.scan_attachment', 'reporting.render_report_version']) expect(ids, id).toContain(id);
    for (const m of ['identity', 'billing', 'partners', 'quality', 'micro', 'inventory', 'engagement', 'lab']) expect(ids.some((i) => i.startsWith(`${m}.`) || i.startsWith(`evt.${m}.`)), m).toBe(true);
    expect(r.upserted).toBe(ids.length);
    expect(r.deactivated).toBe(0);
  });

  it('T0B-ASYNC-2: writes the four catalog and homecollection identifiers that can run (CR-C0-T0B-ASYNC-1-001), so the enqueue is no longer refused', async () => {
    const { syncAllManifests } = await import('../registry-sync.js');
    const c = fakeClient();
    await syncAllManifests(c);
    const ids = written(c);
    for (const id of ['catalog.export_build', 'catalog.import_validate', 'catalog.import_commit', 'homecollection.flag_handover_discrepancy']) expect(ids, id).toContain(id);
    // still open: the two identity identifiers (LD-189, founder decision) and refresh_visit_specimens (needs LabPort, CR-C0-T0B-ASYNC-2-001)
    for (const id of ['identity.notify_ip_throttle', 'identity.rescan_upload', 'homecollection.refresh_visit_specimens']) expect(ids, id).not.toContain(id);
  });

  it('is idempotent: a second run over the rows the first one wrote upserts the same set and deactivates nothing', async () => {
    const { syncAllManifests } = await import('../registry-sync.js');
    const first = fakeClient();
    await syncAllManifests(first);
    const second = fakeClient(written(first).map((identifier) => ({ identifier, is_active: true })));
    const r = await syncAllManifests(second);
    expect(written(second).slice().sort()).toEqual(written(first).slice().sort());
    expect(r.deactivated).toBe(0);
    expect(second.stmts.some((s) => /UPDATE\s+core\.g_task_registry\s+SET\s+is_active\s*=\s*false/i.test(s.text))).toBe(false);
    expect(second.stmts.some((s) => /\bDELETE\b/i.test(s.text))).toBe(false);
  });

  it('only deactivates an identifier that no manifest declares any more (never deletes)', async () => {
    const { syncAllManifests } = await import('../registry-sync.js');
    const c = fakeClient([{ identifier: 'identity.retired_task', is_active: true }, { identifier: 'identity.send_invitation', is_active: true }]);
    const r = await syncAllManifests(c);
    expect(r.deactivated).toBe(1);
    const upd = c.stmts.find((s) => /UPDATE\s+core\.g_task_registry/i.test(s.text));
    expect(JSON.stringify(upd?.values)).toContain('identity.retired_task');
    expect(JSON.stringify(upd?.values)).not.toContain('identity.send_invitation');
  });

  it('one transaction as lims_owner, rolled back and rethrown when a statement fails (a half-synced registry is never committed)', async () => {
    const { syncAllManifests } = await import('../registry-sync.js');
    const c = fakeClient();
    const q = c.query.bind(c);
    c.query = async (t: string, v?: unknown[]) => { if (/^INSERT INTO core\.g_task_registry/i.test(t.replace(/\s+/g, ' ').trim())) throw new Error('boom'); return q(t, v); };
    await expect(syncAllManifests(c)).rejects.toThrow('boom');
    const texts = c.stmts.map((s) => s.text);
    expect(texts).toContain('ROLLBACK');
    expect(texts).not.toContain('COMMIT');
  });

  it('importing registry-sync.ts never connects or exits (the CLI runs only when the file is the entry point)', async () => {
    const mod = await import('../registry-sync.js');
    expect(typeof mod.syncRegistry).toBe('function');
    expect(typeof mod.syncAllManifests).toBe('function');
  });
});

// T0B-ASYNC-3 done_when (5), "other modules may have the same import-time checks: the test finds them". Dynamic proof = the tests above (every manifest
// imported with no module variable). Static proof = no jobs file runs a load*Config()/validate*Config() call at module top level (column 0).
// Finding of the tester (grep 2026-11-17): payments/index.ts was the only one; the rest call load*Config() inside a task or consumer, at run time.
describe('no jobs module validates its config at import', () => {
  const JOBS = join(REPO_ROOT, 'services', 'worker', 'src', 'jobs');
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === '__tests__' || e.name === 'node_modules') continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name)) files.push(p); } };
  walk(JOBS);
  it('the scan sees the jobs files (positive control)', () => { expect(files.length).toBeGreaterThan(50); });
  it('no top-level (column 0) call of a load*Config / validate*Config function in services/worker/src/jobs', () => {
    const hits: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      for (const m of code.matchAll(/^(?:export\s+)?(?:(?:const|let|var)\s+[\w{}, ]+\s*=\s*|await\s+)?(?:load|validate|parse)\w*Config\w*\(/gm)) hits.push(`${f.slice(JOBS.length + 1)}: ${m[0]}`);
    }
    expect(hits, `import-time config check(s): move to worker start\n${hits.join('\n')}`).toEqual([]);
  });
});

describe('the one command', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'services', 'worker', 'package.json'), 'utf8'));
  it('package.json has a registry-sync script that runs src/core/registry-sync.ts the same way start runs main.ts', () => {
    const s: string = pkg.scripts['registry-sync'];
    expect(s).toBeTruthy();
    expect(s).toMatch(/--import \.\.\/\.\.\/tools\/node-ts\/register\.mjs/);
    expect(s).toMatch(/src\/core\/registry-sync\.ts/);
    expect(s).not.toMatch(/&&|;|\|/);
  });
  it('the existing scripts are unchanged', () => {
    expect(pkg.scripts.start).toBe('node --import ../../tools/node-ts/register.mjs src/main.ts');
    expect(pkg.scripts.test).toBe('vitest run');
  });
  it('the file has a main-module guard that reads its connection string from an LIMS_*_DATABASE_URL variable (the migrator login, not the worker login: it must SET ROLE lims_owner) and holds no URL with a value', () => {
    const src = readFileSync(join(REPO_ROOT, 'services', 'worker', 'src', 'core', 'registry-sync.ts'), 'utf8');
    expect(src).toMatch(/process\.env\.LIMS_[A-Z_]*DATABASE_URL|env\.LIMS_[A-Z_]*DATABASE_URL|env\['LIMS_[A-Z_]*DATABASE_URL'\]/);
    expect(src).toMatch(/process\.argv\[1\]|import\.meta\.main|import\.meta\.url/);
    expect(src).not.toMatch(/postgres(ql)?:\/\/[^\s'"`]+:[^\s'"`@]+@/i);
  });
});
