// T0D-UI-R04 test-only vitest config (tester-owned). Run (after `pnpm --dir apps/web run build:nav`):
//   pnpm --dir apps/web exec vitest run --config src/core/shell/__tests__/vitest.r04.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/core/shell/__tests__/r04.*.test.{ts,tsx}',
      'src/core/nav/__tests__/r04.*.test.ts',
      'src/core/shortcuts/__tests__/r04.*.test.ts',
    ],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
  },
});
