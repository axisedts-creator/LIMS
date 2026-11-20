// ADMINPAGE-FD-1 test-only vitest config (tester-owned). Same shape as vitest.fd-t14.config.ts. Run via .orchestra/notes/ADMINPAGE-FD-1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/frontdesk/__tests__/adminpage-fd-1.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
    fileParallelism: false,
  },
});
