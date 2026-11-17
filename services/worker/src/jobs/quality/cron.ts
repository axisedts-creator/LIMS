// Crontab of module quality (02-TRD §10.3; 08 A13 P-6). T-09: the QC import every minute per tenant. T-10: the stale-run close every minute per tenant. T-19: the TAT sweep every minute per tenant and the
// daily purge of expired TAT clocks (08 A17 P-18(c)). quality.tat_refresh_order and quality.reprocess_pending_observations are enqueued, never scheduled.
import type { CronEntry } from '../../core/manifest.js';

export const crontab: readonly CronEntry[] = [
  { identifier: 'quality.sync_qc_observations', schedule: '* * * * *', tenantScope: 'per_tenant' },
  { identifier: 'quality.close_stale_runs', schedule: '* * * * *', tenantScope: 'per_tenant' },
  { identifier: 'quality.tat_sweep', schedule: '* * * * *', tenantScope: 'per_tenant' },
  { identifier: 'quality.purge_tat_items', schedule: '40 2 * * *', tenantScope: 'per_tenant' },
];
