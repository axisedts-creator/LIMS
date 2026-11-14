// C12.T-19 handlers #92 getInventoryReport / #93 exportInventoryReport (02-TRD §5.5). Order, always, with the transaction untouched until the last two steps:
//   1. IdentityPort.assertRole({ permission }) WITHOUT branchId: inventory.item.read (#92) / inventory.report.export (#93, privileged: the port answers auth.mfa_required below aal2, PE-1);
//   2. report_code (400); cost_per_test also asserts inventory.cost.read (the report is money-only, PE-3);
//   3. consumption_reconciliation needs centreScope.all (403: lab.v_pub_result_daily is centre-scoped for the caller, P-B6);
//   4. strict query (400) -> date range cap (422 inventory.range_too_large) -> service: store / branch visibility (404), the report, #93: row cap (422) + CSV + access log.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { PERMISSIONS } from '../permissions.js';
import * as svc from '../service/reports.service.js';
import { assertRange, parseReportCode, parseReportQuery } from './reports.schemas.js';

const gate = (ctx: HandlerContext, permission: string): Promise<void> => ctx.ports.IdentityPort.assertRole(ctx, { permission });

async function prepare(req: HandlerRequest, ctx: HandlerContext) {
  const code = parseReportCode(req.params);
  if (code === 'cost_per_test') await gate(ctx, PERMISSIONS.costRead);
  if (code === 'consumption_reconciliation') {
    const actor = await ctx.ports.IdentityPort.getActor(ctx);
    if (actor.centreScope?.all !== true) throw new LimsError('auth.forbidden');
  }
  const q = parseReportQuery(code, req.query);
  await assertRange(q);
  return { code, q };
}

export const reportHandlers: Readonly<Record<string, Handler>> = {
  getInventoryReport: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.itemRead);
    const { code, q } = await prepare(req, ctx);
    return { status: 200, body: await svc.getReport(ctx, code, q) };
  },
  exportInventoryReport: async (req, ctx) => {
    await gate(ctx, PERMISSIONS.reportExport);
    const { code, q } = await prepare(req, ctx);
    return svc.exportReport(ctx, code, q);
  },
};
