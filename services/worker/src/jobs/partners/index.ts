// WorkerManifest of module partners (02-TRD §3.5, §7.2, §8.1, §8.2; IC §3.25). Cron entries live here, in code (REQ-ARCH-042).
// T01: every handler is a fail-closed stub (throws) so an event/task is retried or dead-lettered, never silently acked;
// each later task replaces its own entries (T17: sync_price_list, sync_statements, catalog.changed.v1). C13 produces no event.
// [CONV] TRD §8.2 gives Asia/Kathmandu (UTC+05:45, no DST) local times; the manifest holds 5-field UTC cron, converted here.
import type { ConsumerHandler, TaskHandler, WorkerManifest } from '../../core/manifest.js';
import { onCatalogChanged } from './consumers/catalog.changed.v1.js';
import { onSpecimenStatusChanged } from './consumers/lab.specimen.status_changed.v1.js';
import { onReportReleased } from './consumers/reporting.report.released.v1.js';
import { crontab } from './cron.js';
import { convertManifestLine } from './tasks/partners.convert_manifest_line.js';
import { enrichReportTask } from './tasks/partners.enrich_report.js';
import { issueAccessSlip } from './tasks/partners.issue_access_slip.js';
import { purgeAccessSlips } from './tasks/partners.purge_access_slips.js';
import { expireDrafts } from './tasks/partners.expire_drafts.js';
import { reconcileOrdersTask } from './tasks/partners.reconcile_orders.js';
import { redactExpiredLines } from './tasks/partners.redact_expired_lines.js';
import { syncPriceListTask } from './tasks/partners.sync_price_list.js';
import { syncStatementsTask } from './tasks/partners.sync_statements.js';

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
  tasks: {
    ...Object.fromEntries(Object.keys(TASKS).map((id) => [id, task(id)])),
    'partners.sync_price_list': syncPriceListTask, 'partners.sync_statements': syncStatementsTask, // T17
    'partners.reconcile_orders': reconcileOrdersTask, 'partners.enrich_report': enrichReportTask,  // T12
    'partners.convert_manifest_line': convertManifestLine, // T10
    'partners.expire_drafts': expireDrafts,                // T21
    'partners.redact_expired_lines': redactExpiredLines,   // T21
    'partners.issue_access_slip': issueAccessSlip, 'partners.purge_access_slips': purgeAccessSlips, // T14
  },
  subscriptions: {
    ...Object.fromEntries(SUBSCRIPTIONS.map((type) => [type, consumer(type)])),
    'catalog.changed.v1': onCatalogChanged, // T17
    'lab.specimen.status_changed.v1': onSpecimenStatusChanged, 'reporting.report.released.v1': onReportReleased, // T12
  },
  crontab, // cron.ts (T21): TRD §8.2 local (NPT) -> UTC
  maxAttempts: TASKS,
};
