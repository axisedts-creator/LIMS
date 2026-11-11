// PG-T01 worker skeleton: services/worker/src/jobs/payments/index.ts (02-TRD §3.1 worker tree, §8.2 consumes nothing, §8.3 tasks/cron, §9.3 boot checks
// "API and worker"; 02-CONVENTIONS §2.3). ASSUMED (writer: dispute via .orchestra/notes if wrong):
//   index.ts exports `manifest: WorkerManifest` (module 'payments') and, like the API module, validates LIMS_PAYMENTS_* at import (throws on a TRD §9.3 failure).
//   Tasks/crons not built yet may be absent; those that ARE registered must match §8.3 exactly (identifier, schedule, tenantScope, max_attempts).
// Run through the worker package: pnpm --dir services/worker exec vitest run src/jobs/payments/__tests__
// Fails now: ../../index.js does not exist.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateManifests } from '../../../../core/manifest.js';

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

describe('boot fails per TRD §9.3 in the worker too', () => {
  it('KEK file missing -> import throws naming the key', async () => {
    goodEnv({ LIMS_PAYMENTS_KEK_FILE: join(dir, 'missing.json') });
    await expect(load()).rejects.toThrow(/LIMS_PAYMENTS_KEK_FILE/);
  });
  it('active KEK key not 32 bytes -> import throws', async () => {
    const bad = join(dir, 'kek16.json');
    writeFileSync(bad, JSON.stringify({ keys: { k1: randomBytes(16).toString('base64') }, active: 'k1' }));
    goodEnv({ LIMS_PAYMENTS_KEK_FILE: bad });
    await expect(load()).rejects.toThrow(/LIMS_PAYMENTS_KEK_FILE/);
  });
  it('production gateway env with a sandbox URL -> import throws', async () => {
    goodEnv({ LIMS_PAYMENTS_GATEWAY_ENV: 'production', LIMS_PAYMENTS_ESEWA_FORM_URL: 'https://epay.esewa.com.np/api/epay/main/v2/form', LIMS_PAYMENTS_KHALTI_BASE_URL: 'https://dev.khalti.com/api/v2/' });
    vi.stubEnv('NODE_ENV', 'production');
    await expect(load()).rejects.toThrow(/LIMS_PAYMENTS_KHALTI_BASE_URL/);
  });
  it('uat with a production URL -> import throws', async () => {
    goodEnv({ LIMS_PAYMENTS_ESEWA_STATUS_URL: 'https://epay.esewa.com.np/api/epay/transaction/status/' });
    await expect(load()).rejects.toThrow(/LIMS_PAYMENTS_ESEWA_STATUS_URL/);
  });
  it('PUBLIC_BASE_URL not https -> import throws', async () => {
    goodEnv({ LIMS_PAYMENTS_PUBLIC_BASE_URL: 'http://api.lims.test' });
    await expect(load()).rejects.toThrow(/LIMS_PAYMENTS_PUBLIC_BASE_URL/);
  });
  it('ESEWA_FORM_URL empty in uat -> import throws', async () => {
    goodEnv({ LIMS_PAYMENTS_ESEWA_FORM_URL: '' });
    await expect(load()).rejects.toThrow(/LIMS_PAYMENTS_ESEWA_FORM_URL/);
  });
});
