// VERIFY-GREEN-8 test-only vitest config (tester-owned). Run via .orchestra/notes/VERIFY-GREEN-8-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  test: { include: ['src/__tests__/vg8.typecheck.test.ts'], environment: 'node', testTimeout: 30000 },
});
