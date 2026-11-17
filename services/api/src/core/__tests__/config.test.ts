// T0D-01 — core/config.ts: typed LIMS_CORE_* config, fails fast (02-TRD §6.1, §11; SP-8 O4).
// Only LIMS_CORE_ENV is required by T0D-01; keys owned by later tasks (DB, JWT, ...) must not be required here.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const fails = (env: Record<string, string | undefined>, key: string) => {
  let msg = '';
  try {
    loadConfig(env);
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  expect(msg, `loadConfig must throw naming ${key}`).toContain(key);
};

describe('loadConfig', () => {
  it('fails fast when LIMS_CORE_ENV is missing or empty', () => {
    fails({}, 'LIMS_CORE_ENV');
    fails({ LIMS_CORE_ENV: '' }, 'LIMS_CORE_ENV');
  });

  it('rejects values outside dev|ci|staging|production', () => {
    for (const v of ['prod', 'test', 'PRODUCTION', ' ci']) fails({ LIMS_CORE_ENV: v }, 'LIMS_CORE_ENV');
  });

  it.each(['dev', 'ci', 'staging', 'production'])('accepts LIMS_CORE_ENV=%s', (env) => {
    expect(loadConfig({ LIMS_CORE_ENV: env }).env).toBe(env);
  });

  it('responseValidation defaults on in dev/ci/staging and off in production (REQ-ARCH-071)', () => {
    for (const env of ['dev', 'ci', 'staging']) expect(loadConfig({ LIMS_CORE_ENV: env }).responseValidation).toBe(true);
    expect(loadConfig({ LIMS_CORE_ENV: 'production' }).responseValidation).toBe(false);
  });

  it('LIMS_CORE_RESPONSE_VALIDATION on|off overrides the default; anything else fails', () => {
    expect(loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_RESPONSE_VALIDATION: 'off' }).responseValidation).toBe(false);
    expect(loadConfig({ LIMS_CORE_ENV: 'production', LIMS_CORE_RESPONSE_VALIDATION: 'on' }).responseValidation).toBe(true);
    for (const v of ['maybe', 'true', '1', '']) {
      fails({ LIMS_CORE_ENV: 'ci', LIMS_CORE_RESPONSE_VALIDATION: v }, 'LIMS_CORE_RESPONSE_VALIDATION');
    }
  });

  it('sample module loads only when LIMS_CORE_ENV=ci and LIMS_CORE_LOAD_SAMPLE_MODULE=1 (02-TRD §14)', () => {
    expect(loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_LOAD_SAMPLE_MODULE: '1' }).loadSampleModule).toBe(true);
    expect(loadConfig({ LIMS_CORE_ENV: 'ci' }).loadSampleModule).toBe(false);
    expect(loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_LOAD_SAMPLE_MODULE: '0' }).loadSampleModule).toBe(false);
    for (const env of ['dev', 'staging', 'production']) {
      expect(loadConfig({ LIMS_CORE_ENV: env, LIMS_CORE_LOAD_SAMPLE_MODULE: '1' }).loadSampleModule, env).toBe(false);
    }
  });

  it('returns a frozen object', () => {
    const c = loadConfig({ LIMS_CORE_ENV: 'dev' });
    expect(Object.isFrozen(c)).toBe(true);
  });
});

describe('LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILE (CR-C16 draft: optional patient token key)', () => {
  const base = { LIMS_CORE_ENV: 'ci', LIMS_CORE_JWT_ALG: 'HS256', LIMS_CORE_JWT_ISSUER: 'i', LIMS_CORE_JWT_AUDIENCE: 'a', LIMS_CORE_JWT_KEY_FILE: '/k' };
  it('is absent from the jwt config unless set (the four-key shape is unchanged)', () => {
    expect(loadConfig(base).jwt).toEqual({ alg: 'HS256', issuer: 'i', audience: 'a', keyFile: '/k' });
  });
  it('is carried as patientKeyFile when set', () => {
    expect(loadConfig({ ...base, LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILE: '/p' }).jwt).toEqual({ alg: 'HS256', issuer: 'i', audience: 'a', keyFile: '/k', patientKeyFile: '/p' });
  });
  it('empty counts as unset', () => {
    expect(loadConfig({ ...base, LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILE: '' }).jwt).toEqual({ alg: 'HS256', issuer: 'i', audience: 'a', keyFile: '/k' });
  });
  it('without the four primary keys the patient key alone configures nothing', () => {
    expect(loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILE: '/p' }).jwt).toBeUndefined();
  });
});
