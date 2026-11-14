// Crontab of module micro (02-TRD §9). All per_tenant (08 A13 P-6). micro.breakpoint_import_validate is enqueued by the API, never cron-driven.
import type { CronEntry } from '../../core/manifest.js';

export const cron: readonly CronEntry[] = [
  { identifier: 'micro.reconcile_chain_status', schedule: '17 2 * * *', tenantScope: 'per_tenant' },
  { identifier: 'micro.refresh_metrics', schedule: '*/5 * * * *', tenantScope: 'per_tenant' },
  { identifier: 'micro.purge_instrument_records', schedule: '43 3 * * *', tenantScope: 'per_tenant' },
];
