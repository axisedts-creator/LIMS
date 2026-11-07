// operationId -> handler map of module analytics (02-CV §2.2). Keys = every operationId of contracts/openapi/analytics.yaml;
// the core fails boot on a missing or extra key (AC-0D-1.2). AN-T01: 30 stubs; each later task replaces its own entries.
// Stub: LIMS_CORE_ENV=dev (and NODE_ENV != production) -> 501 with no body (never echoes request input); anything else -> common.internal (fail closed).
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';

const OPERATION_IDS = [
  'getAnalyticsDashboard', 'getIncomeReport', 'getDepartmentIncomeReport', 'getCollectionsReport', 'getVolumeReport',
  'getTopReferrersReport', 'getTopCentresReport', 'getReferralIncentiveReport', 'getTestsDoneReport', 'getTatReport',
  'getPendingTestsSummary', 'listPendingTests', 'getQualityIndicatorsReport', 'getDeliveryReport', 'getInterfacesReport',
  'getAnalyticsFilterOptions', 'searchAnalyticsReferrers', 'getAnalyticsFreshness', 'requestAnalyticsRefresh',
  'createAnalyticsExport', 'listAnalyticsExports', 'getAnalyticsExport', 'downloadAnalyticsExport', 'listReportSchedules',
  'createReportSchedule', 'getReportSchedule', 'updateReportSchedule', 'deactivateReportSchedule', 'getReportRun',
  'getCollectionsFilterOptions',
] as const;

export type AnalyticsOperationId = (typeof OPERATION_IDS)[number];

const stub = (operationId: string): Handler => async () => {
  if (process.env.LIMS_CORE_ENV === 'dev' && process.env.NODE_ENV !== 'production') return { status: 501 };
  throw new LimsError('common.internal', `analytics ${operationId} not implemented`);
};

const implemented: Partial<Record<AnalyticsOperationId, Handler>> = {};

export const handlers: Readonly<Record<AnalyticsOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? stub(op)])) as Record<AnalyticsOperationId, Handler>,
);
