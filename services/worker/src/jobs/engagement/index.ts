// WorkerManifest of module engagement (02-TRD §3.3, §7.2, §8.1; IC §3.25). Cron entries live here, in code (REQ-ARCH-042).
// T-01: every handler is a fail-closed stub (throws) so an event/task is retried or dead-lettered, never silently acked;
// each later task replaces its own entry. [CONV] LIMS_ENGAGEMENT_* is validated by the API module at import; worker bootstrap calls loadEngagementConfig() when it exists (no worker test env yet). The §8.2 crontab rows (and their tasks) are added by the tasks that implement them.
import type { ConsumerHandler, TaskHandler, WorkerManifest } from '../../core/manifest.js';
import { createDispatchDueReminders } from './tasks/dispatch_due_reminders.js';
import { createSendReminder } from './tasks/send_reminder.js';

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
    'engagement.send_reminder': createSendReminder(), // T-R1
    'engagement.dispatch_due_reminders': createDispatchDueReminders(), // T-R1 (cron-only task: no §8.1 row)
  }),
  subscriptions: Object.freeze(Object.fromEntries(SUBSCRIPTIONS.map((type) => [type, consumer(type)]))),
  crontab: Object.freeze([Object.freeze({ identifier: 'engagement.dispatch_due_reminders', schedule: '*/5 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 })]), // TRD §8.2
  maxAttempts: TASKS,
});
