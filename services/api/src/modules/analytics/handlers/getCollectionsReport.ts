// GET /v1/analytics/reports/collections (02-TRD §5 #4; PRD US-08.1–.5; D-46) and the filter-option reads #16 / #30 (US-08.6; D-47).
import type { Handler } from '../../../core/module.js';
import { toCollectionsReportDto } from '../mappers/reports.dto.js';
import {
  COLLECTIONS_GROUP_BY, MAX_PAYMENT_METHOD_CODES, analyticsOptions, checkCodeList, checkGroupBy, collections, recipients, scopedOptions,
} from '../service/reports.service.js';
import { resolveScope } from '../service/context.service.js';
import { authorise, holds, periodAndScope, queryOf } from './reportRequest.js';

export const getCollectionsReport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.collections.read'); // CR-C8-001: not dashboard.read
  const q = queryOf(req);
  const groupBy = checkGroupBy(COLLECTIONS_GROUP_BY, q.group_by, 'method');
  const paymentMethodCodes = checkCodeList(q.payment_method_code, 'payment_method_code', MAX_PAYMENT_METHOD_CODES);
  const { period, scope, generatedAt } = await periodAndScope(c, q);
  const out = await collections(c, { period, scope, groupBy, paymentMethodCodes });
  const dailyCashRouteId = (await holds(c, 'billing.cash_report.read')) ? ('staff.billing.daily_cash' as const) : undefined;
  return { status: 200, body: toCollectionsReportDto({ period, scope, generatedAt }, { ...out, dailyCashRouteId }) };
};

export const getAnalyticsFilterOptions: Handler = async (_req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  const scope = await resolveScope(c, {});
  const body = await analyticsOptions(c, scope);
  // P-10 / D-47: `recipients` only for analytics.schedule.manage holders; everyone else gets 200 without the key.
  return { status: 200, body: (await holds(c, 'analytics.schedule.manage')) ? { ...body, recipients: await recipients(c) } : body };
};

export const getCollectionsFilterOptions: Handler = async (_req, ctx) => {
  const c = await authorise(ctx, 'analytics.collections.read'); // D-46: finance reaches collections history without dashboard.read
  return { status: 200, body: await scopedOptions(c, await resolveScope(c, {})) };
};
