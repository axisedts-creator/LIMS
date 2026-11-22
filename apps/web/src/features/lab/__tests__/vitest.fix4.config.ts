// T0D-FIX-4 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-FIX-4-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: [
      'src/features/lab/__tests__/fix4.*.test.{ts,tsx}',
      'src/features/catalog/__tests__/fix4.*.test.{ts,tsx}',
      'src/features/catalog/__tests__/cattests1.*.test.{ts,tsx}', // updated for the active-only default
    ],
    environment: 'node', // the test files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
  },
});
