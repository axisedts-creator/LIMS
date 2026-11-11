// T0D-01 / LD-53 (2): the test-only env setup. Uses injected env objects, never mutates process.env.
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../core/config.js';
import { loadReportingConfig } from '../modules/reporting/config.js';
import { applyTestEnv } from './setup-env.js';

const FIX = join(import.meta.dirname, 'fixtures', 'modules');
const NONE = join(import.meta.dirname, 'fixtures', 'no-such-modules-dir');
const ALLOWED = [
  'LIMS_CORE_ENV', 'LIMS_REPORTING_OTP_HMAC_KEY_FILE',
  'LIMS_CORE_JWT_ALG', 'LIMS_CORE_JWT_ISSUER', 'LIMS_CORE_JWT_AUDIENCE', 'LIMS_CORE_JWT_KEY_FILE',
];

describe('applyTestEnv on an empty env', () => {
  it('sets LIMS_CORE_ENV=ci and only env names that already exist', async () => {
    const env: Record<string, string | undefined> = {};
    await applyTestEnv(env, NONE);
    expect(env.LIMS_CORE_ENV).toBe('ci');
    expect(Object.keys(env).filter((k) => env[k] !== undefined).sort()).toEqual([...ALLOWED].sort());
  });

  it('writes a 32-byte random reporting HMAC key under os.tmpdir(), different on every call', async () => {
    const a: Record<string, string | undefined> = {};
    const b: Record<string, string | undefined> = {};
    await applyTestEnv(a, NONE);
    const pa = a.LIMS_REPORTING_OTP_HMAC_KEY_FILE!;
    expect(resolve(pa).startsWith(resolve(tmpdir()))).toBe(true);
    expect(statSync(pa).size).toBe(32);
    const first = readFileSync(pa); // read before the second call: the file may be reused
    await applyTestEnv(b, NONE);
    expect(statSync(b.LIMS_REPORTING_OTP_HMAC_KEY_FILE!).size).toBe(32);
    expect(readFileSync(b.LIMS_REPORTING_OTP_HMAC_KEY_FILE!).equals(first)).toBe(false);
  });

  it('yields an env that core loadConfig and loadReportingConfig accept, with JWT configured', async () => {
    const env: Record<string, string | undefined> = {};
    await applyTestEnv(env, NONE);
    const cfg = loadConfig(env);
    expect(cfg.env).toBe('ci');
    expect(cfg.jwt?.alg).toBe('ES256');
    expect(() => loadReportingConfig(env)).not.toThrow();
  });
});

describe('applyTestEnv leaves explicit values alone', () => {
  it('sets each variable only when it is unset', async () => {
    const env: Record<string, string | undefined> = {
      LIMS_CORE_ENV: 'dev',
      LIMS_REPORTING_OTP_HMAC_KEY_FILE: '/explicit/hmac.key',
      LIMS_CORE_JWT_KEY_FILE: '/explicit/jwt.pem',
    };
    await applyTestEnv(env, NONE);
    expect(env.LIMS_CORE_ENV).toBe('dev');
    expect(env.LIMS_REPORTING_OTP_HMAC_KEY_FILE).toBe('/explicit/hmac.key');
    expect(env.LIMS_CORE_JWT_KEY_FILE).toBe('/explicit/jwt.pem');
    expect(env.LIMS_CORE_JWT_ALG).toBe('ES256'); // still unset -> defaulted
  });
});

describe('modules/<m>/__tests__/test-env.ts convention', () => {
  it('applies each module default export to unset variables', async () => {
    const env: Record<string, string | undefined> = {};
    await applyTestEnv(env, FIX);
    expect(env.LIMS_FIXTURE_ALPHA).toBe('alpha-default');
    expect(env.LIMS_FIXTURE_BETA).toBe('beta-default');
  });

  it('never overrides a value that is already set (explicit or set by the setup itself)', async () => {
    const env: Record<string, string | undefined> = { LIMS_FIXTURE_BETA: 'explicit' };
    await applyTestEnv(env, FIX);
    expect(env.LIMS_FIXTURE_BETA).toBe('explicit');
    expect(env.LIMS_CORE_ENV).toBe('ci'); // alpha's LIMS_CORE_ENV=dev default loses
  });

  it('skips a module directory without a test-env.ts', async () => {
    const env: Record<string, string | undefined> = {};
    await applyTestEnv(env, FIX);
    expect(Object.keys(env).filter((k) => k.includes('GAMMA'))).toEqual([]);
  });
});
