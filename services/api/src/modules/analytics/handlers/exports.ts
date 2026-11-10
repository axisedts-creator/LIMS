// Handlers #20-#23 (02-TRD §5, §10.1, §10.3). Gate order (E1): assertRole(analytics.data.export) -> body shape -> registry (404) ->
// report permission (P-10) -> referral flag (E7) -> pdf feature -> params/period/scope -> quota -> write.
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { loadAnalyticsConfig } from '../config.js';
import { getReport } from '../domain/reportRegistry.js';
import { checkParams, createExport, downloadExport, getExport, listExports, parseCreateBody } from '../service/export.service.js';
import { authorise, periodAndScope, queryOf } from './reportRequest.js';

type Settings = { ports: { IdentityPort: { getTenantSettings(ctx: unknown, i: { keys: string[] }): Promise<Record<string, unknown>> } } };
const PERM = 'analytics.data.export' as const;

export const createAnalyticsExport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, PERM);
  const body = parseCreateBody(req.body);
  const report = getReport(body.report_code); // unknown -> 404 analytics.report_unknown
  await authorise(ctx, report.permission);
  if (report.flag) {
    const s = await (c as unknown as Settings).ports.IdentityPort.getTenantSettings(c, { keys: [report.flag] });
    if (s[report.flag] !== true) throw new LimsError('common.feature_disabled');
  }
  if (body.format === 'pdf' && !loadAnalyticsConfig().pdfEnabled) throw new LimsError('common.feature_disabled'); // RenderPort not registered
  checkParams(body.report_code, body.params);
  const { period, scope } = await periodAndScope(c, body.params);
  const dto = await createExport(c as never, { body, scope, from: period.from, to: period.to });
  return { status: 202, body: dto };
};

export const listAnalyticsExports: Handler = async (req, ctx) => ({ status: 200, body: await listExports(await authorise(ctx, PERM) as never, queryOf(req)) });

export const getAnalyticsExport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, PERM);
  return { status: 200, body: await getExport(c as never, (req.params as { export_id?: unknown } | undefined)?.export_id) };
};

export const downloadAnalyticsExport: Handler = async (req, ctx) => {
  const c = await authorise(ctx, PERM);
  return downloadExport(c as never, (req.params as { export_id?: unknown } | undefined)?.export_id);
};
