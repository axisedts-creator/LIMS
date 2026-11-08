// Billing WorkerManifest (02-TRD §7.2, 02-CONVENTIONS §2.3). Other tasks (billing.cbms_sync, billing.cbms_sweep, exports, ...)
// and subscriptions are added by the tasks that implement them.
import type { WorkerManifest } from '../../core/manifest.js';
import { crontab } from './cron.js';
import { COLLECTION_SYNCED, INTENT_SETTLED, onCollectionSynced, onIntentSettled } from './consumers/index.js';
import { CREDIT_DAYS_CHECK, creditDaysCheck } from './tasks/credit_days_check.js';
import { FISCAL_COUNTER_PREPARE, fiscalCounterPrepare } from './tasks/fiscal_counter_prepare.js';
import { INTEGRITY_CHECK, integrityCheck } from './tasks/integrity_check.js';
import { EXPORT_TENANT, exportTenant } from './tasks/export_tenant.js';
import { CBMS_SYNC, cbmsSync } from './tasks/cbms_sync.js';
import { CBMS_SWEEP, cbmsSweep } from './tasks/cbms_sweep.js';
import { EXPORT_RENDER, exportRender } from './tasks/export_render.js';
import { EXPORT_PURGE, exportPurge } from './tasks/export_purge.js';

export const manifest: WorkerManifest = Object.freeze({
  module: 'billing',
  tasks: Object.freeze({
    [FISCAL_COUNTER_PREPARE]: fiscalCounterPrepare, [CREDIT_DAYS_CHECK]: creditDaysCheck, [INTEGRITY_CHECK]: integrityCheck, [EXPORT_TENANT]: exportTenant,
    [CBMS_SYNC]: cbmsSync, [CBMS_SWEEP]: cbmsSweep, [EXPORT_RENDER]: exportRender, [EXPORT_PURGE]: exportPurge,
  }),
  maxAttempts: Object.freeze({
    [FISCAL_COUNTER_PREPARE]: 5, [CREDIT_DAYS_CHECK]: 3, [INTEGRITY_CHECK]: 1, [EXPORT_TENANT]: 1, [CBMS_SYNC]: 10, [CBMS_SWEEP]: 3, [EXPORT_RENDER]: 5, [EXPORT_PURGE]: 3,
  }),
  subscriptions: Object.freeze({ [INTENT_SETTLED]: onIntentSettled, [COLLECTION_SYNCED]: onCollectionSynced }),
  crontab,
});
