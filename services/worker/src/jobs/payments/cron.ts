// payments crontab (02-TRD §8.3; 08 A13 P-6: per_tenant). poll_intent is enqueued at create / by the sweep, not scheduled.
// reconcile_tenant / rewrap_credentials entries are added by the tasks that implement them (PG-T12.., PG-T17).
import type { CronEntry } from '../../core/manifest.js';
import { SWEEP_OPEN_INTENTS } from './tasks/sweep_open_intents.js';

export const crontab: readonly CronEntry[] = Object.freeze([
  Object.freeze({ identifier: SWEEP_OPEN_INTENTS, schedule: '*/15 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
]);
