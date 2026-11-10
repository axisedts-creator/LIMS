// `analytics.sweep_nightly` (02-TRD §9.3; cron 45 20 * * * UTC; max_attempts 3; statement timeout 120 s via taskOptions, CR-C8-012): mark every family dirty
// for [today - 40 d, today) (LIMS_ANALYTICS_NIGHTLY_DAYS), refresh inline, THEN enqueue analytics.self_check (never before the data is refreshed;
// a failing refresh or enqueue rejects so the whole nightly is retried - replacing partitions twice is idempotent).
import { loadAnalyticsConfig } from '../../../../../api/src/modules/analytics/config.js';
import { refreshTenant } from '../../../../../api/src/modules/analytics/service/refresh.service.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { addDays, jobTenant, localNow, markAll } from './shared.js';

export const sweepNightlyTask: TaskHandler = async (payload, ctx) => {
  const tenantId = jobTenant(payload, ctx, 'analytics.sweep_nightly');
  const cfg = loadAnalyticsConfig();
  const { today } = localNow(ctx);
  await markAll(ctx, tenantId, 'sweep_nightly', Array.from({ length: cfg.nightlyDays }, (_, i) => addDays(today, i - cfg.nightlyDays)));
  await refreshTenant(ctx as never, { tenantId, trigger: 'sweep_nightly', chunkDays: cfg.sweepChunkDays, backlogLookbackDays: cfg.backlogLookbackDays });
  await ctx.tx.query(`SELECT app.enqueue_job('analytics.self_check', $1::jsonb, $2, NULL, 2)`, [JSON.stringify({ tenant_id: tenantId }), `analytics.self_check:${tenantId}`]);
};
