// RS-C5 test-only vitest config (tester-owned; same shape as vitest.c5-t20.config.ts).
// Run: pnpm --dir apps/web exec vitest run --config src/features/lab/__tests__/vitest.rs-c5.config.ts   (CI=true: a missing snapshot fails, it is never written silently)
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/lab/__tests__/rs-c5.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
  },
});
