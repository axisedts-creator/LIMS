// `analytics.sweep_recent` (02-TRD §9.3; cron */10; max_attempts 3): mark every family @ local today (@ yesterday too while local time < 06:00) and the
// backlog snapshot, then run the refresh inline. Any older dirty mark of the tenant is processed by the same refresh. A failing family rejects (Graphile retries).
import { loadAnalyticsConfig } from '../../../../../api/src/modules/analytics/config.js';
import { refreshTenant } from '../../../../../api/src/modules/analytics/service/refresh.service.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { addDays, jobTenant, localNow, markAll } from './shared.js';

export const sweepRecentTask: TaskHandler = async (payload, ctx) => {
  const tenantId = jobTenant(payload, ctx, 'analytics.sweep_recent');
  const cfg = loadAnalyticsConfig();
  const { today, minutes } = localNow(ctx);
  const [h, m] = cfg.yesterdayUntilLocal.split(':').map(Number) as [number, number];
  await markAll(ctx, tenantId, 'sweep_recent', minutes < h * 60 + m ? [addDays(today, -1), today] : [today]);
  await refreshTenant(ctx as never, { tenantId, trigger: 'sweep_recent', chunkDays: cfg.sweepChunkDays, backlogLookbackDays: cfg.backlogLookbackDays });
};
