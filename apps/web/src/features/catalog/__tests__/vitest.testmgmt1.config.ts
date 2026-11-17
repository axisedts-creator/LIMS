// T0D-TESTMGMT-1 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-TESTMGMT-1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' }, // tsconfig has jsx:preserve (Next); vitest needs it compiled
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/catalog/__tests__/testmgmt1.*.test.{ts,tsx}'],
    setupFiles: ['src/features/catalog/__tests__/testmgmt1.setup.ts'], // next/navigation, server-only and session mocks (shared state on globalThis.__TM)
    environment: 'node', // each test file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000, // LD-76: keystroke-heavy component tests exceed 15s on this machine
  },
});
