// WorkerManifest of module anatomic (02-TRD §3.2, §9). No cron, no purge job. systemPermissions live in the API ModuleManifest.
// C11 T-01: subscribes only lab.specimen.status_changed.v1; lab.result.* consumers arrive with T-27 (CR-C11-011).
// Fail-closed stub: a throw is retried / dead-lettered, never silently acked; the consumer task replaces it.
import type { ConsumerHandler, WorkerManifest } from '../../core/manifest.js';

const consumer = (type: string): ConsumerHandler => async () => { throw new Error(`consumer ${type} not implemented`); };

export const manifest: WorkerManifest = {
  module: 'anatomic',
  tasks: {},
  subscriptions: { 'lab.specimen.status_changed.v1': consumer('lab.specimen.status_changed.v1') },
  crontab: [],
};
