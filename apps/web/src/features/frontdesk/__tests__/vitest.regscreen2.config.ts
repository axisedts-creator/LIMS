// T0D-REGSCREEN-2 test-only vitest config (tester-owned). Same shape as vitest.regscreen1.config.ts; run through .orchestra/notes/T0D-REGSCREEN-2-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/frontdesk/__tests__/regscreen2.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
    fileParallelism: false,
  },
});
