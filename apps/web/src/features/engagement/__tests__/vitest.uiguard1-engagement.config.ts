// T0D-UIGUARD-1-ENGAGEMENT test-only vitest config (tester-owned): only this task's page-state tests. vitest root = apps/web.
// Run via .orchestra/notes/T0D-UIGUARD-1-ENGAGEMENT-verify.cmd (build:nav first: core/nav/generated.ts is gitignored).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/engagement/__tests__/uiguard1.engagement.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
