// PG-T01 worker skeleton: services/worker/src/jobs/payments/index.ts (02-TRD §3.1 worker tree, §8.2 consumes nothing, §8.3 tasks/cron, §9.3 boot checks
// "API and worker"; 02-CONVENTIONS §2.3). ASSUMED (writer: dispute via .orchestra/notes if wrong):
//   index.ts exports `manifest: WorkerManifest` (module 'payments'). T0B-ASYNC-3 (LD-341, CR T0B-ASYNC-3 option B): LIMS_PAYMENTS_* is NOT validated at import any more
//   (registry-sync imports every manifest and must run without them). The TRD §9.3 boot check runs at WORKER START: startWorker() (core/bootstrap.ts) rejects, before
//   graphile-worker run(), when the manifests it is given include 'payments' and loadPaymentsConfig() throws. Was: "import throws".
//   Tasks/crons not built yet may be absent; those that ARE registered must match §8.3 exactly (identifier, schedule, tenantScope, max_attempts).
// Run through the worker package: pnpm --dir services/worker exec vitest run src/jobs/payments/__tests__
// Fails now: ../../index.js does not exist.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateManifests } from '../../../../core/manifest.js';

// graphile-worker run() is a recording double: the boot check must reject BEFORE it, so a bad config never opens a connection.
const gw = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('graphile-worker', async (orig) => ({ ...(await orig<typeof import('graphile-worker')>()), run: gw.run }));
beforeEach(() => { gw.run.mockReset(); gw.run.mockResolvedValue({ stop: async () => undefined, promise: Promise.resolve() }); });

