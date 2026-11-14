// HC-T18 test-only vitest config (tester-owned). Same shape as payments/__tests__/vitest.pg-t19.config.ts. Run from repo root via .orchestra/notes/HC-T18-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/homecollection/__tests__/hc-t18.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
