// Crontab of module quality (02-TRD §10.3; 08 A13 P-6). T-09: the QC import every minute per tenant. T-10: the stale-run close every minute per tenant. Later tasks append tat_sweep, purge_tat_items.
import type { CronEntry } from '../../core/manifest.js';

export const crontab: readonly CronEntry[] = [
  { identifier: 'quality.sync_qc_observations', schedule: '* * * * *', tenantScope: 'per_tenant' },
  { identifier: 'quality.close_stale_runs', schedule: '* * * * *', tenantScope: 'per_tenant' },
];
