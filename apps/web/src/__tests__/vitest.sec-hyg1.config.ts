// SEC-HYG-1 test-only vitest config (tester-owned). Run via .orchestra/notes/SEC-HYG-1-verify.cmd (from the repo root, through the package).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  plugins: [
    {
      name: 'sec-hyg1-at-alias',
      enforce: 'pre',
      async resolveId(source, importer, opts) {
        if (!source.startsWith('@/')) return null;
        return this.resolve(`${web}src/${source.slice(2)}`, importer, { ...opts, skipSelf: true });
      },
    },
  ],
  test: {
    include: ['src/__tests__/sec-hyg1.pollers.test.tsx'],
    environment: 'node', // the test file opts in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
