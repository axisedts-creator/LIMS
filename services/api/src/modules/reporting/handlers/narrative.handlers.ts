// N1-N5 and N8-N10 handlers (02-TRD §6.4). Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from
// contracts/openapi/reporting.yaml; these map request -> service and fail closed without an authenticated request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createNarrativeService, type NarrativeCtx, type NarrativeService } from '../service/narrative.service.js';
import { ifMatch } from './outsourced.handlers.js';

const svc = createNarrativeService();
type Out = { status: number; body: unknown; version?: number };
function bind(fn: (s: NarrativeService, ctx: NarrativeCtx, req: HandlerRequest) => Promise<Out>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<NarrativeCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(svc, c as NarrativeCtx, req);
    return { status: out.status, body: out.body, ...(out.version === undefined ? {} : { headers: { etag: `"${out.version}"` } }) };
  };
}
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
const ver = (b: unknown) => obj(b)['version'] as number;

export const narrativeHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listNarrativeTemplates: bind(async (s, ctx, req) => {
    const q = obj(req.query);
    return { status: 200, body: await s.listTemplates(ctx, { kind: q['kind'], testId: q['test_id'], isActive: q['is_active'] }) };
  }),
  createNarrativeTemplate: bind(async (s, ctx, req) => {
    const out = await s.createTemplate(ctx, { body: req.body });
    return { status: 201, body: out, version: ver(out) };
  }),
  updateNarrativeTemplate: bind(async (s, ctx, req) => {
    const out = await s.updateTemplate(ctx, { templateId: obj(req.params)['narrative_template_id'], expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: out, version: ver(out) };
  }),
  listNarrativeReports: bind(async (s, ctx, req) => {
    const q = obj(req.query);
    return { status: 200, body: await s.list(ctx, { status: q['status'], templateKind: q['template_kind'], centreId: q['centre_id'], cursor: q['cursor'], limit: q['limit'] }) };
  }),
  getNarrativeReport: bind(async (s, ctx, req) => {
    const out = await s.get(ctx, { narrativeId: obj(req.params)['narrative_id'] });
    return { status: 200, body: out, version: ver(out) };
  }),
  saveNarrativeDraft: bind(async (s, ctx, req) => {
    const out = await s.save(ctx, { narrativeId: obj(req.params)['narrative_id'], expectedVersion: ifMatch(req), body: req.body });
    return { status: 200, body: out, version: ver(out) };
  }),
  signNarrativeReport: bind(async (s, ctx, req) => {
    const out = await s.sign(ctx, { narrativeId: obj(req.params)['narrative_id'], expectedVersion: ifMatch(req) });
    return { status: 200, body: out, version: ver(out) };
  }),
  startNarrativeAmendment: bind(async (s, ctx, req) => {
    const out = await s.amend(ctx, { narrativeId: obj(req.params)['narrative_id'], expectedVersion: ifMatch(req), body: req.body });
    return { status: 201, body: out, version: ver(out) };
  }),
});
