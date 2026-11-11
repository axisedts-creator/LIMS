// C5.T-20 test-only vitest config (tester-owned; same shape as vitest.c5-t21.config.ts).
// Run from repo root:  node node_modules\vitest\vitest.mjs run --config apps/web/src/features/lab/__tests__/vitest.c5-t20.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/lab/__tests__/c5-t20.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
  },
});
