// RS-C4 test-only vitest config (tester-owned). Same shape as vitest.fd-t13.config.ts; covers both chunk features (frontdesk + billing screens in one run).
// Run: .orchestra/notes/RS-C4-verify.cmd (CI=true so a missing rs-c4.screens snapshot fails instead of being written).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/frontdesk/__tests__/rs-c4.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
    fileParallelism: false,
  },
});
