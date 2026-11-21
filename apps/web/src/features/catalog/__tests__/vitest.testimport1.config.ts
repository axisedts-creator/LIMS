// T0D-TESTIMPORT-1 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-TESTIMPORT-1-verify.cmd.
// Same mocks as T0D-TESTMGMT-1 (next/navigation, server-only, session) from testmgmt1.setup.ts; state lives on globalThis.__TM.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' }, // tsconfig has jsx:preserve (Next); vitest needs it compiled
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/catalog/__tests__/testimport1.*.test.{ts,tsx}'],
    setupFiles: ['src/features/catalog/__tests__/testmgmt1.setup.ts'],
    environment: 'node', // the screen suite opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
  },
});
