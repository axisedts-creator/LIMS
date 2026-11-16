// T0B-ASYNC-1 (audit RS-10 / RS-11; LD-277): the staging async path. A job the API queues must be able to run on a worker.
// done_when (1): ONE list of manifests, loaded by main.ts, covering every services/worker/src/jobs/<m>/index.ts.
// done_when (3): every task identifier the API or the worker passes to app.enqueue_job is declared by a loaded manifest.
// done_when (6)/(7) static halves: the runbook exists without secrets; render.yaml still has no worker service.
//
// SEAM (the writer creates it; raise a dispute if another path is needed):
//   services/worker/src/manifests.ts   export const MANIFESTS: readonly WorkerManifest[]   (the only list; main.ts and registry-sync import it)
// Scan limits (documented, not hidden): only string-literal identifiers are found; a computed identifier (`${m}.${t}`) is invisible here.
// Identifiers are the module-prefixed literals found in a source file that mentions app.enqueue_job / enqueue( / enqueueJob / taskIdentifier,
// minus error codes (contracts/errors.yaml), tables/views (db/meta/tables.yaml) and `v_pub_*` views.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MODULE_NAMES, REPO_ROOT } from '../../../../api/src/core/module.js';

import { PAYMENTS_ENV_NAMES, stubPaymentsEnv } from './async-env.js';

// importing every jobs module through vite the first time takes well over the default 5 s
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const WORKER_SRC = join(REPO_ROOT, 'services', 'worker', 'src');
const API_SRC = join(REPO_ROOT, 'services', 'api', 'src');
const read = (p: string) => readFileSync(p, 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === '__tests__' || e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e) && !/\.(test|spec|fakes?)\.ts$/.test(e)) out.push(p);
  }
  return out;
}

const jobsWithIndex = readdirSync(join(WORKER_SRC, 'jobs')).filter((d) => existsSync(join(WORKER_SRC, 'jobs', d, 'index.ts'))).sort();

let cached: Promise<any> | undefined;
async function loadManifests() {
  stubPaymentsEnv();
  cached ??= import('../../manifests.js');
  const mod = await cached;
  return mod.MANIFESTS as ReadonlyArray<{ module: string; tasks?: Record<string, unknown>; crontab?: Array<{ identifier: string }> }>;
}

