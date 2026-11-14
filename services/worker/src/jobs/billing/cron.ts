// billing crontab (02-TRD §10). Times are UTC: 18:45 = 00:30 NPT, 19:00 = 00:45 NPT, 20:00 = 01:45 NPT.
import type { CronEntry } from '../../core/manifest.js';
import { CBMS_SWEEP } from './tasks/cbms_sweep.js';
import { CREDIT_DAYS_CHECK } from './tasks/credit_days_check.js';
import { EXPORT_PURGE } from './tasks/export_purge.js';
import { FISCAL_COUNTER_PREPARE } from './tasks/fiscal_counter_prepare.js';
import { INTEGRITY_CHECK } from './tasks/integrity_check.js';

export const crontab: readonly CronEntry[] = Object.freeze([
  Object.freeze({ identifier: FISCAL_COUNTER_PREPARE, schedule: '45 18 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }),
  Object.freeze({ identifier: CREDIT_DAYS_CHECK, schedule: '0 19 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
  Object.freeze({ identifier: INTEGRITY_CHECK, schedule: '0 20 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 1 }),
  Object.freeze({ identifier: CBMS_SWEEP, schedule: '*/15 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
  Object.freeze({ identifier: EXPORT_PURGE, schedule: '30 19 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
]);
