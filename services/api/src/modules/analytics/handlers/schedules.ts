// Handlers #24–#29 (02-TRD §5; PRD US-18.1/18.3/18.4/18.6; 07-SECURITY S1, S3, P1, P2, P10, P11). Gate order (REQ-SEC-062): assertRole FIRST (#24–#28
// analytics.schedule.manage, #29 analytics.dashboard.read) -> If-Match -> body shape -> report registry (404 / 400) -> the caller's own report permissions (abuse case 3)
// -> the service (scope, recipients, cap, write).
import type { Handler, HandlerRequest } from '../../../core/module.js';
import {
  createSchedule, deactivateSchedule, getReportRun as getRun, getSchedule, listSchedules, parseIfMatch, parseScheduleBody, scheduleIdOf, schedulePermissions, updateSchedule,
} from '../service/schedule.service.js';
import type { AnalyticsPermission } from '../permissions.js';
import { authorise, queryOf } from './reportRequest.js';

const MANAGE = 'analytics.schedule.manage' as const;
const param = (req: HandlerRequest, key: string): unknown => (req.params as Record<string, unknown> | undefined)?.[key];
const etag = (version: number) => ({ etag: `"${version}"` });

/** The creator / editor must hold every report's own permission (a schedule never widens what its author may read). */
async function authoriseReports(c: Awaited<ReturnType<typeof authorise>>, codes: readonly string[]): Promise<void> {
  for (const permission of schedulePermissions(codes)) await authorise(c as never, permission as AnalyticsPermission);
}

export const listReportSchedules: Handler = async (req, ctx) => ({ status: 200, body: await listSchedules(await authorise(ctx, MANAGE) as never, queryOf(req)) });

export const createReportSchedule: Handler = async (req, ctx) => {
  const c = await authorise(ctx, MANAGE);
  const input = parseScheduleBody(req.body);
  await authoriseReports(c, input.reportCodes);
  const { row, dto } = await createSchedule(c as never, input);
  return { status: 201, headers: etag(row.version), body: dto };
};

export const getReportSchedule: Handler = async (req, ctx) => {
  const c = await authorise(ctx, MANAGE);
  const { row, dto } = await getSchedule(c as never, scheduleIdOf(param(req, 'schedule_id')));
  return { status: 200, headers: etag(row.version), body: dto };
};

export const updateReportSchedule: Handler = async (req, ctx) => {
  const c = await authorise(ctx, MANAGE);
  const expectedVersion = parseIfMatch(req.headers);
  const input = parseScheduleBody(req.body);
  await authoriseReports(c, input.reportCodes);
  const { row, dto } = await updateSchedule(c as never, { id: scheduleIdOf(param(req, 'schedule_id')), expectedVersion, input });
  return { status: 200, headers: etag(row.version), body: dto };
};

export const deactivateReportSchedule: Handler = async (req, ctx) => {
  const c = await authorise(ctx, MANAGE);
  const expectedVersion = parseIfMatch(req.headers);
  const { row, dto } = await deactivateSchedule(c as never, { id: scheduleIdOf(param(req, 'schedule_id')), expectedVersion });
  return { status: 200, headers: etag(row.version), body: dto };
};

export const getReportRun: Handler = async (req, ctx) => {
  const c = await authorise(ctx, 'analytics.dashboard.read');
  return { status: 200, body: await getRun(c as never, param(req, 'report_run_id')) };
};
