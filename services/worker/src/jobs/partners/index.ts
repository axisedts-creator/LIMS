// WorkerManifest of module partners (02-TRD §3.5, §7.2, §8.1, §8.2; IC §3.25). Cron entries live here, in code (REQ-ARCH-042).
// T01: every handler is a fail-closed stub (throws) so an event/task is retried or dead-lettered, never silently acked;
// each later task replaces its own entries. C13 produces no event.
// [CONV] TRD §8.2 gives Asia/Kathmandu (UTC+05:45, no DST) local times; the manifest holds 5-field UTC cron, converted here.
import type { ConsumerHandler, TaskHandler, WorkerManifest } from '../../core/manifest.js';

const task = (id: string): TaskHandler => async () => { throw new Error(`${id} not implemented`); };
const consumer = (type: string): ConsumerHandler => async () => { throw new Error(`consumer ${type} not implemented`); };

/** TRD §8.1 (id -> attempts). */
const TASKS = {
  'partners.convert_manifest_line': 10, 'partners.sync_price_list': 10, 'partners.sync_statements': 10, 'partners.reconcile_orders': 10,
  'partners.expire_drafts': 3, 'partners.redact_expired_lines': 3, 'partners.enrich_report': 10, 'partners.issue_access_slip': 10,
  'partners.purge_access_slips': 3,
} as const;

// = EVENT_CONSUMERS.partners = IC §3.25 rows whose Consumers cell lists C13
const SUBSCRIPTIONS = [
  'catalog.changed.v1', 'frontdesk.order.cancelled.v1', 'lab.specimen.status_changed.v1', 'reporting.report.released.v1',
] as const;

export const manifest: WorkerManifest = {
  module: 'partners',
  tasks: Object.fromEntries(Object.keys(TASKS).map((id) => [id, task(id)])),
  subscriptions: Object.fromEntries(SUBSCRIPTIONS.map((type) => [type, consumer(type)])),
  crontab: [ // TRD §8.2 local (NPT) -> UTC
    { identifier: 'partners.sync_price_list', schedule: '25 20 * * *', tenantScope: 'per_tenant' },      // 02:10
    { identifier: 'partners.sync_statements', schedule: '38 * * * *', tenantScope: 'per_tenant' },      // hourly :23
    { identifier: 'partners.reconcile_orders', schedule: '*/10 * * * *', tenantScope: 'per_tenant' },   // every 10 min
    { identifier: 'partners.expire_drafts', schedule: '55 19 * * *', tenantScope: 'per_tenant' },       // 01:40
    { identifier: 'partners.redact_expired_lines', schedule: '55 20 * * *', tenantScope: 'per_tenant' }, // 02:40
    { identifier: 'partners.purge_access_slips', schedule: '5 21 * * *', tenantScope: 'per_tenant' },   // 02:50
  ],
  maxAttempts: TASKS,
};
