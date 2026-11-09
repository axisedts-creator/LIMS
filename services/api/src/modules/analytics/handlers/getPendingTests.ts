// GET /v1/analytics/reports/pending-tests/summary and /items (02-TRD §5 #11/#12, §6.7; PRD US-10.1–10.5; 08 D-13, D-49).
import type { Handler } from '../../../core/module.js';
import { toPendingItemsDto, toPendingSummaryDto } from '../mappers/reports.dto.js';
import { resolveScope } from '../service/context.service.js';
import { itemsQuery, pendingFilters, pendingItems, pendingSummary } from '../service/pending.service.js';
import { authorise, holds, queryOf } from './reportRequest.js';

export const getPendingTestsSummary: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read'); // nothing is touched before this
  const q = queryOf(req);
  const filters = pendingFilters(q); // closed lists + limits before any lookup
  const scope = await resolveScope(c, { centreIds: filters.centreIds, branchIds: filters.branchIds });
  const out = await pendingSummary(c, { scope, filters });
  return { status: 200, body: toPendingSummaryDto({ scope, generatedAt: c.now() }, out) };
};

export const listPendingTests: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const q = queryOf(req);
  const filters = pendingFilters(q);
  const query = itemsQuery(q); // sort / status / limit / cursor: 400 before any lookup
  const scope = await resolveScope(c, { centreIds: filters.centreIds, branchIds: filters.branchIds });
  const out = await pendingItems(c, { scope, filters, query });
  const openRouteId = (await holds(c, 'lab.result.read')) ? ('staff.lab.order_results' as const) : undefined; // P-10: key absent otherwise
  return { status: 200, body: toPendingItemsDto({ rows: out.rows, limit: query.limit, nextCursor: out.nextCursor, openRouteId }) };
};
