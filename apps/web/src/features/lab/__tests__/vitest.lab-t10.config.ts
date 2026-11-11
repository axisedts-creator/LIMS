// C5 T-10 test-only vitest config (tester-owned). Same shape as the billing/frontdesk web configs. Run from repo root via .orchestra/notes/C5.T-10-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/lab/__tests__/lab-t10.*.test.{ts,tsx}'],
    environment: 'node', // component/renderer files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
  },
});
