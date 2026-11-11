// catalog crontab (02-TRD §10; 08 A13 P-6: all three per_tenant — one job per tenant, run under that tenant's claims). Times are UTC:
// 21:20 UTC = 03:05 Asia/Kathmandu. The release fan-out runs every 10 min so each tenant is told within 15 min (AC-19.5).
import type { CronEntry } from '../../core/manifest.js';
import { EXPIRE_IMPORTS } from './tasks/catalog.expire_imports.js';
import { GLOBAL_RELEASE_FANOUT } from './tasks/catalog.global_release_fanout.js';
import { PURGE_FILES } from './tasks/catalog.purge_files.js';

export const crontab: readonly CronEntry[] = Object.freeze([
  Object.freeze({ identifier: EXPIRE_IMPORTS, schedule: '5 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 1 }),
  Object.freeze({ identifier: PURGE_FILES, schedule: '20 21 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 1 }),
  Object.freeze({ identifier: GLOBAL_RELEASE_FANOUT, schedule: '*/10 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
]);
