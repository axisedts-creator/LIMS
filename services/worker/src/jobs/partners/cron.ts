// partners crontab (02-TRD §8.2). Every entry is tenantScope 'per_tenant' (08 A13 P-6): no platform cron.
// [CONV] TRD §8.2 gives Asia/Kathmandu (UTC+05:45, no DST) local times; the manifest holds 5-field UTC cron, converted here.
import type { CronEntry } from '../../core/manifest.js';

export const crontab: readonly CronEntry[] = [
  { identifier: 'partners.sync_price_list', schedule: '25 20 * * *', tenantScope: 'per_tenant' },      // 02:10
  { identifier: 'partners.sync_statements', schedule: '38 * * * *', tenantScope: 'per_tenant' },      // hourly :23
  { identifier: 'partners.reconcile_orders', schedule: '*/10 * * * *', tenantScope: 'per_tenant' },   // every 10 min
  { identifier: 'partners.expire_drafts', schedule: '55 19 * * *', tenantScope: 'per_tenant' },       // 01:40
  { identifier: 'partners.redact_expired_lines', schedule: '55 20 * * *', tenantScope: 'per_tenant' }, // 02:40
  { identifier: 'partners.purge_access_slips', schedule: '5 21 * * *', tenantScope: 'per_tenant' },   // 02:50
];
