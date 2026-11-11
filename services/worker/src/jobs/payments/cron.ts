// payments crontab (02-TRD §8.3; 08 A13 P-6: per_tenant). poll_intent is enqueued at create / by the sweep, not scheduled.
// rewrap_credentials is added by the task that registers it (PG-T17).
import type { CronEntry } from '../../core/manifest.js';
import { RECONCILE_TENANT } from './tasks/reconcile_tenant.js';
import { SWEEP_OPEN_INTENTS } from './tasks/sweep_open_intents.js';

export const crontab: readonly CronEntry[] = Object.freeze([
  Object.freeze({ identifier: SWEEP_OPEN_INTENTS, schedule: '*/15 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
  // 02:25 Asia/Kathmandu = 20:40 UTC (UTC+05:45) [CONV]
  Object.freeze({ identifier: RECONCILE_TENANT, schedule: '40 20 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
]);
