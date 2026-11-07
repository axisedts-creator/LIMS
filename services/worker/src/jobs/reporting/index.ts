// reporting worker manifest (02-TRD §3.3, §9). Tasks, subscriptions and per_tenant crons land with their tasks.
import type { WorkerManifest } from '../../core/manifest.js';
import { createProcessInputFile } from './tasks/process_input_file.js';

/** [CONV] the /internal/sanitize client is C6-T12; until it is wired every sanitise attempt throws (queue retry, file never ready). */
const unwiredSandbox = { sanitize: async (): Promise<never> => { throw new Error('pdf_sandbox_not_configured'); } };

export const manifest: WorkerManifest = Object.freeze({
  module: 'reporting',
  tasks: Object.freeze({ 'reporting.process_input_file': createProcessInputFile({ sandbox: unwiredSandbox }) }),
  maxAttempts: Object.freeze({ 'reporting.process_input_file': 5 }),
  subscriptions: {},
  crontab: [],
});
