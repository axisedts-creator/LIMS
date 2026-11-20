// SEC-ENV-1 (LD-236; audit 10.2): site 2, reporting/delivery/callbacks.ts. callbackAdapter(env) must return NO adapter (every callback rejected) when
// LIMS_CORE_ENV or NODE_ENV is production, so the unkeyed recording adapter (signature = unkeyed SHA-256 of the body) is unreachable there.
// Outside production it returns the recording transport exactly as before (staging: LIMS_CORE_ENV=staging, NODE_ENV unset).
// Fails now: callbackAdapter reads NODE_ENV only, so LIMS_CORE_ENV=production without NODE_ENV still returns the recording transport.
import { describe, expect, it } from 'vitest';
import { recordingTransport } from '../delivery/adapters/recording.js';
import { callbackAdapter } from '../delivery/callbacks.js';

const CORE = [undefined, 'dev', 'ci', 'staging', 'production'] as const;
const NODE = [undefined, 'test', 'development', 'production'] as const;
const isProd = (core: string | undefined, node: string | undefined): boolean => core === 'production' || node === 'production';

describe('callbackAdapter: LIMS_CORE_ENV x NODE_ENV', () => {
  for (const core of CORE) for (const node of NODE) {
    it(`LIMS_CORE_ENV=${core} NODE_ENV=${node} -> ${isProd(core, node) ? 'no adapter' : 'recording'}`, () => {
      const a = callbackAdapter({ LIMS_CORE_ENV: core, NODE_ENV: node });
      if (isProd(core, node)) expect(a).toBeUndefined();
      else expect(a).toBe(recordingTransport);
    });
  }
  it('the headline: LIMS_CORE_ENV=production and NODE_ENV unset never reaches the recording adapter', () => {
    expect(callbackAdapter({ LIMS_CORE_ENV: 'production' })).toBeUndefined();
  });
  it('staging with NODE_ENV unset behaves exactly as before: the recording transport', () => {
    expect(callbackAdapter({ LIMS_CORE_ENV: 'staging' })).toBe(recordingTransport);
    expect(callbackAdapter({})).toBe(recordingTransport);
  });
});
