// T0D-FIX-9 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-FIX-9-verify.cmd.
// Shared mocks (next/navigation, server-only, session) come from the printcfg1 setup file (state on globalThis.__PC); it is only read here, not edited.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/__tests__/fix9.*.test.{ts,tsx}', 'src/features/reporting/__tests__/fix9.*.test.{ts,tsx}'],
    setupFiles: ['src/features/reporting/__tests__/printcfg1.setup.ts'],
    environment: 'node', // test files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
  },
});
