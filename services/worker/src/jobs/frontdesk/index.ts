// Frontdesk worker manifest (02-TRD §3.3). frontdesk.trf_scan and frontdesk.trf_draft_purge and the event subscriptions are added by their tasks.
import type { WorkerManifest } from '../../core/manifest.js';
import { crontab } from './cron.js';
import { DISCOUNT_APPROVAL_EXPIRE, discountApprovalExpire } from './tasks/discount_approval_expire.js';

export const manifest: WorkerManifest = Object.freeze({
  module: 'frontdesk',
  tasks: Object.freeze({ [DISCOUNT_APPROVAL_EXPIRE]: discountApprovalExpire }),
  maxAttempts: Object.freeze({ [DISCOUNT_APPROVAL_EXPIRE]: 3 }),
  crontab,
});
