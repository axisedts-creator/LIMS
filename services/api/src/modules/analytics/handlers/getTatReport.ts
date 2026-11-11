// GET /v1/analytics/reports/tat (02-TRD §5 #10, §6.6; PRD US-11.1–6, M60–M64).
import type { Handler } from '../../../core/module.js';
import { toTatReportDto } from '../mappers/reports.dto.js';
import { TAT_GROUP_BY, checkGroupBy, tat, tatFilters } from '../service/reports.service.js';
import { authorise, periodAndScope, queryOf } from './reportRequest.js';

export const getTatReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const q = queryOf(req);
  const groupBy = checkGroupBy(TAT_GROUP_BY, q.group_by, 'none'); // closed lists before any lookup
  const filters = tatFilters(q);
  const { period, scope, generatedAt } = await periodAndScope(c, q);
  const out = await tat(c, { period, scope, groupBy, filters });
  return { status: 200, body: toTatReportDto({ period, scope, generatedAt }, out) };
};
