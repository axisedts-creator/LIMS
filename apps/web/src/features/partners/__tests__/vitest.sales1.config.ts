// T0D-SALES-1 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-SALES-1-verify.cmd.
// Same mocks as T0D-PRICETOOLS-1 (next/navigation, server-only, session) from catalog/__tests__/testmgmt1.setup.ts; state lives on globalThis.__TM.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/partners/__tests__/sales1.*.test.{ts,tsx}'],
    setupFiles: ['src/features/catalog/__tests__/testmgmt1.setup.ts'],
    environment: 'node', // the screen suites opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
  },
});
