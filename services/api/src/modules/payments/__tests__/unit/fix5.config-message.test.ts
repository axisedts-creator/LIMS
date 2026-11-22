// T0D-FIX-5, LD-449 (a)(b): the equality check of LIMS_PAYMENTS_GATEWAY_ENV against the process mode stays EXACTLY as it is (config-prod-env.test.ts keeps proving that),
// and when it refuses, the boot error says what the process has, what it expects, and the fix: the same value on web, api and worker.
// NOT testable here: "names the service" - loadPaymentsConfig(env) is given no service name (no LIMS_SERVICE-style variable exists); the sentence "web, api and worker" is pinned instead.
// Fails now: the message only says "must be production exactly when LIMS_CORE_ENV or NODE_ENV is production" (no held value, no fix).
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadPaymentsConfig } from '../../config.js';

const dir = mkdtempSync(join(tmpdir(), 'fix5-pay-cfg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const kek = join(dir, 'kek.json');
writeFileSync(kek, JSON.stringify({ keys: { k1: randomBytes(32).toString('base64') }, active: 'k1' }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const GE = 'LIMS_PAYMENTS_GATEWAY_ENV';
const env = (core: string | undefined, gw: string | undefined, node: string | undefined = undefined): NodeJS.ProcessEnv => ({
  LIMS_CORE_ENV: core, NODE_ENV: node, [GE]: gw,
  LIMS_PAYMENTS_PUBLIC_BASE_URL: 'https://api.lims.test', LIMS_PAYMENTS_KEK_FILE: kek,
  LIMS_ORIGIN_STAFF_WEB: 'https://staff.lims.test', LIMS_ORIGIN_PORTAL: 'https://portal.lims.test',
  ...(gw === 'production' ? {} : { LIMS_PAYMENTS_ESEWA_FORM_URL: 'https://uat.esewa.com.np/api/epay/main/v2/form' }),
});
const refusal = (e: NodeJS.ProcessEnv): string => { try { loadPaymentsConfig(e); } catch (err) { return (err as Error).message; } return ''; };

// [process mode, value it has, value it expects]
const MISMATCHES: Array<[string, string | undefined, string | undefined, 'uat' | 'production', 'uat' | 'production']> = [
  ['production process, GATEWAY_ENV=uat', 'production', 'uat', 'uat', 'production'],
  ['production process, GATEWAY_ENV unset (default uat)', 'production', undefined, 'uat', 'production'],
  ['staging process, GATEWAY_ENV=production', 'staging', 'production', 'production', 'uat'],
];

describe('LD-449 (b): the refusal names the key, the value it has, the value it expects, and the fix', () => {
  it.each(MISMATCHES)('%s', (_n, core, gw, has, expects) => {
    const msg = refusal(env(core, gw));
    expect(msg, 'the check must still refuse').not.toBe('');
    expect(msg).toContain(GE);
    expect(msg, 'the value this process has').toMatch(new RegExp(`(has|have|is set to|set to|got|found|current|actual)[^\\n.]{0,40}\\b${has}\\b`, 'i'));
    expect(msg, 'the value it expects').toMatch(new RegExp(`(expect|expected|requires?|needs?|wants?|must be)[^\\n.]{0,60}\\b${expects}\\b`, 'i'));
    expect(msg, 'the fix').toMatch(/same value/i);
    expect(msg, 'the fix names the three services').toMatch(/web,\s*api,?\s*and\s*worker/i);
  });

  it('an invalid value is still refused (closed set uat | production) and the message still names the key', () => {
    for (const bad of ['staging', 'PRODUCTION ', 'Uat', 'sandbox']) expect(refusal(env('staging', bad)), bad).toContain(GE);
  });

  it('the message leaks no key file path or content', () => {
    const msg = refusal(env('production', 'uat'));
    expect(msg).not.toContain(kek);
    expect(msg).not.toContain(dir);
  });

  it('the equality rule itself is unchanged: matching values boot, in both modes', () => {
    expect(loadPaymentsConfig(env('staging', 'uat')).gatewayEnv).toBe('uat');
    expect(loadPaymentsConfig(env('staging', undefined)).gatewayEnv).toBe('uat');
    expect(loadPaymentsConfig(env('production', 'production')).gatewayEnv).toBe('production');
  });

  it('boot: importing the module in a mismatched process throws the same message (the api refuses to start, it does not serve)', async () => {
    vi.resetModules();
    vi.stubEnv('LIMS_CORE_ENV', 'production');
    vi.stubEnv(GE, 'uat');
    await expect(import('../../index.js')).rejects.toThrow(/web,\s*api,?\s*and\s*worker/i);
  });
});
