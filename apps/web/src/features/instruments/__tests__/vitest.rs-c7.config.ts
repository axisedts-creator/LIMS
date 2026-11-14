// RS-C7 test-only vitest config (tester-owned; same shape as vitest.web-t05.config.ts).
// Run: pnpm --dir apps/web exec vitest run --config src/features/instruments/__tests__/vitest.rs-c7.config.ts   (CI=true: a missing snapshot fails, it is never written silently)
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/instruments/__tests__/rs-c7.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
  },
});
