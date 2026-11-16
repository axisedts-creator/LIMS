// T0D-NAV-COMPLETE-1 test-only vitest config (tester-owned). Run from the repo root:
//   pnpm --dir apps/web exec vitest run --config src/core/nav/__tests__/vitest.nav-complete.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/*/__tests__/nav-complete.*.test.ts', 'src/core/nav/__tests__/nav-complete.*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 60000,
  },
});
