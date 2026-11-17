// RS-C6 test-only vitest config (tester-owned). Run via .orchestra/notes/RS-C6-verify.cmd (from the repo root, through the package).
// The portal tests live here too (apps/portal has no vitest of its own); `@/` means apps/web/src for web files and apps/portal/src for portal files.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const portal = fileURLToPath(new URL('../../../../../portal/', import.meta.url)); // apps/portal/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  plugins: [
    {
      name: 'rs-c6-at-alias',
      enforce: 'pre',
      async resolveId(source, importer, opts) {
        if (!source.startsWith('@/')) return null;
        const base = importer && importer.replace(/\\/g, '/').includes('/apps/portal/') ? `${portal}src/` : `${web}src/`;
        return this.resolve(`${base}${source.slice(2)}`, importer, { ...opts, skipSelf: true });
      },
    },
  ],
  test: {
    include: ['src/features/reporting/__tests__/rs-c6.*.test.{ts,tsx}'],
    environment: 'node', // DOM files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
