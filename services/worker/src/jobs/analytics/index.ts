// WorkerManifest of module analytics (02-TRD §9.3, §9.4; IC §3.25). Cron entries live here, in code (REQ-ARCH-042).
// AN-T01: every handler is a fail-closed stub (throws) so an event/task is retried or dead-lettered, never silently acked;
// each later task replaces its own entries.
// [CONV] §9.3 lists max_attempts 3 for sweeps/purge, the §9.4 literal omits it: literal followed.
import type { ConsumerHandler, TaskHandler, WorkerManifest } from '../../core/manifest.js';
import { consumers } from './consumers/index.js';
import { backfillTask } from './tasks/backfill.js';
import { buildExportTask } from './tasks/build_export.js';
import { dispatchSchedulesTask } from './tasks/dispatch_schedules.js';
import { purgeTask } from './tasks/purge.js';
import { refreshTenantTask } from './tasks/refresh_tenant.js';
import { selfCheckTask } from './tasks/self_check.js';
import { sweepNightlyTask } from './tasks/sweep_nightly.js';
import { sweepRecentTask } from './tasks/sweep_recent.js';

const task = (id: string): TaskHandler => async () => { throw new Error(`${id} not implemented`); };
const consumer = (type: string): ConsumerHandler => async () => { throw new Error(`consumer ${type} not implemented`); };

const TASKS = [
  'analytics.refresh_tenant', 'analytics.sweep_recent', 'analytics.sweep_nightly', 'analytics.self_check',
  'analytics.build_export', 'analytics.dispatch_schedules', 'analytics.purge', 'analytics.backfill',
] as const;

// = EVENT_CONSUMERS.analytics = IC §3.25 rows whose Consumers cell lists C8
const SUBSCRIPTIONS = [
  'billing.invoice.cancelled.v1', 'billing.invoice.issued.v1', 'frontdesk.order.cancelled.v1', 'frontdesk.order.created.v1',
  'instruments.agent.health_changed.v1', 'lab.critical_value.detected.v1', 'lab.result.amended.v1', 'lab.result.approved.v1',
  'lab.result.verified.v1', 'lab.specimen.status_changed.v1', 'reporting.delivery.status_changed.v1', 'reporting.report.released.v1',
] as const;

export const manifest: WorkerManifest = {
  module: 'analytics',
  tasks: { // AN-T04 refresh_tenant + AN-T06 sweeps/self_check/purge/backfill, AN-T15 build_export, AN-T16 dispatch_schedules are real
    ...Object.fromEntries(TASKS.map((id) => [id, task(id)])),
    'analytics.refresh_tenant': refreshTenantTask, 'analytics.sweep_recent': sweepRecentTask, 'analytics.sweep_nightly': sweepNightlyTask,
    'analytics.self_check': selfCheckTask, 'analytics.purge': purgeTask, 'analytics.backfill': backfillTask, 'analytics.build_export': buildExportTask,
    'analytics.dispatch_schedules': dispatchSchedulesTask,
  },
  subscriptions: Object.fromEntries(SUBSCRIPTIONS.map((type) => [type, consumers[type] ?? consumer(type)])), // AN-T05: all 12 real
  crontab: [
    { identifier: 'analytics.sweep_recent', schedule: '*/10 * * * *', tenantScope: 'per_tenant' },
    { identifier: 'analytics.sweep_nightly', schedule: '45 20 * * *', tenantScope: 'per_tenant' },
    { identifier: 'analytics.dispatch_schedules', schedule: '*/15 * * * *', tenantScope: 'per_tenant' },
    { identifier: 'analytics.purge', schedule: '15 21 * * *', tenantScope: 'per_tenant' },
  ],
  maxAttempts: { 'analytics.refresh_tenant': 5, 'analytics.build_export': 3, 'analytics.dispatch_schedules': 5 },
  taskOptions: {
    'analytics.sweep_nightly': { statementTimeoutMs: 120000 },
    'analytics.backfill': { statementTimeoutMs: 120000 },
  },
};
