// PG-T18 test-only vitest config (tester-owned). Same shape as vitest.an-t18.config.ts. Run from repo root via .orchestra/notes/PG-T18-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/payments/__tests__/pg-t18.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 15000,
  },
});
