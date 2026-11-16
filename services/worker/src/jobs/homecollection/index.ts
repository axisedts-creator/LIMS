// Homecollection WorkerManifest (02-CONVENTIONS §2.3). T0B-ASYNC-2 (CR-C0-T0B-ASYNC-1-001; LD-279, LD-189): declares only the API-enqueued task
// that fits JobContext. homecollection.refresh_visit_specimens is NOT declared: it needs ctx.ports.LabPort, absent from JobContext and not wired
// by bootstrap (CR-C0-T0B-ASYNC-2-001). Cron sweeps/purges (./cron.ts) and ./consumers subscriptions are added by the task that enables them.
import type { WorkerManifest } from '../../core/manifest.js';
import { flagHandoverDiscrepancy } from './tasks/flag_handover_discrepancy.js';

export const manifest: WorkerManifest = Object.freeze({
  module: 'homecollection',
  tasks: Object.freeze({
    'homecollection.flag_handover_discrepancy': flagHandoverDiscrepancy,
  }),
});
