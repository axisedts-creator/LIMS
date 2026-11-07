// Frontdesk worker manifest (02-TRD §3.3). Tasks (frontdesk.trf_scan, frontdesk.trf_draft_purge,
// frontdesk.discount_approval_expire) and event subscriptions are added by their tasks; empty registers nothing.
import type { WorkerManifest } from '../../core/manifest.js';

export const manifest: WorkerManifest = { module: 'frontdesk' };
