// Q1 verifyReportQr (public) and R14 / R15 / R16 handlers (02-TRD §6.3). Schema, x-permission and Idempotency-Key are enforced by the core pipeline; these fail closed
// without a request context and never echo input. Q1 has no tenant / actor: its ctx is { clientIp, tx (anonymous), rateLimit } (service/verify.service.ts).
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createVerifyService, type PublicCtx, type StaffCtx } from '../service/verify.service.js';

const svc = createVerifyService();
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
const staff = (c: HandlerContext) => c as unknown as StaffCtx;

export const verifyHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  verifyReportQr: async (req: HandlerRequest, hctx: HandlerContext) =>
    ({ status: 200, body: await svc.verifyQr(hctx as unknown as PublicCtx, obj(req.body)['qr_token']) }),
  revokeReportQrToken: async (req: HandlerRequest, hctx: HandlerContext) =>
    svc.revokeQrToken(staff(hctx), { versionId: obj(req.params)['report_version_id'], body: req.body }),
  listPortalLinks: async (req: HandlerRequest, hctx: HandlerContext) =>
    svc.listLinks(staff(hctx), { reportId: obj(req.params)['report_id'] }),
  revokePortalLink: async (req: HandlerRequest, hctx: HandlerContext) =>
    svc.revokeLink(staff(hctx), { linkId: obj(req.params)['link_id'], body: req.body }),
});
