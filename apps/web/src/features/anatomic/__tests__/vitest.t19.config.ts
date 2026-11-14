// C11.T-19 test-only vitest config (tester-owned). Same shape as the analytics/micro web configs. Run from repo root via .orchestra/notes/C11.T-19-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/anatomic/__tests__/t19.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 15000,
  },
});