const dir = mkdtempSync(join(tmpdir(), 'pg-t01-worker-'));
let kek = '';
const GOOD_ENV: Record<string, string> = {
  LIMS_PAYMENTS_GATEWAY_ENV: 'uat',
  LIMS_PAYMENTS_PUBLIC_BASE_URL: 'https://api.lims.test',
  LIMS_PAYMENTS_ESEWA_FORM_URL: 'https://uat.esewa.com.np/api/epay/main/v2/form',
  LIMS_PAYMENTS_RETURN_URL_ALLOWLIST: 'https://app.lims.test/',
};
beforeAll(() => {
  kek = join(dir, 'kek.json');
  writeFileSync(kek, JSON.stringify({ keys: { k1: randomBytes(32).toString('base64') }, active: 'k1' }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
const goodEnv = (over: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries({ ...GOOD_ENV, LIMS_PAYMENTS_KEK_FILE: kek, ...over })) vi.stubEnv(k, v);
};
const load = async (): Promise<any> => { vi.resetModules(); return (await import('../../index.js')).manifest; };
const deps: any = { db: {}, withTenantScope: async () => undefined, systemActorOf: () => 'x', coreActorId: 'x', metrics: { inc() {}, set() {}, observe() {} }, log: { child: () => ({}), info() {}, warn() {}, error() {} }, now: () => new Date(0), events: {}, core: {}, storage: {}, files: {}, audit: {} };
// worker start: the payments manifest is imported (the import must succeed whatever the env) and handed to startWorker.
// A throw while importing index.ts is NOT a worker start failure: it is recorded and fails the test in afterEach (so "import throws" cannot pass these).
let importError: unknown;
afterEach(() => { const e = importError; importError = undefined; vi.unstubAllEnvs(); vi.resetModules(); if (e) throw new Error(`jobs/payments/index.ts threw at import (must be at worker start): ${(e as Error).message}`); });
const start = async () => {
  vi.resetModules();
  const manifest = (await import('../../index.js').catch((e) => { importError = e; throw e; })).manifest;
  const { startWorker } = await import('../../../../core/bootstrap.js');
  return startWorker({ deps, manifests: [manifest], connectionString: 'postgres://lims_worker@127.0.0.1:1/none' });   // never reached: run() is the double
};
const clearPaymentsEnv = () => { for (const k of Object.keys(process.env)) if (k.startsWith('LIMS_PAYMENTS_')) vi.stubEnv(k, undefined as unknown as string); };

// TRD §8.3 (identifier -> max_attempts) and cron rows (identifier -> [schedule, tenantScope]).
const TASKS: Record<string, number> = {
  'payments.poll_intent': 8, 'payments.sweep_open_intents': 3, 'payments.reconcile_tenant': 3, 'payments.reconcile_batch': 3,
  'payments.execute_refund': 1, 'payments.check_refund': 8, 'payments.rewrap_credentials': 3,
};
const CRONS: Record<string, [string, string]> = {
  'payments.sweep_open_intents': ['*/15 * * * *', 'per_tenant'],
  'payments.reconcile_tenant': ['40 20 * * *', 'per_tenant'],
  'payments.rewrap_credentials': ['10 21 * * *', 'per_tenant'],
};

describe('worker manifest', () => {
  it('is the payments WorkerManifest and passes validateManifests (namespace, cron syntax, attempts)', async () => {
    goodEnv();
    const m = await load();
    expect(m.module).toBe('payments');
    expect(() => validateManifests([m])).not.toThrow();
  });

  it('registers only TRD §8.3 task identifiers, each with its documented max_attempts when set', async () => {
    goodEnv();
    const m = await load();
    for (const id of Object.keys(m.tasks ?? {})) {
      expect(Object.keys(TASKS), id).toContain(id);
      expect(typeof m.tasks[id]).toBe('function');
      if (m.maxAttempts?.[id] !== undefined) expect(m.maxAttempts[id], id).toBe(TASKS[id]);
    }
    for (const id of Object.keys(m.maxAttempts ?? {})) expect(Object.keys(TASKS), id).toContain(id);
  });

  it('every crontab entry matches the §8.3 schedule and tenantScope, and has a registered task', async () => {
    goodEnv();
    const m = await load();
    for (const c of m.crontab ?? []) {
      expect(Object.keys(CRONS), c.identifier).toContain(c.identifier);
      expect([c.schedule, c.tenantScope], c.identifier).toEqual(CRONS[c.identifier]);
      expect(Object.keys(m.tasks ?? {}), c.identifier).toContain(c.identifier);
    }
  });

  it('consumes no events (§8.2): no subscriptions', async () => {
    goodEnv();
    const m = await load();
    expect(Object.keys(m.subscriptions ?? {})).toEqual([]);
  });
});

describe('T0B-ASYNC-3 (LD-341): importing the payments manifest runs no config check', () => {
  it('with NO LIMS_PAYMENTS_* variable set the module imports and exports its manifest (registry-sync needs exactly this)', async () => {
    clearPaymentsEnv();
    expect((await load()).module).toBe('payments');
  });
  it('with an invalid config (non-https PUBLIC_BASE_URL, missing KEK file) the import still succeeds', async () => {
    goodEnv({ LIMS_PAYMENTS_PUBLIC_BASE_URL: 'http://api.lims.test', LIMS_PAYMENTS_KEK_FILE: join(dir, 'missing.json') });
    await expect(load()).resolves.toBeTruthy();
  });
  it('index.ts has no top-level loadPaymentsConfig() call (static)', () => {
    const raw = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*loadPaymentsConfig\(/m);
    expect(code).not.toMatch(/^loadPaymentsConfig\(/m);
  });
});

describe('boot fails per TRD §9.3 at worker start (was: at import)', () => {
  it('good config -> startWorker passes the boot check and calls run() once', async () => {
    goodEnv();
    await start();
    expect(gw.run).toHaveBeenCalledTimes(1);
  });
  it('KEK file missing -> startWorker rejects naming the key, run() never called', async () => {
    goodEnv({ LIMS_PAYMENTS_KEK_FILE: join(dir, 'missing.json') });
    await expect(start()).rejects.toThrow(/LIMS_PAYMENTS_KEK_FILE/);
    expect(gw.run).not.toHaveBeenCalled();
  });
  it('active KEK key not 32 bytes -> startWorker rejects', async () => {
    const bad = join(dir, 'kek16.json');
    writeFileSync(bad, JSON.stringify({ keys: { k1: randomBytes(16).toString('base64') }, active: 'k1' }));
    goodEnv({ LIMS_PAYMENTS_KEK_FILE: bad });
    await expect(start()).rejects.toThrow(/LIMS_PAYMENTS_KEK_FILE/);
    expect(gw.run).not.toHaveBeenCalled();
  });
  it('production gateway env with a sandbox URL -> startWorker rejects', async () => {
    goodEnv({ LIMS_PAYMENTS_GATEWAY_ENV: 'production', LIMS_PAYMENTS_ESEWA_FORM_URL: 'https://epay.esewa.com.np/api/epay/main/v2/form', LIMS_PAYMENTS_KHALTI_BASE_URL: 'https://dev.khalti.com/api/v2/' });
    vi.stubEnv('NODE_ENV', 'production');
    await expect(start()).rejects.toThrow(/LIMS_PAYMENTS_KHALTI_BASE_URL/);
    expect(gw.run).not.toHaveBeenCalled();
  });
  it('uat with a production URL -> startWorker rejects', async () => {
    goodEnv({ LIMS_PAYMENTS_ESEWA_STATUS_URL: 'https://epay.esewa.com.np/api/epay/transaction/status/' });
    await expect(start()).rejects.toThrow(/LIMS_PAYMENTS_ESEWA_STATUS_URL/);
    expect(gw.run).not.toHaveBeenCalled();
  });
  it('PUBLIC_BASE_URL not https -> startWorker rejects', async () => {
    goodEnv({ LIMS_PAYMENTS_PUBLIC_BASE_URL: 'http://api.lims.test' });
    await expect(start()).rejects.toThrow(/LIMS_PAYMENTS_PUBLIC_BASE_URL/);
    expect(gw.run).not.toHaveBeenCalled();
  });
  it('ESEWA_FORM_URL empty in uat -> startWorker rejects', async () => {
    goodEnv({ LIMS_PAYMENTS_ESEWA_FORM_URL: '' });
    await expect(start()).rejects.toThrow(/LIMS_PAYMENTS_ESEWA_FORM_URL/);
    expect(gw.run).not.toHaveBeenCalled();
  });
  it('no LIMS_PAYMENTS_* at all -> startWorker rejects "PUBLIC_BASE_URL is required" (the founder run of 2026-11-16 19:17 now fails here, never in registry-sync)', async () => {
    clearPaymentsEnv();
    await expect(start()).rejects.toThrow(/LIMS_PAYMENTS_PUBLIC_BASE_URL is required/);
    expect(gw.run).not.toHaveBeenCalled();
  });
});
