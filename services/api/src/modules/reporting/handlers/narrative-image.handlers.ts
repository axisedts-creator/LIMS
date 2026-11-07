// N6/N7 handlers (02-TRD §6.4). Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from
// contracts/openapi/reporting.yaml; these map request -> service and fail closed without an authenticated request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { contentDisposition } from '../../../core/storage/download.js';
import { createNarrativeImageService } from '../service/narrative-image.service.js';
import type { OutsourcedCtx } from '../service/outsourced.service.js';

const svc = createNarrativeImageService();
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
function ctxOf(hctx: HandlerContext): OutsourcedCtx {
  const c = hctx as unknown as Partial<OutsourcedCtx>;
  if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  return c as OutsourcedCtx;
}

export const narrativeImageHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  uploadNarrativeImage: async (req: HandlerRequest, hctx: HandlerContext) => {
    const b = obj(req.body);
    return { status: 201, body: await svc.upload(ctxOf(hctx), { narrativeId: obj(req.params)['narrative_id'], file: b['file'], caption: b['caption'] }) };
  },
  // REQ-SEC-083 / P-2: attachment + nosniff + no-store + CSP sandbox; filename sanitised by the service and encoded per RFC 6266.
  getNarrativeImageContent: async (req: HandlerRequest, hctx: HandlerContext) => {
    const out = await svc.content(ctxOf(hctx), { imageId: obj(req.params)['image_id'] });
    return {
      status: 200, body: out.bytes, headers: {
        'content-type': out.contentType, 'content-disposition': contentDisposition('attachment', out.filename),
        'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': 'sandbox',
        'content-length': String(out.bytes.length),
      },
    };
  },
});
