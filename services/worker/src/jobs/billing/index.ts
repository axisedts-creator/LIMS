// Billing WorkerManifest (02-TRD §7.2, 02-CONVENTIONS §2.3). Other tasks (billing.cbms_sync, billing.cbms_sweep, exports, ...)
// and subscriptions are added by the tasks that implement them.
import type { WorkerManifest } from '../../core/manifest.js';
import { crontab } from './cron.js';
import { FISCAL_COUNTER_PREPARE, fiscalCounterPrepare } from './tasks/fiscal_counter_prepare.js';
import { INTEGRITY_CHECK, integrityCheck } from './tasks/integrity_check.js';
import { EXPORT_TENANT, exportTenant } from './tasks/export_tenant.js';

export const manifest: WorkerManifest = Object.freeze({
  module: 'billing',
  tasks: Object.freeze({ [FISCAL_COUNTER_PREPARE]: fiscalCounterPrepare, [INTEGRITY_CHECK]: integrityCheck, [EXPORT_TENANT]: exportTenant }),
  maxAttempts: Object.freeze({ [FISCAL_COUNTER_PREPARE]: 5, [INTEGRITY_CHECK]: 1, [EXPORT_TENANT]: 1 }),
  subscriptions: Object.freeze({}),
  crontab,
});
