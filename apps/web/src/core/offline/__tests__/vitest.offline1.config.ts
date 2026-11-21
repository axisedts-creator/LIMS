// T0D-OFFLINE-1 test-only vitest config (tester-owned; same shape as vitest.verlevel1.config.ts).
// Run from the repo root via .orchestra/notes/T0D-OFFLINE-1-verify.cmd
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/

export default defineConfig({
  root: web,
  resolve: { alias: { '@/': `${web}src/` } },
  test: {
    include: ['src/core/offline/__tests__/offline1.*.test.ts'],
    environment: 'node', // IndexedDB comes from fake-indexeddb (tests only), WebCrypto + BroadcastChannel from node
    restoreMocks: true,
    testTimeout: 60000, // PBKDF2 at >= 600000 iterations is deliberately slow
    fileParallelism: false,
  },
});
