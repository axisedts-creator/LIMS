// T0D-MSERIES-4 test-only vitest config (tester-owned). Run (after `pnpm --dir apps/web run build:nav`):
//   pnpm --dir apps/web exec vitest run --config src/core/shell/__tests__/vitest.m4.config.ts
// Runs this task's m4.* file AND the existing m2.* / r04.* shell, nav and auth presentation tests, which must stay green.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/core/shell/__tests__/{m2,m4,r04}.*.test.{ts,tsx}',
      'src/core/nav/__tests__/{m2,r04}.*.test.ts',
      'src/core/shortcuts/__tests__/r04.*.test.ts',
      'src/features/admin/auth/__tests__/{m2,t12}.*.test.{ts,tsx}',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
