// WEB-T06 test-only vitest config (tester-owned; same shape as vitest.web-t03.config.ts).
// Run from repo root:  node node_modules\vitest\vitest.mjs run --config apps/web/src/features/instruments/__tests__/vitest.web-t06.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/instruments/__tests__/web-t06.*.test.{ts,tsx}'],
    environment: 'node', // component file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
  },
});
