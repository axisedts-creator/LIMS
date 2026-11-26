// CI runners are slower than a developer machine: purge.test.ts (25,000 in-memory rows) passed locally and timed out at the
// 5 s default in the unit job. Same reason as services/api/vitest.config.ts (LD-87, LD-110); 30 s still fails a real hang.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // setupFiles: per-module LIMS_TEST_* database URLs in CI; does nothing unless LIMS_CI_DB_* are set (tools/test-env/live-db.ts)
  test: { testTimeout: 30000, hookTimeout: 30000, setupFiles: ['../../tools/test-env/vitest.setup.ts'] },
});
