// Homecollection WorkerManifest (02-CONVENTIONS §2.3). T0B-ASYNC-2 (CR-C0-T0B-ASYNC-1-001; LD-279, LD-189): declares only the two tasks the API
// enqueues. Cron sweeps/purges (./cron.ts) and ./consumers subscriptions are added by the task that enables them.
import type { WorkerManifest } from '../../core/manifest.js';
import { flagHandoverDiscrepancy } from './tasks/flag_handover_discrepancy.js';
import { refreshVisitSpecimens } from './tasks/refresh_visit_specimens.js';

export const manifest: WorkerManifest = Object.freeze({
  module: 'homecollection',
  tasks: Object.freeze({
    'homecollection.flag_handover_discrepancy': flagHandoverDiscrepancy, 'homecollection.refresh_visit_specimens': refreshVisitSpecimens,
  }),
});
