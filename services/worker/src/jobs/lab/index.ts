// WorkerManifest of module lab (02-CV §2.3). Subscriptions = 02-TRD §7.2 = EVENT_CONSUMERS.lab (validateManifests checks).
// 06-IMPLEMENTATION-PLAN T-01: every consumer is a stub that rejects with common.internal (fail closed: the job retries and
// dead-letters, never acks silently) until its task replaces it with consumers/<event_type>.ts.
// Tasks of 02-TRD §8 are added by their tasks; no crontab in Phase 1 (02-TRD §8).
import { LimsError } from '../../../../api/src/core/errors.js';
import type { ConsumerHandler, WorkerManifest } from '../../core/manifest.js';
import { handle as createdHandler } from './consumers/frontdesk.order.created.v1.js';
import { handle as itemsChangedHandler } from './consumers/frontdesk.order.items_changed.v1.js';
import { handle as cancelledHandler } from './consumers/frontdesk.order.cancelled.v1.js';
import { handle as homeCollectionHandler } from './consumers/homecollection.collection.synced.v1.js';
import { handle as instrumentResultHandler } from './consumers/instruments.result.received.v1.js';

import { handle as reportReleasedHandler } from './consumers/reporting.report.released.v1.js';

const CONSUMED = [
  'frontdesk.order.created.v1',
  'frontdesk.order.items_changed.v1',
  'frontdesk.order.cancelled.v1',
  'instruments.result.received.v1',
  'instruments.qc.received.v1',
  'catalog.changed.v1',
  'quality.qc_run.rejected.v1',
  'homecollection.collection.synced.v1',
  'reporting.report.released.v1',
] as const;

const notImplemented = (eventType: string): ConsumerHandler => async () => {
  throw new LimsError('common.internal', `lab consumer ${eventType} not implemented`);
};

// T-06: the three frontdesk.order.* consumers are real; T-09: homecollection.collection.synced.v1.
const IMPLEMENTED: Readonly<Record<string, ConsumerHandler>> = {
  'frontdesk.order.created.v1': createdHandler,
  'frontdesk.order.items_changed.v1': itemsChangedHandler,
  'frontdesk.order.cancelled.v1': cancelledHandler,
  'homecollection.collection.synced.v1': homeCollectionHandler,
  'reporting.report.released.v1': reportReleasedHandler,   // T-27
  'instruments.result.received.v1': instrumentResultHandler,   // T-22
};

export const manifest: WorkerManifest = {
  module: 'lab',
  tasks: {},
  subscriptions: Object.freeze(Object.fromEntries(CONSUMED.map((t) => [t, IMPLEMENTED[t] ?? notImplemented(t)]))),
  crontab: [],
};
