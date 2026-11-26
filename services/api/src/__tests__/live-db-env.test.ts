// Wiring check for tools/test-env/vitest.setup.ts (listed in vitest.config.ts setupFiles): with the three LIMS_CI_DB_* base
// URLs set, this file (not under a module folder) gets the lims_api login as LIMS_TEST_DATABASE_URL; without them the setup
// file leaves the environment alone. The mapping itself is tested in tools/lint/tests/test-env.test.mjs.
import { describe, expect, it } from 'vitest';

const base = ['LIMS_CI_DB_SUPER_URL', 'LIMS_CI_DB_API_URL', 'LIMS_CI_DB_WORKER_URL'].map((k) => process.env[k]);
const all = base.every((v) => typeof v === 'string' && v !== '');

describe('test database variables from the CI base URLs', () => {
  it.runIf(all)('are set for this file from the base URLs', () => {
    const [superUrl, apiUrl, workerUrl] = base;
    expect(process.env['LIMS_TEST_APP_URL']).toBe(apiUrl);
    expect(process.env['LIMS_TEST_DATABASE_URL']).toBe(apiUrl);
    expect(process.env['LIMS_TEST_SUPER_URL']).toBe(superUrl);
    expect(process.env['LIMS_TEST_ADMIN_DATABASE_URL']).toBe(superUrl);
    expect(process.env['LIMS_TEST_WORKER_URL']).toBe(workerUrl);
  });

  it.runIf(!all)('are not invented when the base URLs are absent', () => {
    // a developer may have exported real ones; the setup file must not have written a base URL (there is none)
    for (const k of ['LIMS_TEST_APP_URL', 'LIMS_TEST_SUPER_URL', 'LIMS_TEST_DATABASE_URL']) {
      const v = process.env[k];
      expect(v === undefined || v.startsWith('postgres')).toBe(true);
    }
  });
});
