// Frontdesk worker manifest (02-TRD §3.3). The event subscriptions are added by their tasks.
import type { WorkerManifest } from '../../core/manifest.js';
import { crontab } from './cron.js';
import { DISCOUNT_APPROVAL_EXPIRE, discountApprovalExpire } from './tasks/discount_approval_expire.js';
import { TRF_DRAFT_PURGE, trfDraftPurge } from './tasks/trf_draft_purge.js';
import { TRF_SCAN, trfScan } from './tasks/trf_scan.js';

export const manifest: WorkerManifest = Object.freeze({
  module: 'frontdesk',
  tasks: Object.freeze({ [DISCOUNT_APPROVAL_EXPIRE]: discountApprovalExpire, [TRF_SCAN]: trfScan, [TRF_DRAFT_PURGE]: trfDraftPurge }),
  maxAttempts: Object.freeze({ [DISCOUNT_APPROVAL_EXPIRE]: 3, [TRF_SCAN]: 5, [TRF_DRAFT_PURGE]: 3 }),
  crontab,
});
