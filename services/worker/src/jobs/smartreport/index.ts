// WorkerManifest of module smartreport (02-TRD §9.1, §9.2). No cron, no purge. systemPermissions live in the API ModuleManifest.
import type { WorkerManifest } from '../../core/manifest.js';
import { handle as resultAmended } from './consumers/lab.result.amended.v1.js';
import { handle as resultApproved } from './consumers/lab.result.approved.v1.js';
import { PREBUILD, PREBUILD_MAX_ATTEMPTS } from './consumers/supersede.js';
import { LLM_MAX_ATTEMPTS, LLM_REPHRASE, llmRephrase } from './tasks/llm_rephrase.js';
import { prebuildSummary } from './tasks/prebuild_summary.js';

export const manifest: WorkerManifest = {
  module: 'smartreport',
  tasks: { [PREBUILD]: prebuildSummary, [LLM_REPHRASE]: llmRephrase },
  maxAttempts: { [PREBUILD]: PREBUILD_MAX_ATTEMPTS, [LLM_REPHRASE]: LLM_MAX_ATTEMPTS },
  subscriptions: { // = EVENT_CONSUMERS.smartreport (03-IC §3.10/§3.11)
    'lab.result.approved.v1': resultApproved,
    'lab.result.amended.v1': resultAmended,
  },
  crontab: [],
};
