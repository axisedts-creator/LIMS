// GET /v1/analytics/reports/tests-done (02-TRD §5 #9; PRD US-09.1–3, M40–M47; CR-C8-004).
import type { Handler } from '../../../core/module.js';
import { toTestsDoneReportDto } from '../mappers/reports.dto.js';
import { TESTS_DONE_GROUP_BY, checkGroupBy, testsDone } from '../service/reports.service.js';
import { authorise, periodAndScope, queryOf } from './reportRequest.js';

export const getTestsDoneReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const q = queryOf(req);
  const groupBy = checkGroupBy(TESTS_DONE_GROUP_BY, q.group_by, 'department'); // closed list before any lookup
  // The operation has no centre/branch filter: the scope is the caller's own.
  const { period, scope, generatedAt } = await periodAndScope(c, { ...q, centre_id: undefined, branch_id: undefined });
  const out = await testsDone(c, { period, scope, groupBy, departmentIds: q.department_id, processingBranchIds: q.processing_branch_id });
  return { status: 200, body: toTestsDoneReportDto({ period, scope, generatedAt }, out) };
};
