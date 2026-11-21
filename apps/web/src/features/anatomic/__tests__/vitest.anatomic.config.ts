// T0D-UIGUARD-1-ANATOMIC test-only vitest config (tester-owned): runs the anatomic feature web tests.
// Run via .orchestra/notes/T0D-UIGUARD-1-ANATOMIC-verify.cmd (pnpm --dir apps/web run build:nav first: core/nav/generated.ts is gitignored).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/anatomic/__tests__/*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
