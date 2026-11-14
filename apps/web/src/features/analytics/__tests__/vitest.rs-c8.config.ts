// RS-C8 test-only vitest config (tester-owned). Same shape as vitest.an-t19.config.ts.
// Run: .orchestra/notes/RS-C8-verify.cmd (CI=true so a missing rs-c8.screens snapshot fails instead of being written).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/analytics/__tests__/rs-c8.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
    fileParallelism: false,
  },
});
