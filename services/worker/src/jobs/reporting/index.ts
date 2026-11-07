// reporting worker manifest (02-TRD §3.3, §9). T01 scaffold: tasks, subscriptions and per_tenant crons land with their tasks.
import type { WorkerManifest } from '../../core/manifest.js';

export const manifest: WorkerManifest = Object.freeze({ module: 'reporting', tasks: {}, subscriptions: {}, crontab: [] });
