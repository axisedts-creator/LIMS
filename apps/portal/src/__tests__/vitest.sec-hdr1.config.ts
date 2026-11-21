// SEC-HDR-1 test-only vitest config (tester-owned). Run from the repo root via .orchestra/notes/SEC-HDR-1-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const portal = fileURLToPath(new URL('../../', import.meta.url)); // apps/portal/

export default defineConfig({
  root: portal,
  test: { include: ['src/__tests__/sec-hdr1.*.test.ts'], environment: 'node', testTimeout: 30000 },
});
