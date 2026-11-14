// WorkerManifest of module micro (02-CV §2.3). Subscriptions = 02-TRD §8.2 = EVENT_CONSUMERS.micro; tasks = 02-TRD §8.2/§9; crontab in cron.ts.
// 06-IMPLEMENTATION-PLAN T-01: every handler is a stub that rejects with common.internal (fail closed: the job retries and dead-letters,
// never acks silently) until its task replaces it with tasks/<id>.ts / consumers/<event_type>.ts.
import { LimsError } from '../../../../api/src/core/errors.js';
import type { ConsumerHandler, TaskHandler, WorkerManifest } from '../../core/manifest.js';
import { cron } from './cron.js';
import { onInstrumentResult } from './consumers/instruments.result.received.v1.js';
import { onSpecimenStatusChanged } from './consumers/lab.specimen.status_changed.v1.js';
import { breakpointImportValidate } from './tasks/micro.breakpoint_import_validate.js';
import { reconcileChainStatus } from './tasks/micro.reconcile_chain_status.js';
import { refreshMetrics } from './tasks/micro.refresh_metrics.js';
import { purgeInstrumentRecords } from './tasks/micro.purge_instrument_records.js';

const TASKS = ['micro.breakpoint_import_validate', 'micro.reconcile_chain_status', 'micro.refresh_metrics', 'micro.purge_instrument_records'] as const;
const CONSUMED = ['instruments.result.received.v1', 'lab.specimen.status_changed.v1'] as const;

const stub = (what: string) => async (): Promise<void> => { throw new LimsError('common.internal', `micro ${what} not implemented`); };

export const manifest: WorkerManifest = {
  module: 'micro',
  tasks: Object.freeze({
    ...Object.fromEntries(TASKS.map((t) => [t, stub(`task ${t}`) as TaskHandler])),
    'micro.breakpoint_import_validate': breakpointImportValidate, // T-12 (02-TRD §9)
    'micro.reconcile_chain_status': reconcileChainStatus,         // T-18 (all three per_tenant, P-6)
    'micro.refresh_metrics': refreshMetrics,
    'micro.purge_instrument_records': purgeInstrumentRecords,     // 08 A17 D-65
  }),
  subscriptions: Object.freeze({
    ...Object.fromEntries(CONSUMED.map((t) => [t, stub(`consumer ${t}`) as ConsumerHandler])),
    'lab.specimen.status_changed.v1': onSpecimenStatusChanged,
    'instruments.result.received.v1': onInstrumentResult, // T-14
  }),
  crontab: cron,
};
