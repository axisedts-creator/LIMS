// frontdesk crontab (02-TRD §10; 08 A13 P-6: per_tenant — one job per tenant, run under that tenant's claims). trf_scan is enqueued by uploadTrf, not scheduled.
import type { CronEntry } from '../../core/manifest.js';
import { DISCOUNT_APPROVAL_EXPIRE } from './tasks/discount_approval_expire.js';
import { TRF_DRAFT_PURGE } from './tasks/trf_draft_purge.js';

export const crontab: readonly CronEntry[] = Object.freeze([
  Object.freeze({ identifier: DISCOUNT_APPROVAL_EXPIRE, schedule: '*/5 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
  Object.freeze({ identifier: TRF_DRAFT_PURGE, schedule: '15 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
]);
