// T0D-REGSCREEN-1 test-only vitest config (tester-owned). Same shape as vitest.fd-t13.config.ts; run through .orchestra/notes/T0D-REGSCREEN-1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/frontdesk/__tests__/regscreen1.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
    fileParallelism: false,
  },
});
