// operationId -> handler map of module analytics (02-CV §2.2). Keys = every operationId of contracts/openapi/analytics.yaml;
// the core fails boot on a missing or extra key (AC-0D-1.2). AN-T01: 30 stubs; each later task replaces its own entries.
// Stub: LIMS_CORE_ENV=dev (and NODE_ENV != production) -> 501 with no body (never echoes request input); anything else -> common.internal (fail closed).
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { getIncomeReport } from './getIncomeReport.js';
import { getDepartmentIncomeReport } from './getDepartmentIncomeReport.js';
import { getTopCentresReport, getVolumeReport } from './getVolumeReport.js';
import { getTopReferrersReport, searchAnalyticsReferrers } from './getTopReferrersReport.js';
import { getAnalyticsFilterOptions, getCollectionsFilterOptions, getCollectionsReport } from './getCollectionsReport.js';
import { getTestsDoneReport } from './getTestsDoneReport.js';
import { getQualityIndicatorsReport } from './getQualityIndicatorsReport.js';
import { getDeliveryReport } from './getDeliveryReport.js';
import { getInterfacesReport } from './getInterfacesReport.js';
import { getReferralIncentiveReport } from './getReferralIncentiveReport.js';
import { getTatReport } from './getTatReport.js';
import { getAnalyticsDashboard, getAnalyticsFreshness, requestAnalyticsRefresh } from './getAnalyticsDashboard.js';
import { getPendingTestsSummary, listPendingTests } from './getPendingTests.js';
import { createAnalyticsExport, downloadAnalyticsExport, getAnalyticsExport, listAnalyticsExports } from './exports.js';
import {
  createReportSchedule, deactivateReportSchedule, getReportRun, getReportSchedule, listReportSchedules, updateReportSchedule,
} from './schedules.js';

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

const implemented: Partial<Record<AnalyticsOperationId, Handler>> = {
  getIncomeReport, getDepartmentIncomeReport, getVolumeReport, getTopCentresReport, getTopReferrersReport, searchAnalyticsReferrers,
  getCollectionsReport, getAnalyticsFilterOptions, getCollectionsFilterOptions,
  getTestsDoneReport, getQualityIndicatorsReport, getDeliveryReport, getInterfacesReport, getReferralIncentiveReport,
  getTatReport, getAnalyticsDashboard, getAnalyticsFreshness, requestAnalyticsRefresh,
  getPendingTestsSummary, listPendingTests,
  createAnalyticsExport, listAnalyticsExports, getAnalyticsExport, downloadAnalyticsExport,
  listReportSchedules, createReportSchedule, getReportSchedule, updateReportSchedule, deactivateReportSchedule, getReportRun,
};

export const handlers: Readonly<Record<AnalyticsOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? stub(op)])) as Record<AnalyticsOperationId, Handler>,
);
