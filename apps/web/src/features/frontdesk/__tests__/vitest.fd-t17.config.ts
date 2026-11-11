// FD-T17 test-only vitest config (tester-owned). Node-only (reads md files). Run via .orchestra/notes/FD-T17-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  test: { include: ['src/features/frontdesk/__tests__/fd-t17.*.test.ts'], environment: 'node', testTimeout: 30000 },
});
