// C13.T25 test-only vitest config (tester-owned). Run from repo root via .orchestra/notes/C13.T25-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)), // repo root
  test: { include: ['tests/c13-t25/*.test.ts'], environment: 'node', testTimeout: 30000 },
});
