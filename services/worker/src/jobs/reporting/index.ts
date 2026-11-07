// reporting worker manifest (02-TRD §3.3, §9). Tasks and per_tenant crons land with their tasks.
import type { WorkerManifest } from '../../core/manifest.js';
import { handle as catalogChanged } from './consumers/catalog.changed.v1.js';
import { handle as orderCancelled } from './consumers/frontdesk.order.cancelled.v1.js';
import { handle as orderCreated } from './consumers/frontdesk.order.created.v1.js';
import { handle as itemsChanged } from './consumers/frontdesk.order.items_changed.v1.js';
import { handle as readyForReport } from './consumers/lab.order.ready_for_report.v1.js';
import { handle as resultAmended } from './consumers/lab.result.amended.v1.js';
import { handle as resultApproved } from './consumers/lab.result.approved.v1.js';
import { handle as specimenStatus } from './consumers/lab.specimen.status_changed.v1.js';
import { createProcessInputFile } from './tasks/process_input_file.js';

/** [CONV] the /internal/sanitize client is C6-T12; until it is wired every sanitise attempt throws (queue retry, file never ready). */
const unwiredSandbox = { sanitize: async (): Promise<never> => { throw new Error('pdf_sandbox_not_configured'); } };

export const manifest: WorkerManifest = Object.freeze({
  module: 'reporting',
  tasks: Object.freeze({ 'reporting.process_input_file': createProcessInputFile({ sandbox: unwiredSandbox }) }),
  maxAttempts: Object.freeze({ 'reporting.process_input_file': 5 }),
  subscriptions: Object.freeze({
    'frontdesk.order.created.v1': orderCreated,
    'frontdesk.order.items_changed.v1': itemsChanged,
    'frontdesk.order.cancelled.v1': orderCancelled,
    'lab.specimen.status_changed.v1': specimenStatus,
    'lab.result.approved.v1': resultApproved,
    'lab.result.amended.v1': resultAmended,
    'lab.order.ready_for_report.v1': readyForReport,
    'catalog.changed.v1': catalogChanged,
  }),
  crontab: [],
});
