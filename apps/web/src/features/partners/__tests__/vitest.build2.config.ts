// T0D-BUILD-2 test-only vitest config (tester-owned): the new settings screen test plus the existing /partners/settings page test. Run via .orchestra/notes/T0D-BUILD-2-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/partners/__tests__/build2.*.test.{ts,tsx}', 'src/features/partners/__tests__/uiset1.partners.test.tsx'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
