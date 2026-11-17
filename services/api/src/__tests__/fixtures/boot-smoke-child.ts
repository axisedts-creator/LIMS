// Child process of boot-smoke.test.ts (T0D-DEP-01, LD-179 (4)). Runs under the REAL node with the production --import flag:
//   node --import <register.mjs> src/__tests__/fixtures/boot-smoke-child.ts
// It loads the same entry graph as src/main.ts (bootstrap + config) with an in-memory config: no database, no storage, no listen,
// no fixed port. Exit 0 and the line BOOT_OK mean the graph resolved and the app became ready and closed.
// Only erasable TypeScript here (node strips types, nothing else), and `import type` for types.
import { bootstrap } from '../../core/bootstrap.js';
import { loadConfig } from '../../core/config.js';

const env: Record<string, string | undefined> = { ...process.env, LIMS_CORE_ENV: 'ci' };
for (const k of ['LIMS_CORE_DATABASE_URL', 'LIMS_CORE_STORAGE_URL', 'LIMS_CORE_STORAGE_KEY_FILE']) delete env[k];

const app = await bootstrap({ config: loadConfig(env), logStream: { write() {} } });
const res = await app.inject({ method: 'GET', url: '/v1/core/health/live' });
await app.close();
if (res.statusCode !== 200) {
  console.error(`health/live answered ${res.statusCode}`);
  process.exit(2);
}
console.log('BOOT_OK');
process.exit(0);