describe('(1) one manifest list, every jobs module in it', () => {
  it('there are jobs modules to load (the scan itself works)', () => {
    expect(jobsWithIndex.length).toBeGreaterThanOrEqual(15);
    expect(jobsWithIndex).toEqual(expect.arrayContaining(['identity', 'billing', 'engagement', 'partners', 'quality', 'micro', 'inventory']));
  });

  it('MANIFESTS names exactly the modules that have services/worker/src/jobs/<m>/index.ts, once each', async () => {
    const loaded = (await loadManifests()).map((m) => m.module);
    expect(new Set(loaded).size).toBe(loaded.length);
    const missing = jobsWithIndex.filter((m) => !loaded.includes(m));
    expect(missing, `jobs modules with an index.ts that main.ts would not load: ${missing.join(', ')}`).toEqual([]);
    const extra = loaded.filter((m) => !jobsWithIndex.includes(m));
    expect(extra, `manifests without a jobs index.ts: ${extra.join(', ')}`).toEqual([]);
  });

  it('each loaded manifest is the one that jobs/<m>/index.ts exports (not a copy)', async () => {
    const loaded = await loadManifests();
    stubPaymentsEnv();
    const all = import.meta.glob('../../jobs/*/index.ts');   // static glob: vite cannot resolve a computed import path
    for (const m of jobsWithIndex) {
      const exported = ((await all[`../../jobs/${m}/index.ts`]!()) as { manifest: unknown }).manifest;
      expect(loaded.find((x) => x.module === m), m).toBe(exported);
    }
  });

  it('the identity, billing, catalog-adjacent and engagement modules that were missing are in the list (RS-10 regression)', async () => {
    const loaded = (await loadManifests()).map((m) => m.module);
    for (const m of ['identity', 'billing', 'partners', 'quality', 'micro', 'inventory', 'engagement', 'instruments', 'lab', 'reporting']) expect(loaded, m).toContain(m);
  });

  it('the list is valid: buildTaskList accepts it (no duplicate task, no unknown module)', async () => {
    const { buildTaskList } = await import('../tasklist.js');
    const deps: any = { db: {}, withTenantScope: async () => undefined, systemActorOf: () => 'x', coreActorId: 'x', metrics: { inc() {}, set() {}, observe() {} }, log: { child: () => ({}), info() {}, warn() {}, error() {} }, now: () => new Date(0), events: {}, core: {}, storage: {}, files: {}, audit: {} };
    const built = buildTaskList(deps, (await loadManifests()) as any);
    const ids = built.registry.map((e) => e.identifier);
    expect(ids).toEqual(expect.arrayContaining(['identity.send_invitation', 'identity.send_recovery', 'core.event_fanout']));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('main.ts takes the list from the one place and names no module itself', () => {
    const main = read(join(WORKER_SRC, 'main.ts'));
    expect(main).toMatch(/from '\.\/manifests\.js'/);
    expect(main).not.toMatch(/from '\.\/jobs\//);
    expect(main).not.toMatch(/manifests:\s*\[/);
  });

  it('registry-sync and main.ts use the same list (a manifest cannot be loaded by one and not the other)', () => {
    expect(read(join(WORKER_SRC, 'core', 'registry-sync.ts'))).toMatch(/manifests\.js/);
    expect(read(join(WORKER_SRC, 'core', 'registry-sync.ts'))).not.toMatch(/from '\.\.\/jobs\//);
  });
});

// ---------------------------------------------------------------------------------------------------------------- (3) the identifier scan
const errorCodes = new Set([...read(join(REPO_ROOT, 'contracts', 'errors.yaml')).matchAll(/code:\s*([a-z_]+\.[a-z0-9_]+)/g)].map((m) => m[1]!));
const tables = new Set([...read(join(REPO_ROOT, 'db', 'meta', 'tables.yaml')).matchAll(/"([a-z_]+\.[a-z0-9_]+)":\s*\{/g)].map((m) => m[1]!));
const NAMESPACES = new Set((MODULE_NAMES as readonly string[]).filter((m) => m !== 'core'));

function enqueuedIdentifiers(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of [...walk(API_SRC), ...walk(WORKER_SRC)]) {
    const s = read(f);
    if (!/enqueue_job|enqueue\(|enqueueJob|taskIdentifier/.test(s)) continue;
    for (const m of s.matchAll(/(["'`])([a-z_]+\.[a-z0-9_]+)\1/g)) {
      const id = m[2]!;
      if (/templateCode:\s*$/.test(s.slice(Math.max(0, m.index! - 20), m.index!))) continue;   // a message template code (reporting.dues_due), not a task
      if (!NAMESPACES.has(id.split('.')[0]!) || errorCodes.has(id) || tables.has(id) || /\.v_pub_/.test(id)) continue;
      found.set(id, [...(found.get(id) ?? []), f.slice(REPO_ROOT.length + 1).replace(/\\/g, '/')]);
    }
  }
  return found;
}

describe('(3) every enqueued identifier is declared by a loaded manifest', () => {
  const found = enqueuedIdentifiers();

  it('the scan finds the identifiers we know exist (positive control)', () => {
    for (const id of ['identity.send_invitation', 'identity.send_recovery', 'analytics.build_export', 'reporting.render_report_version']) expect([...found.keys()], id).toContain(id);
    expect(found.size).toBeGreaterThanOrEqual(30);
  });

  // LD-279 (2026-11-16): done_when (3) allowed seven known gaps, CR-C0-T0B-ASYNC-1-001. The list can only shrink.
  // T0B-ASYNC-2 (done_when (3)) removed the five catalog and homecollection identifiers (manifests written); two identity identifiers stay (LD-189, founder).
  const CR = 'CR-C0-T0B-ASYNC-1-001';
  const KNOWN_GAP: Record<string, string> = {
    'identity.notify_ip_throttle': `no worker task; founder decision under LD-189 (implement or remove the enqueue) (${CR})`,
    'identity.rescan_upload': `no worker task; founder decision under LD-189 (implement or remove the enqueue) (${CR})`,
  };

  const loadedIds = async () => {
    const declared = new Set<string>(['core.event_fanout', 'core.retention_purge', 'core.queue_depth_probe']);
    for (const m of await loadManifests()) {
      for (const id of Object.keys(m.tasks ?? {})) declared.add(id);
    }
    return declared;
  };

  it('the known-gap list is exactly the two identity identifiers still open under LD-189 (the five catalog/homecollection ones are gone), each with a reason and the CR id', () => {
    expect(Object.keys(KNOWN_GAP).sort()).toEqual(['identity.notify_ip_throttle', 'identity.rescan_upload']);
    for (const [id, reason] of Object.entries(KNOWN_GAP)) expect(reason, id).toContain(CR);
  });

  it('the five LD-279 catalog and homecollection identifiers are enqueued by the API and declared by a loaded manifest (T0B-ASYNC-2)', async () => {
    const declared = await loadedIds();
    for (const id of ['catalog.export_build', 'catalog.import_validate', 'catalog.import_commit', 'homecollection.flag_handover_discrepancy', 'homecollection.refresh_visit_specimens']) {
      expect([...found.keys()], `${id} is no longer enqueued: the scan control is stale`).toContain(id);
      expect(declared.has(id), `${id} is enqueued but no loaded manifest declares it`).toBe(true);
    }
  });

  it('catalog and homecollection are in MANIFESTS, each is the object its jobs/<m>/index.ts exports', async () => {
    const loaded = await loadManifests();
    for (const m of ['catalog', 'homecollection']) {
      expect(jobsWithIndex, `services/worker/src/jobs/${m}/index.ts`).toContain(m);
      expect(loaded.map((x) => x.module), m).toContain(m);
    }
  });

  it('every identifier is a task (or cron) of a loaded manifest, a core task, or on the KNOWN_GAP list', async () => {
    const declared = await loadedIds();
    // an identifier that is only a string constant in a file that also enqueues (e.g. a log event name) is not a task: it must still be
    // a task identifier shape '<module>.<snake>' and is then required to be declared. Keep the false positives out of the source, not out of this test.
    const unknown = [...found].filter(([id]) => !declared.has(id) && !(id in KNOWN_GAP)).map(([id, files]) => `${id}  (${[...new Set(files)].slice(0, 2).join(', ')})`);
    expect(unknown, `enqueued but not declared by any loaded manifest and not a KNOWN_GAP: app.enqueue_job raises unknown_task_identifier\n${unknown.join('\n')}`).toEqual([]);
  });

  it('the list can only shrink: no KNOWN_GAP identifier is loaded now (remove it from KNOWN_GAP)', async () => {
    const declared = await loadedIds();
    const nowLoaded = Object.keys(KNOWN_GAP).filter((id) => declared.has(id));
    expect(nowLoaded, `listed as a known gap but a loaded manifest declares it: ${nowLoaded.join(', ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------- (6) runbook, (7) no render.yaml change
describe('(6) docs/runbooks/staging-worker.md', () => {
  const p = join(REPO_ROOT, 'docs', 'runbooks', 'staging-worker.md');
  it('exists and is short enough to follow', () => {
    expect(existsSync(p)).toBe(true);
    const t = read(p);
    expect(t.length).toBeGreaterThan(400);
    expect(t.length).toBeLessThan(12_000);
  });
  it('names the environment variables the worker and registry-sync read (names only)', () => {
    const t = read(p);
    for (const name of ['LIMS_CORE_WORKER_DATABASE_URL', 'LIMS_CORE_ENV']) expect(t, name).toContain(name);
    expect(t).toMatch(/registry-sync[\s\S]{0,600}LIMS_[A-Z_]*DATABASE_URL|LIMS_[A-Z_]*DATABASE_URL[\s\S]{0,600}registry-sync/);   // the variable registry-sync reads is named next to the command
    expect(t).toMatch(/pnpm --filter @lims\/worker registry-sync/);
    expect(t).toMatch(/pnpm --filter @lims\/worker start/);
  });
  it('names the payments variables: jobs/payments/index.ts validates its config at import, so a worker that loads every manifest refuses to start without them', () => {
    const t = read(p);
    for (const name of PAYMENTS_ENV_NAMES) expect(t, name).toContain(name);
  });
  it('says what to look for in the logs', () => {
    const t = read(p);
    expect(t).toMatch(/unknown_task_identifier/);
    expect(t).toMatch(/common\.service_unavailable|503/);
    expect(t).toMatch(/send_invitation/);
  });
  it('carries no secret: no connection string with a password, no key, no token value', () => {
    const t = read(p);
    expect(t).not.toMatch(/postgres(ql)?:\/\/[^\s:@/]+:[^\s@]+@/i);
    expect(t).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(t).not.toMatch(/(secret|password|token|key)\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{16,}/i);
    expect(t).not.toMatch(/AKIA[0-9A-Z]{12,}/);
  });
});

describe('(7) render.yaml is unchanged: no hosted worker (founder cost decision)', () => {
  it('render.yaml defines no worker service', () => {
    const p = join(REPO_ROOT, 'render.yaml');
    expect(existsSync(p)).toBe(true);
    const t = read(p);
    expect(t).not.toMatch(/^\s*-?\s*type:\s*(worker|bgw|background_worker)\b/m);
    expect(t).not.toMatch(/services\/worker|@lims\/worker/);
  });
});
