// C10.T-24 test-only vitest config (tester-owned; same shape as the catalog vitest.web-t3x configs).
// Run: pnpm --dir apps/web exec vitest run --config src/features/micro/__tests__/vitest.t24.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/micro/__tests__/t24.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000, // jsdom + MSW + real server actions are slow on CI laptops
  },
});
