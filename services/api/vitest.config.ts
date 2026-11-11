// LD-53 (2), T0D-01: this vitest config edit is authorised by lead decision LD-53. The test-only setup
// (src/__tests__/setup-env.ts) supplies ci env defaults, applied only when unset, so the real modules directory boots.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/setup-env.ts'],
    // LD-87 (C6-T39): cold-start ajv schema compile exceeds the 5000 ms default on a shared machine.
    testTimeout: 60000,
    hookTimeout: 60000, maxWorkers: 3, // cap: 8 lanes share one 16 GB machine
  },
});
