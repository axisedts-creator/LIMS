// SEC-ENV-1 (LD-236; audit 10.2 and 6.6): ONE production-mode helper. Table tests over LIMS_CORE_ENV x NODE_ENV (x GATEWAY_ENV in the payments file).
// ASSUMED seam: core/config.ts exports `isProductionEnv(env: Readonly<Record<string, string | undefined>>): boolean`, true when LIMS_CORE_ENV is
// 'production' OR NODE_ENV is 'production' (fail towards production). loadConfig's responseValidation default and the three other sites use it.
// Fails now: isProductionEnv is not exported; loadConfig reads only LIMS_CORE_ENV; the three sites still compare NODE_ENV directly.
// STAGING MUST NOT CHANGE: LIMS_CORE_ENV=staging with NODE_ENV unset (or not production) is non-production exactly as before.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as config from '../config.js';
import { loadConfig } from '../config.js';

type Env = Record<string, string | undefined>;
const CORE = [undefined, 'dev', 'ci', 'staging', 'production'] as const;
const NODE = [undefined, 'test', 'development', 'production'] as const;
const expected = (core: string | undefined, node: string | undefined): boolean => core === 'production' || node === 'production';
const isProd = (env: Env): boolean => (config as unknown as { isProductionEnv: (e: Env) => boolean }).isProductionEnv(env);

describe('isProductionEnv: LIMS_CORE_ENV x NODE_ENV', () => {
  it('is exported by core/config.ts', () => {
    expect(typeof (config as Record<string, unknown>)['isProductionEnv']).toBe('function');
  });
  for (const core of CORE) for (const node of NODE) {
    it(`LIMS_CORE_ENV=${core} NODE_ENV=${node} -> ${expected(core, node)}`, () => {
      expect(isProd({ LIMS_CORE_ENV: core, NODE_ENV: node })).toBe(expected(core, node));
    });
  }
  it('the staging combination (staging, NODE_ENV unset) is NOT production', () => {
    expect(isProd({ LIMS_CORE_ENV: 'staging' })).toBe(false);
    expect(isProd({})).toBe(false);
  });
  it('fails towards production: LIMS_CORE_ENV=production alone is enough, and so is NODE_ENV=production alone', () => {
    expect(isProd({ LIMS_CORE_ENV: 'production' })).toBe(true);
    expect(isProd({ LIMS_CORE_ENV: 'staging', NODE_ENV: 'production' })).toBe(true);
  });
  it('only the exact string counts (no trimming, no case folding of unrelated values)', () => {
    for (const v of ['prod', 'production ', ' production', '', 'productions', 'staging']) {
      expect(isProd({ LIMS_CORE_ENV: 'ci', NODE_ENV: v }), `NODE_ENV=${JSON.stringify(v)}`).toBe(false);
    }
  });
  it('reads only the env it is given (process.env is not consulted)', () => {
    const saved = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try { expect(isProd({ LIMS_CORE_ENV: 'staging' })).toBe(false); } finally { if (saved === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = saved; }
  });
});

describe('site 1: loadConfig responseValidation default (core/config.ts:112 area)', () => {
  for (const core of ['dev', 'ci', 'staging', 'production'] as const) for (const node of NODE) {
    it(`LIMS_CORE_ENV=${core} NODE_ENV=${node}: default ${expected(core, node) ? 'off' : 'on'}`, () => {
      expect(loadConfig({ LIMS_CORE_ENV: core, ...(node === undefined ? {} : { NODE_ENV: node }) }).responseValidation).toBe(!expected(core, node));
    });
  }
  it('staging with NODE_ENV unset keeps response validation ON (unchanged)', () => {
    expect(loadConfig({ LIMS_CORE_ENV: 'staging' }).responseValidation).toBe(true);
  });
  it('an explicit LIMS_CORE_RESPONSE_VALIDATION still wins in either direction', () => {
    expect(loadConfig({ LIMS_CORE_ENV: 'staging', NODE_ENV: 'production', LIMS_CORE_RESPONSE_VALIDATION: 'on' }).responseValidation).toBe(true);
    expect(loadConfig({ LIMS_CORE_ENV: 'staging', LIMS_CORE_RESPONSE_VALIDATION: 'off' }).responseValidation).toBe(false);
  });
  it('LIMS_CORE_ENV keeps its own allowed set: NODE_ENV=production does not make an unknown LIMS_CORE_ENV valid', () => {
    expect(() => loadConfig({ LIMS_CORE_ENV: 'prod', NODE_ENV: 'production' })).toThrow(/LIMS_CORE_ENV/);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/LIMS_CORE_ENV/);
  });
});

describe('the four sites use the helper (static: no site keeps its own NODE_ENV comparison)', () => {
  const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const src = (p: string): string => strip(readFileSync(join(root, p), 'utf8'));
  const DIRECT = /NODE_ENV['"\]]*\s*[!=]==?\s*['"]production['"]/;
  const SITES = [
    'services/api/src/modules/reporting/delivery/callbacks.ts',
    'services/api/src/modules/payments/config.ts',
    'services/worker/src/jobs/reporting/tasks/send_delivery.ts',
  ];
  for (const p of SITES) {
    it(`${p} calls isProductionEnv and has no direct NODE_ENV === 'production' test`, () => {
      const s = src(p);
      expect(s).toMatch(/isProductionEnv/);
      expect(s).not.toMatch(DIRECT);
    });
  }
  it('core/config.ts defines the helper and the response-validation default goes through it', () => {
    const s = src('services/api/src/core/config.ts');
    expect(s).toMatch(/export (function|const) isProductionEnv/);
    expect(s).not.toMatch(/coreEnv === 'production' \? 'off' : 'on'/);
    expect(s).toMatch(/isProductionEnv\(env\)/);
  });
});
