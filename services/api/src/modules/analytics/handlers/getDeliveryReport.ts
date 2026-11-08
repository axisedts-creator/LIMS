// GET /v1/analytics/reports/delivery (02-TRD §5 #14; PRD US-13.1–3, M80, M85–M87; CR-C8-005).
import type { Handler } from '../../../core/module.js';
import { toDeliveryReportDto } from '../mappers/reports.dto.js';
import { DELIVERY_GROUP_BY, checkGroupBy, delivery } from '../service/reports.service.js';
import { authorise, periodAndScope, queryOf } from './reportRequest.js';

export const getDeliveryReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const q = queryOf(req);
  const groupBy = checkGroupBy(DELIVERY_GROUP_BY, q.group_by, 'channel');
  const { period, scope, generatedAt } = await periodAndScope(c, q);
  const out = await delivery(c, { period, scope, groupBy });
  return { status: 200, body: toDeliveryReportDto({ period, scope, generatedAt }, out) };
};
