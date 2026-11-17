// T0D-ELABMENU-1 test-only vitest config (tester-owned): only this task's tests. Run from the repo root:
//   pnpm --dir apps/web run build:nav && pnpm --dir apps/web exec vitest run --config src/core/shell/__tests__/vitest.elabmenu.config.ts
// The wide sweep over the old tests is vitest.elabmenu-wide.config.ts (same folder).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/core/shell/__tests__/elabmenu1.*.test.{ts,tsx}',
      'src/core/nav/__tests__/elabmenu1.*.test.ts',
      'src/app/__tests__/elabmenu1.*.test.ts',
      'src/features/frontdesk/__tests__/regscreen1.layout.test.ts',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
