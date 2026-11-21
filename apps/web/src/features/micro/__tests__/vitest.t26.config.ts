// C10.T-26 test-only vitest config (tester-owned; same shape as vitest.t24.config.ts).
// Run: pnpm --dir apps/web exec vitest run --config src/features/micro/__tests__/vitest.t26.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/micro/__tests__/t26.*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 15000,
  },
});
