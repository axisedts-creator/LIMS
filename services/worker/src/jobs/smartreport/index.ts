// WorkerManifest of module smartreport (02-TRD §9.1, §9.2). No cron, no purge. systemPermissions live in the API ModuleManifest.
// llm_rephrase stays a fail-closed stub (throws: retried / dead-lettered, never silently acked) until its task.
import type { TaskHandler, WorkerManifest } from '../../core/manifest.js';
import { handle as resultAmended } from './consumers/lab.result.amended.v1.js';
import { handle as resultApproved } from './consumers/lab.result.approved.v1.js';
import { PREBUILD, PREBUILD_MAX_ATTEMPTS } from './consumers/supersede.js';
import { prebuildSummary } from './tasks/prebuild_summary.js';

const llmRephraseStub: TaskHandler = async () => { throw new Error('smartreport.llm_rephrase not implemented'); };

export const manifest: WorkerManifest = {
  module: 'smartreport',
  tasks: { [PREBUILD]: prebuildSummary, 'smartreport.llm_rephrase': llmRephraseStub },
  maxAttempts: { [PREBUILD]: PREBUILD_MAX_ATTEMPTS },
  subscriptions: { // = EVENT_CONSUMERS.smartreport (03-IC §3.10/§3.11)
    'lab.result.approved.v1': resultApproved,
    'lab.result.amended.v1': resultAmended,
  },
  crontab: [],
};
