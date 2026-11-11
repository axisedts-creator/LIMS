// T1-T4 and T6 handlers (02-TRD §6.4). Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from
// contracts/openapi/reporting.yaml; these map request -> service and fail closed without an authenticated request context. T5 stays a stub (C6-T16).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createTemplatesService, type TemplatesCtx, type TemplatesService } from '../service/templates.service.js';
import { ifMatch } from './outsourced.handlers.js';

const svc = createTemplatesService();
type Out = { status: number; body: unknown; version?: number };
function bind(fn: (s: TemplatesService, ctx: TemplatesCtx, req: HandlerRequest) => Promise<Out>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<TemplatesCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as TemplatesCtx, req);
    return { status: out.status, body: out.body, ...(out.version === undefined ? {} : { headers: { etag: `"${out.version}"` } }) };
  };
}
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
const ver = (b: unknown) => obj(b)['version'] as number;

export const templatesHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listReportTemplates: bind(async (s, ctx, req) => ({ status: 200, body: await s.listTemplates(ctx, { family: obj(req.query)['family'] }) })),
  createReportTemplate: bind(async (s, ctx, req) => {
    const out = await s.createTemplate(ctx, { body: req.body });
    return { status: 201, body: out, version: ver(out) };
  }),
  getReportTemplate: bind(async (s, ctx, req) => {
    const out = await s.getTemplate(ctx, { templateId: obj(req.params)['template_id'] });
    return { status: 200, body: out, version: ver(out) };
  }),
  updateReportTemplateDraft: bind(async (s, ctx, req) => {
    const out = await s.saveDraft(ctx, { templateId: obj(req.params)['template_id'], expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: out, version: ver(out) };
  }),
  publishReportTemplate: bind(async (s, ctx, req) => {
    const out = await s.publish(ctx, { templateId: obj(req.params)['template_id'], expectedVersion: ifMatch(req) });
    return { status: 200, body: out, version: ver(out) };
  }),
});
