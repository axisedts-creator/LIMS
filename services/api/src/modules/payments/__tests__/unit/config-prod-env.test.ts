// SEC-ENV-1 (LD-236; audit 10.2 / 6.6): site 3, payments/config.ts loadPaymentsConfig. Table over LIMS_CORE_ENV x NODE_ENV x LIMS_PAYMENTS_GATEWAY_ENV.
// Rule: GATEWAY_ENV must be `production` exactly when isProductionEnv(env) (LIMS_CORE_ENV or NODE_ENV is production). So a production boot with GATEWAY_ENV
// unset (default uat) or uat REFUSES to start, and a non-production boot cannot select the production gateway. Staging (LIMS_CORE_ENV=staging, NODE_ENV unset)
// with GATEWAY_ENV unset or uat loads exactly as before.
// Fails now: only NODE_ENV is read, so LIMS_CORE_ENV=production without NODE_ENV boots on the UAT gateway, and LIMS_CORE_ENV=production + GATEWAY_ENV=production is refused.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPaymentsConfig } from '../../config.js';

const dir = mkdtempSync(join(tmpdir(), 'sec-env-1-pay-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const kek = join(dir, 'kek.json');
writeFileSync(kek, JSON.stringify({ keys: { k1: randomBytes(32).toString('base64') }, active: 'k1' }));

const GE = 'LIMS_PAYMENTS_GATEWAY_ENV';
const CORE = [undefined, 'dev', 'ci', 'staging', 'production'] as const;
const NODE = [undefined, 'test', 'development', 'production'] as const;
const GW = [undefined, 'uat', 'production'] as const;
const prodMode = (core: string | undefined, node: string | undefined): boolean => core === 'production' || node === 'production';

/** Every other key valid for the chosen gateway; only the three env selectors vary. UAT esewa form URL has no default (TRD 9.1) so it is supplied for uat. */
const env = (core: string | undefined, node: string | undefined, gw: string | undefined): NodeJS.ProcessEnv => ({
  LIMS_CORE_ENV: core, NODE_ENV: node, [GE]: gw,
  LIMS_PAYMENTS_PUBLIC_BASE_URL: 'https://api.lims.test',
  LIMS_PAYMENTS_KEK_FILE: kek,
  LIMS_ORIGIN_STAFF_WEB: 'https://staff.lims.test',
  LIMS_ORIGIN_PORTAL: 'https://portal.lims.test',
  ...(gw === 'production' ? {} : { LIMS_PAYMENTS_ESEWA_FORM_URL: 'https://uat.esewa.com.np/api/epay/main/v2/form' }),
});
const effective = (gw: string | undefined): string => (gw === undefined ? 'uat' : gw);

describe('loadPaymentsConfig: LIMS_CORE_ENV x NODE_ENV x GATEWAY_ENV', () => {
  for (const core of CORE) for (const node of NODE) for (const gw of GW) {
    const ok = effective(gw) === 'production' === prodMode(core, node);
    it(`LIMS_CORE_ENV=${core} NODE_ENV=${node} GATEWAY_ENV=${gw} -> ${ok ? 'boots' : 'refuses'}`, () => {
      if (ok) expect(loadPaymentsConfig(env(core, node, gw)).gatewayEnv).toBe(effective(gw));
      else expect(() => loadPaymentsConfig(env(core, node, gw))).toThrow(/LIMS_PAYMENTS_GATEWAY_ENV/);
    });
  }
  it('headline: LIMS_CORE_ENV=production, NODE_ENV unset, GATEWAY_ENV unset or uat -> refuses (cannot reach the UAT gateway)', () => {
    expect(() => loadPaymentsConfig(env('production', undefined, undefined))).toThrow(/LIMS_PAYMENTS_GATEWAY_ENV/);
    expect(() => loadPaymentsConfig(env('production', undefined, 'uat'))).toThrow(/LIMS_PAYMENTS_GATEWAY_ENV/);
  });
  it('LIMS_CORE_ENV=production with GATEWAY_ENV=production boots on the production gateway hosts', () => {
    const c = loadPaymentsConfig(env('production', undefined, 'production'));
    expect(c.gatewayEnv).toBe('production');
    expect(new URL(c.esewaFormUrl).hostname).toBe('epay.esewa.com.np');
    expect(new URL(c.khaltiBaseUrl).hostname).toBe('khalti.com');
  });
  it('staging, NODE_ENV unset, GATEWAY_ENV unset or uat: unchanged (loads on the UAT gateway)', () => {
    for (const gw of [undefined, 'uat'] as const) {
      const c = loadPaymentsConfig(env('staging', undefined, gw));
      expect(c.gatewayEnv).toBe('uat');
      expect(new URL(c.khaltiBaseUrl).hostname).toBe('dev.khalti.com');
    }
  });
  it('staging, NODE_ENV unset, GATEWAY_ENV=production -> still refused (unchanged)', () => {
    expect(() => loadPaymentsConfig(env('staging', undefined, 'production'))).toThrow(/LIMS_PAYMENTS_GATEWAY_ENV/);
  });
  it('an invalid GATEWAY_ENV value is still refused in every mode', () => {
    for (const core of ['staging', 'production'] as const) {
      expect(() => loadPaymentsConfig(env(core, undefined, 'sandbox'))).toThrow(/LIMS_PAYMENTS_GATEWAY_ENV/);
    }
  });
  it('the refusal message names the key and leaks no key material or path content', () => {
    let msg = '';
    try { loadPaymentsConfig(env('production', undefined, undefined)); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('LIMS_PAYMENTS_GATEWAY_ENV');
    expect(msg).not.toContain(kek);
  });
});
