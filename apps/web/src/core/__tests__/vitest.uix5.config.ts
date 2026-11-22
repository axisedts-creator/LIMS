// T0D-UIX-5 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-UIX-5-verify.cmd:
//   pnpm --dir apps/web exec vitest run --config src/core/__tests__/vitest.uix5.config.ts
// Runs the new layout value test AND the static shell pins that must stay green (uikit2.shell, m2/m4/r04 source).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/core/__tests__/uix5.layout.test.ts', 'src/core/shell/__tests__/{uikit2.shell,m2.source,m4.source,r04.source}.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
