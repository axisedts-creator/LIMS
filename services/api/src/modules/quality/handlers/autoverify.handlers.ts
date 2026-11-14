// #36-#41, #44, #45 (auto-verify rule set and versions; 02-TRD §5.5). Schema, auth, x-permission, aal2 (auth.mfa_required on every quality.autoverify.manage
// operation, AC-12.3) and Idempotency-Key (#37) are enforced by the core pipeline from contracts/openapi/quality.yaml; these map request -> service, set ETag,
// and fail closed without a request context. Wire names are snake_case; If-Match is `"<version>"` (02-CV §4.2). The service re-asserts the permission (defence in depth).
// Tenant and actor come from the context only; nothing from path/query/header/body is ever read as tenant_id. Activation (#43), the report (#42) and decisions (#46, #47) are activation.handlers.ts (T-17).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createAutoverifyService, type AutoverifyCtx, type Result } from '../service/autoverify.service.js';

const av = createAutoverifyService();   // methods are looked up per call

const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {});
const authed = (c: Partial<AutoverifyCtx> | undefined): boolean => typeof c?.tenantId === 'string' && typeof c.actor?.id === 'string' && !!c.tx;

/** If-Match: "<version>". Absent -> undefined (the service answers 428); malformed -> 400 here. */
function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  const v = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(v) || v > 2147483647) {
    throw new LimsError('common.validation_failed', undefined, [{ path: '/If-Match', code: 'common.field_invalid', message: 'Field invalid' }]);
  }
  return v;
}

/** etag: single-version responses only (#36 is a summary and carries none). */
export const staff = (fn: (c: AutoverifyCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler =>
  (async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<AutoverifyCtx>;
    if (!authed(c)) throw new LimsError('auth.unauthenticated');
    const out = await fn(c as AutoverifyCtx, req);
    return { status: out.status, body: out.body, ...(o.etag && out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}) };
  }) as Handler;

const vid = (req: HandlerRequest) => obj(req.params)['version_id'];
const E = { etag: true } as const;
/** PUT / POST-transition: If-Match + path id + body. */
const guarded = (op: 'replaceAutoverifyDraft' | 'startAutoverifySimulation' | 'stopAutoverifySimulation' | 'retireAutoverifyVersion' | 'discardAutoverifyDraft'): Handler =>
  staff((c, req) => av[op](c, { versionId: vid(req), expectedVersion: ifMatch(req), body: req.body }), E);

export const autoverifyHandlers = Object.freeze({
  getAutoverifyRuleSet: staff((c) => av.getAutoverifyRuleSet(c, {})),
  createAutoverifyVersion: staff((c, req) => av.createAutoverifyVersion(c, { body: req.body }), E),
  getAutoverifyVersion: staff((c, req) => av.getAutoverifyVersion(c, { versionId: vid(req) }), E),
  replaceAutoverifyDraft: guarded('replaceAutoverifyDraft'),
  startAutoverifySimulation: guarded('startAutoverifySimulation'),
  stopAutoverifySimulation: guarded('stopAutoverifySimulation'),
  retireAutoverifyVersion: guarded('retireAutoverifyVersion'),
  discardAutoverifyDraft: guarded('discardAutoverifyDraft'),
} satisfies Record<string, Handler>);
