// T0D-OFFLINE-4 test-only vitest config (tester-owned; same shape as vitest.offline3.config.ts).
// Tests live under app/(staff)/offline/__tests__ so the 28 file cap that offline1.static counts under core/offline is not used up by them.
// Run from the repo root via .orchestra/notes/T0D-OFFLINE-4-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/app/**/offline/__tests__/offline4.*.test.{ts,tsx}'], // no literal "(staff)": parentheses are glob syntax
    environment: 'node', // jsx files opt in with `// @vitest-environment jsdom`; IndexedDB comes from fake-indexeddb
    restoreMocks: true,
    testTimeout: 120000, // PBKDF2 at 600000 iterations is deliberately slow
    fileParallelism: false,
  },
});
