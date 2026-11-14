// homecollection crontab (02-TRD §10; 08 A13 P-6: every entry per_tenant; P-15: the times below are Asia/Kathmandu = UTC+05:45, written here as UTC [CONV]). Retries column = maxAttempts 5.
import type { CronEntry } from '../../core/manifest.js';

const entry = (identifier: string, schedule: string): CronEntry => Object.freeze({ identifier, schedule, tenantScope: 'per_tenant' as const, maxAttempts: 5 });

export const crontab: readonly CronEntry[] = Object.freeze([
  entry('homecollection.sweep_missed_visits', '35 18 * * *'),      // daily 00:20 Kathmandu
  entry('homecollection.flag_overdue_handovers', '*/30 * * * *'),  // every 30 minutes
  entry('homecollection.purge_locations', '55 20 * * *'),          // daily 02:40 Kathmandu
  // 1st 03:10 Kathmandu = 21:25 UTC on the LAST day of the previous month: 5 cron fields cannot say that. Runs on days 28-31 at 21:25 UTC (the run is idempotent: p_before = now - retentionYears).
  // ponytail: up to 4 monthly runs instead of exactly one; add a first-of-month guard in the task if the extra no-op runs ever matter.
  entry('homecollection.purge_retention', '25 21 28-31 * *'),
]);
