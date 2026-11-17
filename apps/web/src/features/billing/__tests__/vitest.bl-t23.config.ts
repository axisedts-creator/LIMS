// BL-T23 test-only vitest config (tester-owned); mirrors vitest.bl-t20.config.ts. Run via .orchestra/notes/BL-T23-verify.cmd.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  test: { include: ['src/features/billing/__tests__/bl-t23.*.test.ts'], environment: 'node', testTimeout: 30000 },
});
