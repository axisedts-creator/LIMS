// B32 getBillingSettings / updateBillingSettings, B34 listBillingCodes (02-TRD §6). Schema, auth, x-permission are enforced by the core
// pipeline from contracts/openapi/billing.yaml; these map request -> service and fail closed without an authenticated request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createSettingsService, type SettingsCtx, type SettingsService } from '../service/settings.service.js';

type Out = { status: number; body: unknown; version?: number };
function bind(fn: (svc: SettingsService, ctx: SettingsCtx, req: HandlerRequest) => Promise<Out>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<SettingsCtx>;
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const out = await fn(createSettingsService(), c as SettingsCtx, req);
    return { status: out.status, body: out.body, ...(out.version === undefined ? {} : { headers: { etag: `"${out.version}"` } }) };
  };
}
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
/** If-Match: "<version>" (02-CV §4.2). Absent -> undefined (428); malformed -> 0 (400). */
export function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  return m ? Number(m[1]) : 0;
}

export const settingsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  getBillingSettings: bind(async (s, ctx) => { const b = await s.getSettings(ctx); return { status: 200, body: b, version: b['version'] as number }; }),
  updateBillingSettings: bind(async (s, ctx, req) => {
    const b = await s.updateSettings(ctx, { expectedVersion: ifMatch(req), patch: req.body });
    return { status: 200, body: b, version: b['version'] as number };
  }),
  listBillingCodes: bind(async (s, ctx, req) => ({ status: 200, body: await s.listCodes(ctx, { setName: obj(req.params)['set_name'] }) })),
});
