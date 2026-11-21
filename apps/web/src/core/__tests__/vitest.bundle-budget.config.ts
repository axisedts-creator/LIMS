// T0D-BUNDLE-1 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-BUNDLE-1-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/core/__tests__/bundle-budget.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
