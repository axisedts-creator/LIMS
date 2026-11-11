// WorkerManifest of module smartreport (02-TRD §9.1, §9.2). No cron, no purge. systemPermissions live in the API ModuleManifest.
// SR-T01: every handler is a fail-closed stub (throws) so an event/task is retried or dead-lettered, never silently acked;
// later tasks replace them (prebuild_summary, llm_rephrase, onResultApproved, onResultAmended).
import type { ConsumerHandler, TaskHandler, WorkerManifest } from '../../core/manifest.js';

const task = (id: string): TaskHandler => async () => { throw new Error(`${id} not implemented`); };
const consumer = (type: string): ConsumerHandler => async () => { throw new Error(`consumer ${type} not implemented`); };

export const manifest: WorkerManifest = {
  module: 'smartreport',
  tasks: { 'smartreport.prebuild_summary': task('smartreport.prebuild_summary'), 'smartreport.llm_rephrase': task('smartreport.llm_rephrase') },
  subscriptions: { // = EVENT_CONSUMERS.smartreport (03-IC §3.10/§3.11)
    'lab.result.approved.v1': consumer('lab.result.approved.v1'),
    'lab.result.amended.v1': consumer('lab.result.amended.v1'),
  },
  crontab: [],
};
