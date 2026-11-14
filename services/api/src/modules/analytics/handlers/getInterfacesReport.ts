// GET /v1/analytics/reports/interfaces (02-TRD §5 #15; PRD US-14.1–2, M90–M91).
import type { Handler } from '../../../core/module.js';
import { toInterfacesReportDto } from '../mappers/reports.dto.js';
import { interfaces } from '../service/reports.service.js';
import { authorise, periodAndScope, queryOf } from './reportRequest.js';

export const getInterfacesReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const { period, scope, generatedAt } = await periodAndScope(c, queryOf(req));
  const out = await interfaces(c, { period, scope });
  return { status: 200, body: toInterfacesReportDto({ period, scope, generatedAt }, out) };
};
