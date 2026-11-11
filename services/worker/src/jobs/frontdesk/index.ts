// Frontdesk worker manifest (02-TRD §3.3). The event subscriptions are added by their tasks.
import type { WorkerManifest } from '../../core/manifest.js';
import { onBookingCancelled } from './consumers/engagement.booking.cancelled.v1.js';
import { onBookingConfirmed } from './consumers/engagement.booking.confirmed.v1.js';
import { onCatalogChanged } from './consumers/catalog.changed.v1.js';
import { onSpecimenRejected } from './consumers/lab.specimen.rejected.v1.js';
import { onSpecimenStatusChanged } from './consumers/lab.specimen.status_changed.v1.js';
import { crontab } from './cron.js';
import { DISCOUNT_APPROVAL_EXPIRE, discountApprovalExpire } from './tasks/discount_approval_expire.js';
import { TRF_DRAFT_PURGE, trfDraftPurge } from './tasks/trf_draft_purge.js';
import { TRF_SCAN, trfScan } from './tasks/trf_scan.js';

export const manifest: WorkerManifest = Object.freeze({
  module: 'frontdesk',
  subscriptions: Object.freeze({
    'lab.specimen.rejected.v1': onSpecimenRejected, 'lab.specimen.status_changed.v1': onSpecimenStatusChanged, 'catalog.changed.v1': onCatalogChanged,
    'engagement.booking.confirmed.v1': onBookingConfirmed, 'engagement.booking.cancelled.v1': onBookingCancelled,
  }),
  tasks: Object.freeze({ [DISCOUNT_APPROVAL_EXPIRE]: discountApprovalExpire, [TRF_SCAN]: trfScan, [TRF_DRAFT_PURGE]: trfDraftPurge }),
  maxAttempts: Object.freeze({ [DISCOUNT_APPROVAL_EXPIRE]: 3, [TRF_SCAN]: 5, [TRF_DRAFT_PURGE]: 3 }),
  crontab,
});
