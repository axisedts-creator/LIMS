// T0D-EMPTYTBL-1 test-only vitest config (tester-owned). Run via .orchestra/notes/T0D-EMPTYTBL-1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  esbuild: { jsx: 'automatic' }, // tsconfig has jsx:preserve (Next); vitest needs it compiled
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/features/catalog/__tests__/emptytbl1.*.test.{ts,tsx}'],
    environment: 'node', // component files opt in with `// @vitest-environment jsdom`
    restoreMocks: true,
    testTimeout: 60000, // LD-76: component tests exceed 15s on this machine
  },
});
