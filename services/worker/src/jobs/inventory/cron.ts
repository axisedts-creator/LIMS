// inventory crontab (02-TRD §9; 08 A13 P-6, A17 D-72). Times are UTC: 19:15 = 01:00 Asia/Kathmandu (UTC+05:45). ALL five are per_tenant (the platform fan-out enqueues one job per tenant);
// none is 'platform': inventory.purge_alerts deletes through the tenant's claims as the system actor (D-72).
import type { CronEntry } from '../../core/manifest.js';

const cron = (identifier: string, schedule: string, maxAttempts: number): CronEntry => Object.freeze({ identifier, schedule, tenantScope: 'per_tenant' as const, maxAttempts });

export const crontab: readonly CronEntry[] = Object.freeze([
  cron('inventory.daily_fixed_consumption', '15 19 * * *', 5),
  cron('inventory.daily_alert_scan', '30 19 * * *', 5),
  cron('inventory.balance_integrity_check', '45 19 * * *', 3),
  cron('inventory.reconciliation_scan', '0 20 * * *', 3),
  cron('inventory.purge_alerts', '0 21 * * 0', 3),
]);
