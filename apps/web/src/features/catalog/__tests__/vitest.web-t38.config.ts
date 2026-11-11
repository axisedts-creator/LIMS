// C3.T-38 docs-review vitest config (tester-owned; same shape as vitest.web-t35.config.ts, node env only: the tests read markdown files).
// Run from repo root:  node node_modules\vitest\vitest.mjs run --config apps/web/src/features/catalog/__tests__/vitest.web-t38.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  test: {
    include: ['src/features/catalog/__tests__/web-t38.*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 60000,
  },
});
