// T0D-UIGUARD-1-HOMECOLLECTION test-only vitest config (tester-owned): only this task's DispatchBoard layout tests. vitest root = apps/web.
// Run via .orchestra/notes/T0D-UIGUARD-1-HOMECOLLECTION-verify.cmd (build:nav first: core/nav/generated.ts is gitignored).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/homecollection/__tests__/uiguard1.homecollection.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
