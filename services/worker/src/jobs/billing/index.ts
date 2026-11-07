// Billing WorkerManifest (02-TRD §7.2, 02-CONVENTIONS §2.3). Tasks (billing.cbms_sync, billing.cbms_sweep, exports, ...)
// and subscriptions are added by the tasks that implement them; the skeleton declares none.
import type { WorkerManifest } from '../../core/manifest.js';

export const manifest: WorkerManifest = {
  module: 'billing',
  tasks: {},
  subscriptions: {},
  crontab: [],
};
