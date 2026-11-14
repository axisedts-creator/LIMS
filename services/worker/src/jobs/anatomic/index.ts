// WorkerManifest of module anatomic (02-TRD §3.2, §9). No cron, no purge job. systemPermissions live in the API ModuleManifest.
// C11 T-05: lab.specimen.status_changed.v1 is the intake consumer; lab.result.* consumers arrive with T-27 (CR-C11-011).
import type { WorkerManifest } from '../../core/manifest.js';
import { handle as specimenStatusChanged } from './consumers/lab.specimen.status_changed.v1.js';
import { PROCESS_IMAGE, processImageTask } from './tasks/anatomic.process_image.js';

export const manifest: WorkerManifest = {
  module: 'anatomic',
  tasks: { [PROCESS_IMAGE]: processImageTask },
  maxAttempts: { [PROCESS_IMAGE]: 5 },   // 02-TRD §9
  subscriptions: { 'lab.specimen.status_changed.v1': specimenStatusChanged },
  crontab: [],
};
