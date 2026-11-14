// WorkerManifest of module quality (02-TRD §10.3; IC §3.25). C9 T-01 registers only quality.reprocess_pending_observations, as a no-op, so
// the instruments module (#12) can enqueue it before T-11 replaces it. Later tasks add the other tasks, subscriptions and crons.
// [CONV] max_attempts 5 per the TRD §10.3 manifest literal. The task is enqueued, never scheduled (no cron entry).
import type { TaskHandler, WorkerManifest } from '../../core/manifest.js';

const reprocessPendingObservations: TaskHandler = async () => undefined; // T-11 replaces

export const manifest: WorkerManifest = {
  module: 'quality',
  tasks: { 'quality.reprocess_pending_observations': reprocessPendingObservations },
  maxAttempts: { 'quality.reprocess_pending_observations': 5 },
};
