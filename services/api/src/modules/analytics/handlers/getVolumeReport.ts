// GET /v1/analytics/reports/volume (02-TRD §5 #5; PRD US-06.1, M01–M08) and /top-centres (#7; US-06.1/.2, M35–M38).
import type { Handler } from '../../../core/module.js';
import { toTopCentresReportDto, toVolumeReportDto } from '../mappers/reports.dto.js';
import { TOP_CENTRES_SORT, VOLUME_GROUP_BY, checkGroupBy, checkInt, topCentres, volume } from '../service/reports.service.js';
import { authorise, periodAndScope, queryOf } from './reportRequest.js';

export const getVolumeReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const q = queryOf(req);
  const groupBy = checkGroupBy(VOLUME_GROUP_BY, q.group_by, 'day');
  const { period, scope, generatedAt } = await periodAndScope(c, q);
  return { status: 200, body: toVolumeReportDto({ period, scope, generatedAt }, await volume(c, { period, scope, groupBy })) };
};

export const getTopCentresReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const q = queryOf(req);
  const sort = checkGroupBy(TOP_CENTRES_SORT, q.sort, '-orders', 'sort'); // [CONV] default -orders (first enum value)
  const limit = checkInt(q.limit, 'limit', 1, 50, 20);
  const { period, scope, generatedAt } = await periodAndScope(c, q);
  return { status: 200, body: toTopCentresReportDto({ period, scope, generatedAt }, await topCentres(c, { period, scope, sort, limit })) };
};
