// MET-T05 test-only vitest config (tester-owned; same shape as vitest.h80-t06.config.ts).
// Run: pnpm --dir apps/web exec vitest run --config src/features/instruments/__tests__/vitest.met-t05.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/instruments/__tests__/met-t05.*.test.{ts,tsx}'],
    environment: 'node', // component file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
  },
});
