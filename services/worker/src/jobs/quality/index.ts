// WorkerManifest of module quality (02-TRD §10.3; IC §3.25). T-01: quality.reprocess_pending_observations as a no-op so instruments (#12) can enqueue it; T-11 replaced it with the real task.
// T-09: quality.sync_qc_observations (cron + the instruments.qc.received.v1 trigger). T-10: quality.close_stale_runs (cron). T-19: quality.tat_sweep (cron), quality.tat_refresh_order (enqueued by the
// lab.specimen.status_changed.v1 consumer), quality.purge_tat_items (cron) and the two TAT consumers: all six tasks, five subscriptions and four crons of TRD §10.2 / §10.3.
// [CONV] max_attempts per the TRD §10.3 literal: 5 everywhere except tat_sweep and purge_tat_items (3: the next run retries anyway). The reprocess and refresh tasks are enqueued, never scheduled (no cron entry).
import type { WorkerManifest } from '../../core/manifest.js';
import { handle as qcReceived } from './consumers/instruments.qc.received.v1.js';
import { handle as resultReceived } from './consumers/instruments.result.received.v1.js';
import { handle as resultVerified } from './consumers/lab.result.verified.v1.js';
import { handle as specimenStatusChanged } from './consumers/lab.specimen.status_changed.v1.js';
import { handle as reportReleased } from './consumers/reporting.report.released.v1.js';
import { crontab } from './cron.js';
import { handle as closeStaleRuns } from './tasks/close_stale_runs.js';
import { handle as purgeTatItems } from './tasks/purge_tat_items.js';
import { handle as reprocessPendingObservations } from './tasks/reprocess_pending_observations.js';
import { handle as syncQcObservations } from './tasks/sync_qc_observations.js';
import { handle as tatRefreshOrder } from './tasks/tat_refresh_order.js';
import { handle as tatSweep } from './tasks/tat_sweep.js';

export const manifest: WorkerManifest = {
  module: 'quality',
  tasks: {
    'quality.reprocess_pending_observations': reprocessPendingObservations, 'quality.sync_qc_observations': syncQcObservations, 'quality.close_stale_runs': closeStaleRuns,
    'quality.tat_sweep': tatSweep, 'quality.tat_refresh_order': tatRefreshOrder, 'quality.purge_tat_items': purgeTatItems,
  },
  subscriptions: {
    'instruments.qc.received.v1': qcReceived, 'instruments.result.received.v1': resultReceived, 'lab.result.verified.v1': resultVerified,   // T-13: qc_activity counter; T-16: verification_log + T-19 TAT stop (§10.2)
    'lab.specimen.status_changed.v1': specimenStatusChanged, 'reporting.report.released.v1': reportReleased,
  },
  crontab,
  maxAttempts: {
    'quality.reprocess_pending_observations': 5, 'quality.sync_qc_observations': 5, 'quality.close_stale_runs': 5, 'quality.tat_sweep': 3, 'quality.tat_refresh_order': 5, 'quality.purge_tat_items': 3,
  },
};
