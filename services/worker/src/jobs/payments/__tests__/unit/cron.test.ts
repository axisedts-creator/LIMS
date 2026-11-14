// PG-T11 (C15) — schedule wiring (02-TRD §8.3, "Schedule per TRD §8.3"): services/worker/src/jobs/payments/cron.ts and the manifest in index.ts.
// SEAM (frontdesk/cron.ts pattern): cron.ts `export const crontab: readonly CronEntry[]`; index.ts registers the tasks and spreads that crontab into `manifest.crontab`.
// poll_intent and sweep_open_intents must be registered in manifest.tasks with max_attempts 8 / 3. Entries for tasks of other PG-T tasks (reconcile_*, check_refund,
// rewrap_credentials) are optional here: whatever is present must match §8.3 exactly (manifest.test.ts already checks every registered row).
// Fails now: ../../cron.js does not exist.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateManifests } from '../../../../core/manifest.js';

const dir = mkdtempSync(join(tmpdir(), 'pg-t11-worker-'));
let kek = '';
const ENV: Record<string, string> = {
  LIMS_PAYMENTS_GATEWAY_ENV: 'uat', LIMS_PAYMENTS_PUBLIC_BASE_URL: 'https://api.lims.test',
  LIMS_PAYMENTS_ESEWA_FORM_URL: 'https://uat.esewa.com.np/api/epay/main/v2/form', LIMS_PAYMENTS_RETURN_URL_ALLOWLIST: 'https://app.lims.test/',
};
beforeAll(() => { kek = join(dir, 'kek.json'); writeFileSync(kek, JSON.stringify({ keys: { k1: randomBytes(32).toString('base64') }, active: 'k1' })); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
const envOk = () => { for (const [k, v] of Object.entries({ ...ENV, LIMS_PAYMENTS_KEK_FILE: kek })) vi.stubEnv(k, v); };
const manifest = async (): Promise<any> => { vi.resetModules(); return (await import('../../index.js')).manifest; };

describe('cron.ts (TRD §8.3)', () => {
  it('schedules payments.sweep_open_intents at */15 * * * * UTC, per_tenant, max_attempts 3', async () => {
    envOk(); const { crontab } = await import('../../cron.js');
    const e = crontab.find((c: any) => c.identifier === 'payments.sweep_open_intents');
    expect(e).toMatchObject({ identifier: 'payments.sweep_open_intents', schedule: '*/15 * * * *', tenantScope: 'per_tenant', maxAttempts: 3 });
    expect(crontab.filter((c: any) => c.identifier === 'payments.sweep_open_intents')).toHaveLength(1);
  });
  it('poll_intent is a task enqueued at create, NOT a cron entry', async () => {
    envOk(); const { crontab } = await import('../../cron.js');
    expect(crontab.some((c: any) => c.identifier === 'payments.poll_intent')).toBe(false);
  });
  it('every entry is one of the TRD §8.3 crons with its exact schedule and scope', async () => {
    envOk(); const { crontab } = await import('../../cron.js');
    const CRONS: Record<string, [string, string]> = { 'payments.sweep_open_intents': ['*/15 * * * *', 'per_tenant'], 'payments.reconcile_tenant': ['40 20 * * *', 'per_tenant'], 'payments.rewrap_credentials': ['10 21 * * *', 'per_tenant'] };
    for (const c of crontab) { expect(Object.keys(CRONS), c.identifier).toContain(c.identifier); expect([c.schedule, c.tenantScope], c.identifier).toEqual(CRONS[c.identifier]); }
  });
});

describe('manifest registers the PG-T11 tasks', () => {
  it('poll_intent (max_attempts 8) and sweep_open_intents (3) are tasks; the crontab is cron.ts; validateManifests passes', async () => {
    envOk(); const m = await manifest(); const { crontab } = await import('../../cron.js');
    expect(typeof m.tasks['payments.poll_intent']).toBe('function'); expect(typeof m.tasks['payments.sweep_open_intents']).toBe('function');
    expect(m.maxAttempts['payments.poll_intent']).toBe(8); expect(m.maxAttempts['payments.sweep_open_intents']).toBe(3);
    expect(m.crontab.map((c: any) => c.identifier).sort()).toEqual(crontab.map((c: any) => c.identifier).sort());
    expect(() => validateManifests([m])).not.toThrow();
  });
});
