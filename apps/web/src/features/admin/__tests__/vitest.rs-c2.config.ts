// RS-C2 test-only vitest config (tester-owned). Run via .orchestra/notes/RS-C2-verify.cmd (from the repo root, through the package).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/admin/__tests__/rs-c2.*.test.{ts,tsx}'],
    environment: 'node', // the screens file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
