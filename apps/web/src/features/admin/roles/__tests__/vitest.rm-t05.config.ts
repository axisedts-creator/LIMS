// RM-T05 test-only vitest config (tester-owned). Run via .orchestra/notes/RM-T05-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/admin/roles/__tests__/rm-t05.*.test.{ts,tsx}'],
    environment: 'node', // the screen test file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
