// engagement cron rows (02-TRD §8.2, REQ-ARCH-042: cron entries live in code) and their task handlers.
// close_queue_day: daily 23:50 Asia/Kathmandu (UTC+05:45) = 18:05 UTC -> schedule fields are UTC (core/manifest.ts), so `5 18 * * *`; per_tenant (08 A13 P-6).
import type { CronEntry, TaskHandler } from '../../core/manifest.js';
import { businessDate } from '../../../../api/src/modules/engagement/domain/queueToken.state.js';
import { PURGE_EPHEMERAL, PURGE_QUEUE } from './tasks/purge.js';
import { SYNC_BOOKING_CENTRES_NIGHTLY } from './tasks/sync_booking_centres.js';

import { createLinkService } from '../../../../api/src/modules/engagement/service/link.service.js';

export const CLOSE_QUEUE_DAY = 'engagement.close_queue_day';
export const RECONCILE_LINKS = 'engagement.reconcile_links';
const TENANT_TZ = 'Asia/Kathmandu'; // [CONV] 05-SCHEMA P-15: the only v1 tenant timezone
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const crontab: readonly CronEntry[] = Object.freeze([
  Object.freeze({ identifier: CLOSE_QUEUE_DAY, schedule: '5 18 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
  Object.freeze({ identifier: 'engagement.dispatch_due_reminders', schedule: '*/5 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }), // T-R1
  // T-OPS1 (UTC fields, NPT = UTC+05:45): purge_ephemeral hourly :37 NPT = minute 52 UTC; purge_queue daily 03:10 NPT = 21:25 UTC
  Object.freeze({ identifier: PURGE_EPHEMERAL, schedule: '52 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
  // T-B2: sync_booking_centres_nightly daily 01:50 NPT = 20:05 UTC (08 A19 D-119)
  Object.freeze({ identifier: SYNC_BOOKING_CENTRES_NIGHTLY, schedule: '5 20 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 5 }),
  Object.freeze({ identifier: PURGE_QUEUE, schedule: '25 21 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }),
  Object.freeze({ identifier: 'engagement.reconcile_bookings', schedule: '*/10 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }), // T-B4 (TRD §8.2)
  Object.freeze({ identifier: 'engagement.mark_no_shows', schedule: '*/15 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }), // T-B4 (TRD §8.2)
  Object.freeze({ identifier: 'engagement.sync_bookable_items_nightly', schedule: '55 19 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }), // T-B1: 01:40 Asia/Kathmandu = 19:55 UTC
  Object.freeze({ identifier: 'engagement.expire_memberships', schedule: '35 18 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }), // T-M1: 00:20 NPT = 18:35 UTC (TRD §8.2)
  Object.freeze({ identifier: 'engagement.expire_payment_requests', schedule: '*/10 * * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }), // T-PAY1 (TRD §8.2)
  Object.freeze({ identifier: RECONCILE_LINKS, schedule: '35 20 * * *', tenantScope: 'per_tenant' as const, maxAttempts: 3 }), // T-L5: 02:20 Asia/Kathmandu = 20:35 UTC (TRD §8.2)
]);

/** T-L5 (TRD §4.3.5, §4.4): suspension checks, snapshot refresh and projection deletion; logic lives in link.service. Same tenant guard as close_queue_day (REQ-SEC-024). */
export const reconcileLinks: TaskHandler = async (payload, ctx) => {
  const tenantId = payload?.tenant_id;
  if (typeof tenantId !== 'string' || !UUID.test(tenantId) || ctx.tenantId !== tenantId) return;
  await createLinkService().reconcile(ctx as any);
};

/** T-10 (03-APP-FLOW §4.3): still-open tokens (waiting/called/serving) of today's business day -> expired. Idempotent (a rerun matches nothing); counters are never touched.
 *  Tenant guard (REQ-SEC-024): acts only when payload.tenant_id is a uuid equal to the job's tenant; otherwise it resolves without running a statement. */
export const closeQueueDay: TaskHandler = async (payload, ctx) => {
  const tenantId = payload?.tenant_id;
  if (typeof tenantId !== 'string' || !UUID.test(tenantId) || ctx.tenantId !== tenantId) return;
  await ctx.tx.query(
    `UPDATE engagement.queue_tokens SET status = 'expired', version = version + 1, updated_at = now(), updated_by = $2
     WHERE tenant_id = $1 AND business_date = $3::date AND status IN ('waiting', 'called', 'serving')`,
    [tenantId, ctx.actor.id, businessDate(new Date(ctx.now()), TENANT_TZ)]);
};
