// T0D-FIX-5 test-only vitest config (tester-owned): only this task's web tests. Run via .orchestra/notes/T0D-FIX-5-verify.cmd
// (pnpm --dir apps/web run build:nav first: core/nav/generated.ts is gitignored).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/payments/__tests__/fix5.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
