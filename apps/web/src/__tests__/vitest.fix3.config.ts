// T0D-FIX-3 test-only vitest config (tester-owned). Run: .orchestra/notes/T0D-FIX-3-verify.cmd (from the repo root).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/__tests__/fix3.*.test.{ts,tsx}'],
    environment: 'node', // fix3.display opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
  },
});
