// T-R2 test-only vitest config (tester-owned); mirrors vitest.bl-t20.config.ts. Run via .orchestra/notes/T-R2-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/app/**/engagement/reminders/__tests__/t-r2.*.test.{ts,tsx}'], // no literal "(staff)": parentheses are glob syntax
    environment: 'node', // component file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 20000,
  },
});
