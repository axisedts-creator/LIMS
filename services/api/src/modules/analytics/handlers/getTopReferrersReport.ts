// GET /v1/analytics/reports/top-referrers (02-TRD §5 #6; PRD US-05.1–.4; D-44 volume only) and POST /referrers/search (#17).
import type { Handler } from '../../../core/module.js';
import { toTopReferrersReportDto } from '../mappers/reports.dto.js';
import { MAX_REFERRER_IDS, TOP_REFERRERS_SORT, checkGroupBy, checkInt, checkUuidList, searchReferrers, topReferrers } from '../service/reports.service.js';
import { authorise, periodAndScope, queryOf } from './reportRequest.js';

export const getTopReferrersReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const q = queryOf(req);
  const sort = checkGroupBy(TOP_REFERRERS_SORT, q.sort, '-orders', 'sort');
  const rollup = checkGroupBy(['canonical', 'none'] as const, q.rollup, 'canonical', 'rollup');
  const limit = checkInt(q.limit, 'limit', 1, 100, 20);
  const referrerIds = checkUuidList(q.referrer_id, 'referrer_id', MAX_REFERRER_IDS);
  const { period, scope, generatedAt } = await periodAndScope(c, q);
  return { status: 200, body: toTopReferrersReportDto({ period, scope, generatedAt }, await topReferrers(c, { period, scope, sort, limit, rollup, referrerIds })) };
};

export const searchAnalyticsReferrers: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  return { status: 200, body: { data: await searchReferrers(c, body.query) } };
};
