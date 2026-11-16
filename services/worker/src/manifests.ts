// T0B-ASYNC-1 (audit RS-10; LD-277): the ONE list of worker manifests. main.ts and core/registry-sync.ts both import it, so a jobs module
// cannot be loaded by one and not the other. Add a line here when a new services/worker/src/jobs/<m>/index.ts appears (async-manifests.test.ts fails until then).
// Note: jobs/payments/index.ts validates its config at import (LIMS_PAYMENTS_* variables, see docs/runbooks/staging-worker.md).
import type { WorkerManifest } from './core/manifest.js';
import { manifest as analytics } from './jobs/analytics/index.js';
import { manifest as anatomic } from './jobs/anatomic/index.js';
import { manifest as billing } from './jobs/billing/index.js';
import { manifest as engagement } from './jobs/engagement/index.js';
import { manifest as frontdesk } from './jobs/frontdesk/index.js';
import { manifest as identity } from './jobs/identity/index.js';
import { manifest as instruments } from './jobs/instruments/index.js';
import { manifest as inventory } from './jobs/inventory/index.js';
import { manifest as lab } from './jobs/lab/index.js';
import { manifest as micro } from './jobs/micro/index.js';
import { manifest as partners } from './jobs/partners/index.js';
import { manifest as payments } from './jobs/payments/index.js';
import { manifest as quality } from './jobs/quality/index.js';
import { manifest as reporting } from './jobs/reporting/index.js';
import { manifest as smartreport } from './jobs/smartreport/index.js';

export const MANIFESTS: readonly WorkerManifest[] = Object.freeze([
  analytics, anatomic, billing, engagement, frontdesk, identity, instruments, inventory, lab, micro, partners, payments, quality, reporting, smartreport,
]);
