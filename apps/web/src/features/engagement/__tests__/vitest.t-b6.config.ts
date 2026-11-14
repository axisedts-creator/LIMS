// C16.T-B6 test-only vitest config (tester-owned). Same shape as vitest.t-q4.config.ts.
// Run: pnpm --dir apps/web exec vitest run -c src/features/engagement/__tests__/vitest.t-b6.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/engagement/__tests__/t-b6.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
  },
});
