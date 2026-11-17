// GET /v1/analytics/reports/income (02-TRD §5 #2; PRD US-03.1/.4/.5/.6).
import type { Handler } from '../../../core/module.js';
import { toIncomeReportDto } from '../mappers/reports.dto.js';
import { INCOME_GROUP_BY, checkGroupBy, income } from '../service/reports.service.js';
import { authorise, periodAndScope, queryOf } from './reportRequest.js';

export const getIncomeReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const q = queryOf(req);
  const groupBy = checkGroupBy(INCOME_GROUP_BY, q.group_by, 'day'); // closed list before any lookup
  const { period, scope, generatedAt } = await periodAndScope(c, q);
  const out = await income(c, { period, scope, groupBy });
  return { status: 200, body: toIncomeReportDto({ period, scope, generatedAt }, out) };
};
