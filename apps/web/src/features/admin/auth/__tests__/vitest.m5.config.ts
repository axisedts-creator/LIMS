// T0D-MSERIES-5 test-only vitest config (tester-owned). Run (after `pnpm --dir apps/web run build:nav`):
//   pnpm --dir apps/web exec vitest run --config src/features/admin/auth/__tests__/vitest.m5.config.ts
// Runs this task's m5.* file AND everything the entry screens must keep green: m2.* + t12.* auth tests, the rs-c2 admin screens/static guards, the web-style suites.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/admin/auth/__tests__/{m2,m5,t12}.*.test.{ts,tsx}',
      'src/features/admin/__tests__/rs-c2.*.test.{ts,tsx}',
      'src/__tests__/web-style{,-2,-3,-4}.test.ts',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
