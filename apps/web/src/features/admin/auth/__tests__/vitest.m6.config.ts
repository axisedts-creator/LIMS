// T0D-MSERIES-6 test-only vitest config (tester-owned). Run (after `pnpm --dir apps/web run build:nav`):
//   pnpm --dir apps/web exec vitest run --config src/features/admin/auth/__tests__/vitest.m6.config.ts
// Runs this task's m6.* file AND everything the entry screens must keep green (same set as vitest.m5.config.ts): m2/m5/t12 auth tests, rs-c2 admin screens, web-style suites.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/admin/auth/__tests__/{m2,m5,m6,t12}.*.test.{ts,tsx}',
      'src/features/admin/__tests__/rs-c2.*.test.{ts,tsx}',
      'src/__tests__/web-style{,-2,-3,-4}.test.ts',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
