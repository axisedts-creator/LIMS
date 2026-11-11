// `analytics.backfill` (02-TRD §9.3 + order_index seed SQL; 08 A17 D-50; max_attempts 3; statement timeout 120 s via taskOptions, CR-C8-012): manual, per tenant.
// payload { tenant_id, from, to, family? } - ISO dates, half-open [from, to). Per 7-day step [a, b): (1) seed analytics.order_index from the published view
// reporting.v_pub_order_report_tat (orders no C8 event ever saw; ON CONFLICT DO NOTHING keeps complete event-written rows), (2) mark the step dirty (all
// families or only `family`; the backlog snapshot with the LAST step, after every seed), (3) refresh inline before the next step starts. A failed step rejects;
// the retry redoes it idempotently. Unknown payload fields are ignored.
import { loadAnalyticsConfig } from '../../../../../api/src/modules/analytics/config.js';
import { FAMILIES, isSnapshotFamily, type Family } from '../../../../../api/src/modules/analytics/domain/families.js';
import { assertFamily, assertIsoDate } from '../../../../../api/src/modules/analytics/repository/refresh.repo.js';
import { refreshTenant } from '../../../../../api/src/modules/analytics/service/refresh.service.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { addDays, jobTenant, markAll } from './shared.js';

const SEED = `INSERT INTO analytics.order_index (tenant_id, order_id, centre_id, registered_at, registered_on, created_by, expires_at)
SELECT t.tenant_id, t.order_id, t.centre_id, t.registered_at, (t.registered_at AT TIME ZONE 'Asia/Kathmandu')::date, $4::uuid,
       t.registered_at + interval '400 days'
FROM reporting.v_pub_order_report_tat t
WHERE t.tenant_id = $1 AND t.registered_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kathmandu') AND t.registered_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kathmandu')
ON CONFLICT (tenant_id, order_id) DO NOTHING`;

export const backfillTask: TaskHandler = async (payload, ctx) => {
  const tenantId = jobTenant(payload, ctx, 'analytics.backfill');
  const p = payload as { from?: unknown; to?: unknown; family?: unknown };
  assertIsoDate(p.from, 'analytics.backfill: from'); assertIsoDate(p.to, 'analytics.backfill: to');
  if (p.from >= p.to) throw new RangeError('analytics.backfill: from must be before to');
  if (p.family !== undefined) assertFamily(p.family);
  const [from, to] = [p.from, p.to], family: Family | undefined = p.family;
  const cfg = loadAnalyticsConfig();

  for (let a = from; a < to;) {
    const b = addDays(a, cfg.sweepChunkDays) < to ? addDays(a, cfg.sweepChunkDays) : to;
    await ctx.tx.query(SEED, [tenantId, a, b, ctx.actor.id]);
    const days = Array.from({ length: (Date.parse(b) - Date.parse(a)) / 86_400_000 }, (_, i) => addDays(a, i));
    await markAll(ctx, tenantId, 'backfill', days, (family ? [family] : FAMILIES).filter((f) => !isSnapshotFamily(f) || b === to));
    await refreshTenant(ctx as never, { tenantId, trigger: 'backfill', chunkDays: cfg.sweepChunkDays, backlogLookbackDays: cfg.backlogLookbackDays });
    a = b;
  }
};
