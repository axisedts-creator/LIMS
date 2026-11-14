// T-M1 test-only vitest config (tester-owned); mirrors reminders/__tests__/vitest.t-r2.config.ts. Run via .orchestra/notes/T-M1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/app/**/engagement/memberships/__tests__/t-m1.*.test.{ts,tsx}'], // no literal "(staff)": parentheses are glob syntax
    environment: 'node', // component file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
  },
});
