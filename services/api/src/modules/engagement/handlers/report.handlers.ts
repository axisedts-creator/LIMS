// E22 listMyReports, E23 downloadMyReport (02-TRD §5). Order: fail closed without request context -> IdentityPort.assertRole(<own permission>) before any query, port or rate-limit call -> service (patient actors only).
// Answers hold PHI: Cache-Control no-store (set by the service). E23's body is the PDF bytes.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createReportService, type ReportService, type ReportsCtx } from '../service/report.service.js';

type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string }): Promise<void> } };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(permission: string, run: (svc: ReportService, ctx: ReportsCtx, req: HandlerRequest) => ReturnType<ReportService['list']>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<ReportsCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || typeof c.now !== 'function') throw new LimsError('auth.unauthenticated');
    if (!c.ports?.IdentityPort) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    await c.ports.IdentityPort.assertRole(hctx, { permission });
    const out = await run(createReportService(), c as ReportsCtx, req);
    return { status: out.status, ...(out.body ? { body: out.body } : {}), headers: out.headers ?? {} } as HandlerResult;
  };
}

export const reportHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listMyReports: bind('reporting.portal.view', (svc, ctx, req) => svc.list(ctx, { query: req.query })),
  downloadMyReport: bind('reporting.portal.download', (svc, ctx, req) => svc.download(ctx, { reportId: obj(req.params)['report_id'], versionNo: obj(req.params)['version_no'] })),
  getMySmartSummary: bind('reporting.portal.view', (svc, ctx, req) => svc.smart(ctx, { reportId: obj(req.params)['report_id'], versionNo: obj(req.params)['version_no'] })), // T-P4: E24
});
