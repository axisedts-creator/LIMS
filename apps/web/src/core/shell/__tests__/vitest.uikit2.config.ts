// T0D-UIKIT-2 test-only vitest config (tester-owned). Run:
//   pnpm --dir apps/web exec vitest run --config src/core/shell/__tests__/vitest.uikit2.config.ts
// Runs the new uikit2 shell.css guard AND the shell source pins m2.source, m4.source, r04.source (static, text-only; they must stay green).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/core/shell/__tests__/{uikit2.shell,m2.source,m4.source,r04.source}.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 60000,
  },
});
