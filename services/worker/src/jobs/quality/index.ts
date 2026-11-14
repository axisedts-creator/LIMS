// WorkerManifest of module quality (02-TRD §10.3; IC §3.25). T-01: quality.reprocess_pending_observations as a no-op so instruments (#12) can enqueue it; T-11 replaced it with the real task.
// T-09: quality.sync_qc_observations (cron + the instruments.qc.received.v1 trigger). T-10: quality.close_stale_runs (cron). Later tasks add the other tasks, subscriptions and crons.
// [CONV] max_attempts 5 per the TRD §10.3 manifest literal. The reprocess task is enqueued, never scheduled (no cron entry).
import type { WorkerManifest } from '../../core/manifest.js';
import { handle as qcReceived } from './consumers/instruments.qc.received.v1.js';
import { handle as resultReceived } from './consumers/instruments.result.received.v1.js';
import { crontab } from './cron.js';
import { handle as closeStaleRuns } from './tasks/close_stale_runs.js';
import { handle as reprocessPendingObservations } from './tasks/reprocess_pending_observations.js';
import { handle as syncQcObservations } from './tasks/sync_qc_observations.js';

export const manifest: WorkerManifest = {
  module: 'quality',
  tasks: { 'quality.reprocess_pending_observations': reprocessPendingObservations, 'quality.sync_qc_observations': syncQcObservations, 'quality.close_stale_runs': closeStaleRuns },
  subscriptions: { 'instruments.qc.received.v1': qcReceived, 'instruments.result.received.v1': resultReceived },   // T-13: qc_activity counter (§10.2)
  crontab,
  maxAttempts: { 'quality.reprocess_pending_observations': 5, 'quality.sync_qc_observations': 5, 'quality.close_stale_runs': 5 },
};
