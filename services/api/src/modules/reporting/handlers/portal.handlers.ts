// P1-P6 portal handlers (02-TRD §6.6). Schema, portalSession auth and x-permission are enforced by the core pipeline; the credential stage comes from the
// resolver's claims. These map request -> portal service and fail closed without an authenticated portal context. Errors never echo input.
// Rate keys: P2 `o:<challenge_id>` (otp_verify), P4 `l:<link_id>` (report_download); P1 / P5 budgets are counted in the service (see portal.service.ts).
import { LimsError } from '../../../core/errors.js';
import { contentDisposition } from '../../../core/storage/download.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createPortalService, type PortalCtx } from '../service/portal.service.js';

const svc = createPortalService({ env: process.env });
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
function ctxOf(hctx: HandlerContext): PortalCtx {
  const c = hctx as unknown as Partial<PortalCtx>;
  if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  return c as PortalCtx;
}

export const portalHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  createPortalOtpChallenge: async (_req: HandlerRequest, hctx: HandlerContext) => svc.createChallenge(ctxOf(hctx)),
  verifyPortalOtp: async (req: HandlerRequest, hctx: HandlerContext) =>
    svc.verifyChallenge(ctxOf(hctx), { challengeId: obj(req.params)['challenge_id'], code: obj(req.body)['code'] }),
  getPortalReport: async (_req: HandlerRequest, hctx: HandlerContext) => svc.getReport(ctxOf(hctx)),
  getPortalDues: async (_req: HandlerRequest, hctx: HandlerContext) => svc.getDues(ctxOf(hctx)),   // P7 (08 A21.1)
  // REQ-SEC-083 / P-2: attachment + nosniff + no-store; the filename is generated, never taken from stored data.
  downloadPortalReportPdf: async (req: HandlerRequest, hctx: HandlerContext) => {
    const out = await svc.download(ctxOf(hctx), { reportVersionId: obj(req.params)['report_version_id'] });
    return {
      status: 200, body: out.bytes, headers: {
        'content-type': 'application/pdf', 'content-disposition': contentDisposition('attachment', out.filename),
        'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-length': String(out.bytes.length),
      },
    };
  },
  requestPortalLinkReissue: async (_req: HandlerRequest, hctx: HandlerContext) => svc.requestReissue(ctxOf(hctx)),
  endPortalSession: async (_req: HandlerRequest, hctx: HandlerContext) => svc.endSession(ctxOf(hctx)),
  // PP1 / PP2 (08 A11.1): the body is {gateway} only; the amount is never read from the request.
  createPortalPaymentRequest: async (req: HandlerRequest, hctx: HandlerContext) => svc.createPaymentRequest(ctxOf(hctx), { body: req.body }),
  getPortalPaymentRequest: async (req: HandlerRequest, hctx: HandlerContext) => svc.getPaymentRequest(ctxOf(hctx), { id: obj(req.params)['portal_payment_request_id'] }),
});
