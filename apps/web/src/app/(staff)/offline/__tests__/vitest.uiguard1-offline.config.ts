// T0D-UIGUARD-1-OFFLINE test-only vitest config (tester-owned): only this task's Offline panel tests. vitest root = apps/web.
// Run via .orchestra/notes/T0D-UIGUARD-1-OFFLINE-verify.cmd (build:nav first: core/nav/generated.ts is gitignored).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/app/**/offline/__tests__/uiguard1-offline.*.test.{ts,tsx}'], // no literal "(staff)": parentheses are glob syntax
    environment: 'node', // component tests opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000,
    fileParallelism: false,
  },
});
