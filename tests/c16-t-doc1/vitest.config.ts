// C16.T-DOC1 test-only vitest config (tester-owned). Run from repo root via .orchestra/notes/T-DOC1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)), // repo root
  test: { include: ['tests/c16-t-doc1/*.test.ts'], environment: 'node', testTimeout: 30000 },
});
