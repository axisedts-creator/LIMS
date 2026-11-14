// AN-T14: GET /v1/analytics/dashboard, GET /v1/analytics/freshness, POST /v1/analytics/refresh (02-TRD §5 #1/#18/#19; PRD US-01, US-16, US-19).
import type { Handler } from '../../../core/module.js';
import { toDashboardDto, toFreshnessDto } from '../mappers/reports.dto.js';
import { allFreshness, dashboard, refreshFamilies, requestRefresh } from '../service/dashboard.service.js';
import { authorise, holds, periodAndScope, queryOf } from './reportRequest.js';

export const getAnalyticsDashboard: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const q = queryOf(req);
  const { period, scope, generatedAt } = await periodAndScope(c, q);
  const withCollections = await holds(c, 'analytics.collections.read'); // X1: tile omitted (not 403) without it; the family is not even read
  const filtered = [q.centre_id, q.branch_id].some((v) => Array.isArray(v) && v.length > 0);
  const out = await dashboard(c as never, { period, scope, filtered, withCollections });
  return { status: 200, body: toDashboardDto({ period, scope, generatedAt }, out) };
};

export const getAnalyticsFreshness: Handler = async (_req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read'); // tenant-level: no scope concept
  return { status: 200, body: { data: (await allFreshness(c as never)).map(toFreshnessDto) } };
};

export const requestAnalyticsRefresh: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const families = refreshFamilies(req.body); // 400 before the throttle slot is touched
  return { status: 202, body: await requestRefresh(c as never, families) };
};
