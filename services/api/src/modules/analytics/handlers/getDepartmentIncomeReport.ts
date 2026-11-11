// GET /v1/analytics/reports/department-income (02-TRD §5 #3; PRD US-04.1–3, US-03.3 R2).
import type { Handler } from '../../../core/module.js';
import { toDepartmentIncomeReportDto } from '../mappers/reports.dto.js';
import { DEPARTMENT_GROUP_BY, checkGroupBy, departmentIncome } from '../service/reports.service.js';
import { authorise, periodAndScope, queryOf } from './reportRequest.js';

export const getDepartmentIncomeReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const q = queryOf(req);
  const groupBy = checkGroupBy(DEPARTMENT_GROUP_BY, q.group_by, 'department');
  const { period, scope, generatedAt } = await periodAndScope(c, q);
  const out = await departmentIncome(c, { period, scope, groupBy, departmentIds: q.department_id });
  return { status: 200, body: toDepartmentIncomeReportDto({ period, scope, generatedAt }, out) };
};
