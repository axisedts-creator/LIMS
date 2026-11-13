// C12 T-06 handlers #26-#29 (getInventorySettings, updateInventorySettings, listInventoryCodedSet, putInventoryTenantCode).
// Permission (x-permission), schema check and rate limit are the pipeline's (contracts/openapi/inventory.yaml); these map request -> service and set ETag. If-Match is `"<version>"` (02-CV §4.2).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { getSettings, listCodedSet, putSettings, putTenantCode, type Result, type SvcCtx } from '../service/settings.service.js';

const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** Absent -> undefined (the service answers 428 or creates); malformed -> 400 at /If-Match. */
function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  const v = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(v) || v > 2147483647) throw new LimsError('common.validation_failed', undefined, [{ path: '/If-Match', code: 'common.field_invalid', message: 'Field invalid' }]);
  return v;
}

const wrap = (fn: (c: SvcCtx, req: HandlerRequest) => Promise<Result>): Handler => async (req: HandlerRequest, hctx: HandlerContext) => {
  // the pipeline always supplies tenant/actor/tx on a tenant-context operation: a missing one is a wiring bug, fail closed as 500 (keeps boot.test.ts's "no request context -> common.internal")
  if (typeof hctx.tenantId !== 'string' || typeof hctx.actor?.id !== 'string' || !hctx.tx) throw new LimsError('common.internal');
  const out = await fn(hctx as unknown as SvcCtx, req);
  return { status: out.status, body: out.body, ...(out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}) };
};

export const settingsHandlers: Readonly<Record<string, Handler>> = {
  getInventorySettings: wrap((c) => getSettings(c)),
  updateInventorySettings: wrap((c, req) => putSettings(c, { expectedVersion: ifMatch(req), body: req.body })),
  listInventoryCodedSet: wrap((c, req) => listCodedSet(c, { setName: obj(req.params)['set_name'], reasonGroup: obj(req.query)['reason_group'] })),
  putInventoryTenantCode: wrap((c, req) => putTenantCode(c, { setName: obj(req.params)['set_name'], code: obj(req.params)['code'], expectedVersion: ifMatch(req), body: req.body })),
};
