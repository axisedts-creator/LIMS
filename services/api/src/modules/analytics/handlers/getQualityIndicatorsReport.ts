// GET /v1/analytics/reports/quality-indicators (02-TRD §5 #13; PRD US-12.1–3, M70–M78; CR-C8-004).
import type { Handler } from '../../../core/module.js';
import { toQualityIndicatorsReportDto } from '../mappers/reports.dto.js';
import { QUALITY_GROUP_BY, checkGroupBy, qualityIndicators } from '../service/reports.service.js';
import { authorise, periodAndScope, queryOf } from './reportRequest.js';

export const getQualityIndicatorsReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const q = queryOf(req);
  const groupBy = checkGroupBy(QUALITY_GROUP_BY, q.group_by, 'reason');
  const { period, scope, generatedAt } = await periodAndScope(c, q);
  const out = await qualityIndicators(c, { period, scope, groupBy });
  return { status: 200, body: toQualityIndicatorsReportDto({ period, scope, generatedAt }, out) };
};
