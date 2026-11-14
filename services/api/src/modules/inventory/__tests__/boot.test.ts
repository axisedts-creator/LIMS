// C12.T-01 — inventory module skeleton boot tests (06-IMPLEMENTATION-PLAN T-01; 02-TRD §3.1, §5, §9, §11; IC §3.25; CR-C12-001).
// Interface these tests expect (see .orchestra/notes/C12.T-01-tests.md):
//   modules/inventory/index.ts          export const manifest: ModuleManifest {name:'inventory', openapi, handlers, produces: []}
//   modules/inventory/permissions.ts    exports (any names) whose string values include every inventory.<x>.<y> code of 02-TRD §5
//   modules/inventory/config.ts         export function loadInventoryConfig(env) — LIMS_INVENTORY_* (02-TRD §11); throws naming the bad key
//   modules/inventory/handlers/index.ts export const handlers: one function per operationId of 02-TRD §5 (stubs reject code common.internal)
//   worker jobs/inventory/index.ts      export const manifest: WorkerManifest (02-TRD §9)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../../core/bootstrap.js';
import { loadConfig } from '../../../core/config.js';
import { DEFAULT_MODULES_DIR, REPO_ROOT, validateManifest } from '../../../core/module.js';

const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const TRD = read('spec', 'chunks', 'C12-inventory', '02-TRD.md');
const IC = read('spec', 'program', '03-INTERFACE-CATALOG.md');
const section = (md: string, re: RegExp): string => {
  const s = md.search(re);
  if (s < 0) throw new Error(`section ${re} not found`);
  const rest = md.slice(s + 3);
  const e = rest.search(/^## /m);
  return md.slice(s, e < 0 ? undefined : s + 3 + e);
};

// ---- spec-derived expectations (the spec is the oracle, not the implementation) ----
const trd5 = section(TRD, /^## 5\. Endpoints/m);
const rows5 = trd5.split('\n').filter((l) => /^\| \d+ \| \w+ \|/.test(l)).map((l) => l.split('|').map((c) => c.trim()));
const SPEC_OPS = rows5.map((c) => c[2]!);
const SPEC_PERMS = new Set(rows5.flatMap((c) => c[4]!.match(/inventory\.[a-z]+\.[a-z]+/g) ?? []));
const YAML_PERMS = new Set([...read('contracts', 'permissions.yaml').matchAll(/code: (inventory\.[a-z]+\.[a-z]+)/g)].map((m) => m[1]!));
/** IC §3.25 rows whose Consumers cell lists C12 -> event types. */
const C12_EVENTS = [...IC.matchAll(/^\| \d+ \| ([a-z_.]+\.v1)[^|]*\| (C\d+) \| ([^|]*) \|/gm)]
  .filter((m) => m[3]!.split(/[\s()]+/).includes('C12'))
  .map((m) => m[1]!)
  .sort();
const trd9 = section(TRD, /^## 9\. Background jobs/m);
const SPEC_TASKS = [...trd9.matchAll(/^\s+'(inventory\.[a-z_]+)': /gm)].map((m) => m[1]!).sort();

const modUrl = (...p: string[]) => pathToFileURL(join(REPO_ROOT, ...p)).href;
const importApi = (f: string) => import(modUrl('services', 'api', 'src', 'modules', 'inventory', f));
const importWorker = () => import(modUrl('services', 'worker', 'src', 'jobs', 'inventory', 'index.ts'));

const strings = (v: unknown, out: unknown[] = []): unknown[] => {
  if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  else out.push(v);
  return out;
};

describe('spec oracles are sane (guard against a broken parser making tests vacuous)', () => {
  it('parses the TRD §5 operation table, §9 task list and IC consumer list', () => {
    expect(SPEC_OPS.length).toBeGreaterThanOrEqual(90);
    expect(new Set(SPEC_OPS).size).toBe(SPEC_OPS.length);
    expect(SPEC_PERMS.size).toBeGreaterThanOrEqual(8);
    expect(SPEC_TASKS).toHaveLength(6);
    expect(C12_EVENTS).toEqual(['instruments.calibration.received.v1', 'instruments.qc.received.v1', 'instruments.result.received.v1', 'lab.result.verified.v1']);
  });
});

describe('API manifest (02-TRD §3.1)', () => {
  it('exports manifest {name inventory, openapi inventory.yaml, produces [] (CM §5.1), no foreign ports}', async () => {
    const { manifest } = await importApi('index.ts');
    expect(manifest.name).toBe('inventory');
    expect(manifest.openapi).toBe('contracts/openapi/inventory.yaml');
    expect(manifest.produces).toEqual([]);
    expect(Object.keys(manifest.ports ?? {})).toEqual([]);
    expect(manifest.claimsResolver).toBeUndefined();
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual([]);
  });

  it('passes the core autoloader validation against the real spec (handler set == spec operationIds, produces == EVENT_PRODUCERS)', async () => {
    const { manifest } = await importApi('index.ts');
    expect(existsSync(join(REPO_ROOT, 'contracts', 'openapi', 'inventory.yaml'))).toBe(true);
    expect(() => validateManifest('inventory', manifest, REPO_ROOT)).not.toThrow();
  });
});

describe('handler map (02-TRD §3.1, §5): one handler per operationId, stubs throw common.internal', () => {
  it('handler keys equal the operationIds of TRD §5 exactly', async () => {
    const { handlers } = await importApi('handlers/index.ts');
    expect(Object.keys(handlers).sort()).toEqual([...SPEC_OPS].sort());
    for (const [k, h] of Object.entries(handlers)) expect(typeof h, k).toBe('function');
  });

  it('manifest.handlers is the same map', async () => {
    const { manifest } = await importApi('index.ts');
    const { handlers } = await importApi('handlers/index.ts');
    expect(Object.keys(manifest.handlers).sort()).toEqual(Object.keys(handlers).sort());
  });

  // ponytail: narrow this list per task as handlers are implemented (T-06+); every op must be a stub until then.
  it('every not-yet-implemented handler rejects with an error whose code is common.internal (no silent success, no 200)', async () => {
    const { handlers } = await importApi('handlers/index.ts');
    // Ruling C12.T-07-ruling: ops #1-#10 are implemented by T-07 (06-IMPLEMENTATION-PLAN.md:24,30); their behaviour is covered by T-07 tests.
    const { itemHandlers } = await importApi('handlers/items.ts');
    // Ruling C12.T-08-ruling: ops #11-#25 are implemented by T-08 (06-IMPLEMENTATION-PLAN.md:31).
    const { masterHandlers } = await importApi('handlers/masters.ts');
    const implemented = new Set([...Object.keys(itemHandlers), ...Object.keys(masterHandlers)]);
    const noop = () => {};
    const ctx = { log: { info: noop, warn: noop, error: noop } };
    for (const [op, h] of Object.entries<any>(handlers)) {
      if (implemented.has(op)) continue;
      const err = await h({ params: {}, query: {}, headers: {}, body: {} }, { operationId: op, ...ctx }).then(() => null, (e: unknown) => e);
      expect(err, `${op} must reject`).not.toBeNull();
      expect((err as any).code, `${op} error code`).toBe('common.internal');
    }
  });
});

describe('permissions.ts (02-TRD §5, CR-C12-001)', () => {
  it('declares every permission code used in TRD §5, and every one exists in contracts/permissions.yaml', async () => {
    const declared = new Set(strings(await importApi('permissions.ts')).filter((s): s is string => typeof s === 'string'));
    for (const p of SPEC_PERMS) {
      expect(YAML_PERMS.has(p), `${p} in permissions.yaml`).toBe(true);
      expect(declared.has(p), `${p} declared in permissions.ts`).toBe(true);
    }
  });

  it('invents no inventory.<x>.<y> code that permissions.yaml does not define', async () => {
    const mod = await importApi('permissions.ts');
    const codes = strings(mod).filter((s): s is string => typeof s === 'string' && /^inventory\.[a-z]+\.[a-z]+$/.test(s));
    expect(codes.length).toBeGreaterThan(0);
    for (const c of codes) expect(YAML_PERMS.has(c), c).toBe(true);
  });
});

describe('config.ts (02-TRD §11)', () => {
  const defaults = [366, 5000, 50000, 1000, 7];
  const load = async (env: Record<string, string>) => {
    const m = await importApi('config.ts');
    expect(typeof m.loadInventoryConfig).toBe('function');
    return m.loadInventoryConfig(env);
  };

  it('with an empty env returns the documented defaults', async () => {
    const vals = strings(await load({}));
    for (const d of defaults) expect(vals, `default ${d}`).toContain(d);
    expect(JSON.stringify(await load({}))).toMatch(/1,\s*2,\s*5|\[1,2,5\]|"1,2,5"/);
  });

  it('env overrides apply (LIMS_INVENTORY_REPORT_MAX_DAYS=90)', async () => {
    const vals = strings(await load({ LIMS_INVENTORY_REPORT_MAX_DAYS: '90' }));
    expect(vals).toContain(90);
    expect(vals).not.toContain(366);
  });

  it.each([
    ['LIMS_INVENTORY_REPORT_MAX_DAYS', 'abc'],
    ['LIMS_INVENTORY_REPORT_MAX_DAYS', '0'],
    ['LIMS_INVENTORY_EXPORT_MAX_ROWS', '-5'],
    ['LIMS_INVENTORY_RESOLVE_BATCH', '1.5'],
    ['LIMS_INVENTORY_RESOLUTION_STEPS', '1,x'],
  ])('fails fast naming the key: %s=%s', async (k, v) => {
    await expect(load({ [k]: v })).rejects.toThrow(new RegExp(k));
  });
});

describe('worker manifest (02-TRD §9; IC §3.25 consumer lists)', () => {
  it('module inventory; tasks are exactly the six of §9, identifiers inventory.<snake>', async () => {
    const { manifest } = await importWorker();
    expect(manifest.module).toBe('inventory');
    expect(Object.keys(manifest.tasks ?? {}).sort()).toEqual(SPEC_TASKS);
    for (const [k, h] of Object.entries(manifest.tasks)) expect(typeof h, k).toBe('function');
  });

  it('manifest CI check: subscriptions are exactly the C12 consumer events and ⊆ IC §3.25 consumer lists', async () => {
    const { manifest } = await importWorker();
    const subs = Object.keys(manifest.subscriptions ?? {}).sort();
    for (const e of subs) expect(C12_EVENTS, `${e} lists C12 as consumer in IC §3.25`).toContain(e);
    expect(subs).toEqual(C12_EVENTS);
    for (const [k, h] of Object.entries(manifest.subscriptions)) expect(typeof h, k).toBe('function');
    for (const e of subs) expect(existsSync(join(REPO_ROOT, 'contracts', 'events', `${e}.schema.json`)), `${e} schema`).toBe(true);
  });

  it('crontab: 5 per_tenant UTC entries on declared tasks (08 A13 P-6); resolve_unresolved is enqueued, not cron', async () => {
    const { manifest } = await importWorker();
    const cron = manifest.crontab as { identifier: string; schedule: string; tenantScope: string }[];
    const want: Record<string, string> = {
      'inventory.daily_fixed_consumption': '15 19 * * *',
      'inventory.daily_alert_scan': '30 19 * * *',
      'inventory.balance_integrity_check': '45 19 * * *',
      'inventory.reconciliation_scan': '0 20 * * *',
      'inventory.purge_alerts': '0 21 * * 0',
    };
    expect(Object.fromEntries(cron.map((c) => [c.identifier, c.schedule]))).toEqual(want);
    for (const c of cron) {
      expect(c.tenantScope, c.identifier).toBe('per_tenant');
      expect(Object.keys(manifest.tasks)).toContain(c.identifier);
    }
  });
});

describe('API boot with the real module directory', () => {
  let app: Awaited<ReturnType<typeof bootstrap>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('boots (autoloads inventory from services/api/src/modules) and mounts the /v1/inventory routes', async () => {
    expect(readdirSync(DEFAULT_MODULES_DIR)).toContain('inventory');
    app = await bootstrap({ config: loadConfig({ ...process.env, LIMS_CORE_ENV: 'ci' }), repoRoot: REPO_ROOT, modulesDir: DEFAULT_MODULES_DIR });
    const r = await app.inject({ method: 'GET', url: '/v1/inventory/items' });
    expect(r.statusCode).not.toBe(404); // mounted; stub => 500 common.internal (or 401 once auth lands), never a 2xx
    expect(r.statusCode).not.toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/inventory/not-in-spec' })).statusCode).toBe(404);
  });
});
