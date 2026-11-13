// WorkerManifest of module engagement (02-TRD §3.3, §7.2, §8.1; IC §3.25). Cron entries live here, in code (REQ-ARCH-042).
// T-01: every handler is a fail-closed stub (throws) so an event/task is retried or dead-lettered, never silently acked;
// each later task replaces its own entry. [CONV] LIMS_ENGAGEMENT_* is validated by the API module at import; worker bootstrap calls loadEngagementConfig() when it exists (no worker test env yet). The §8.2 crontab rows (and their tasks) are added by the tasks that implement them.
import type { ConsumerHandler, TaskHandler, WorkerManifest } from '../../core/manifest.js';
import { CLOSE_QUEUE_DAY, closeQueueDay, crontab } from './cron.js';
import { handle as catalogChanged } from './consumers/catalog.changed.v1.js';
import { createDispatchDueReminders } from './tasks/dispatch_due_reminders.js';
import { PURGE_EPHEMERAL, PURGE_QUEUE, purgeEphemeral, purgeQueue } from './tasks/purge.js';
import { SYNC_BOOKING_CENTRES, SYNC_BOOKING_CENTRES_NIGHTLY, syncBookingCentres, syncBookingCentresNightly } from './tasks/sync_booking_centres.js';
import { createSendLoginOtp } from './tasks/send_login_otp.js';
import { createSendBookingMessage } from './tasks/send_booking_message.js';
import { createSendReminder } from './tasks/send_reminder.js';
import { SYNC_NIGHTLY, syncBookableItems, syncBookableItemsNightly } from './tasks/sync_bookable_items.js';

const task = (id: string): TaskHandler => async () => { throw new Error(`${id} not implemented`); };
const consumer = (type: string): ConsumerHandler => async () => { throw new Error(`consumer ${type} not implemented`); };

// TRD §8.1 task -> max_attempts
const TASKS = {
  'engagement.send_login_otp': 3, 'engagement.create_self_patient': 10, 'engagement.backfill_link': 10, 'engagement.fetch_smart_summary': 5,
  'engagement.create_payment_intent': 3, 'engagement.refresh_payment_request': 3, 'engagement.send_booking_message': 8,
  'engagement.send_reminder': 8, 'engagement.sync_bookable_items': 5, 'engagement.sync_booking_centres': 5,
} as const;

// = EVENT_CONSUMERS.engagement (TRD §7.2)
const SUBSCRIPTIONS = [
  'billing.balance.changed.v1', 'catalog.changed.v1', 'homecollection.collection.synced.v1', 'lab.specimen.rejected.v1',
  'lab.specimen.status_changed.v1', 'reporting.report.released.v1',
] as const;

export const manifest: WorkerManifest = Object.freeze({
  module: 'engagement',
  tasks: Object.freeze({
    ...Object.fromEntries(Object.keys(TASKS).map((id) => [id, task(id)])),
    [CLOSE_QUEUE_DAY]: closeQueueDay, // T-Q2: close_queue_day
    'engagement.send_login_otp': createSendLoginOtp(), // T-A2
    'engagement.send_booking_message': createSendBookingMessage(), // T-B5
    'engagement.send_reminder': createSendReminder(), // T-R1
    'engagement.dispatch_due_reminders': createDispatchDueReminders(), // T-R1 (cron-only task: no §8.1 row)
    [PURGE_EPHEMERAL]: purgeEphemeral, // T-OPS1 (cron-only)
    [PURGE_QUEUE]: purgeQueue, // T-OPS1 (cron-only)
    [SYNC_BOOKING_CENTRES]: syncBookingCentres, // T-B2
    [SYNC_BOOKING_CENTRES_NIGHTLY]: syncBookingCentresNightly, // T-B2 (cron-only: no §8.1 row)
    'engagement.sync_bookable_items': syncBookableItems, // T-B1
    [SYNC_NIGHTLY]: syncBookableItemsNightly, // T-B1 (cron-only task: no §8.1 row)
  }),
  subscriptions: Object.freeze({
    ...Object.fromEntries(SUBSCRIPTIONS.map((type) => [type, consumer(type)])),
    'catalog.changed.v1': catalogChanged, // T-B1 (CR-C16-013)
  }),
  crontab, // TRD §8.2 rows live in cron.ts (close_queue_day, dispatch_due_reminders)
  maxAttempts: TASKS,
});
