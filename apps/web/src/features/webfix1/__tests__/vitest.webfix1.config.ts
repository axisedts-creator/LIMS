// T0D-WEBFIX-1 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-WEBFIX-1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/webfix1/__tests__/webfix1.*.test.{ts,tsx}'],
    environment: 'node', // test files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
  },
});
