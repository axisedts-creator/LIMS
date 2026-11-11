// Payments WorkerManifest (02-TRD §8, 02-CONVENTIONS §2.3). PG-T01 skeleton: no tasks, crons or subscriptions yet
// (§8.2: this module consumes no events); the tasks of §8.3 are added by the tasks that implement them.
// Boot checks (TRD §9.3, "API and worker"): config is validated at import.
import { loadPaymentsConfig } from '../../../../api/src/modules/payments/config.js';
import type { WorkerManifest } from '../../core/manifest.js';

export const config = loadPaymentsConfig();

export const manifest: WorkerManifest = Object.freeze({
  module: 'payments',
  tasks: Object.freeze({}),
  maxAttempts: Object.freeze({}),
  subscriptions: Object.freeze({}),
  crontab: Object.freeze([]),
});
