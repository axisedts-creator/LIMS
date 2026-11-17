// #1-#13 (control materials, levels, lots, control-ID maps; 02-TRD §5.1). Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from
// contracts/openapi/quality.yaml; these map request -> service, set ETag, and fail closed without a request context. Wire names are snake_case; If-Match is `"<version>"` (02-CV §4.2).
// Tenant and actor come from the context only; nothing from path/query/header/body is ever read as tenant_id.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createSetupService, type Result, type SetupCtx } from '../service/setup.service.js';

const setup = createSetupService();   // methods are looked up per call

export const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {});
const authed = (c: Partial<SetupCtx> | undefined): boolean => typeof c?.tenantId === 'string' && typeof c.actor?.id === 'string' && !!c.tx;

/** If-Match: "<version>". Absent -> undefined (the service answers 428); malformed -> 400 here. */
export function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  const v = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(v) || v > 2147483647) {
    throw new LimsError('common.validation_failed', undefined, [{ path: '/If-Match', code: 'common.field_invalid', message: 'Field invalid' }]);
  }
  return v;
}

/** etag: single-object responses only (lists carry no version). */
export const staff = (fn: (c: SetupCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler =>
  (async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<SetupCtx>;
    if (!authed(c)) throw new LimsError('auth.unauthenticated');
    const out = await fn(c as SetupCtx, req);
    return { status: out.status, body: out.body, ...(o.etag && out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}) };
  }) as Handler;

const p = (req: HandlerRequest, k: string) => obj(req.params)[k];
const E = { etag: true } as const;

export const setupHandlers = Object.freeze({
  listControlMaterials: staff((c, req) => { const q = obj(req.query); return setup.listControlMaterials(c, { isActive: q['is_active'], q: q['q'], sort: q['sort'], cursor: q['cursor'], limit: q['limit'] }); }),
  createControlMaterial: staff((c, req) => setup.createControlMaterial(c, { body: req.body }), E),
  getControlMaterial: staff((c, req) => setup.getControlMaterial(c, { materialId: p(req, 'material_id') }), E),
  updateControlMaterial: staff((c, req) => setup.updateControlMaterial(c, { materialId: p(req, 'material_id'), expectedVersion: ifMatch(req), patch: req.body }), E),
  deactivateControlMaterial: staff((c, req) => setup.deactivateControlMaterial(c, { materialId: p(req, 'material_id'), expectedVersion: ifMatch(req) }), E),
  createControlLevel: staff((c, req) => setup.createControlLevel(c, { materialId: p(req, 'material_id'), body: req.body }), E),
  updateControlLevel: staff((c, req) => setup.updateControlLevel(c, { levelId: p(req, 'level_id'), expectedVersion: ifMatch(req), patch: req.body }), E),
  createControlLot: staff((c, req) => setup.createControlLot(c, { levelId: p(req, 'level_id'), body: req.body }), E),
  listControlLots: staff((c, req) => {
    const q = obj(req.query);
    return setup.listControlLots(c, { materialId: q['material_id'], levelId: q['level_id'], isActive: q['is_active'], expiresOnTo: q['expires_on_to'], sort: q['sort'], cursor: q['cursor'], limit: q['limit'] });
  }),
  updateControlLot: staff((c, req) => setup.updateControlLot(c, { lotId: p(req, 'lot_id'), expectedVersion: ifMatch(req), patch: req.body }), E),
  listControlIdMaps: staff((c, req) => { const q = obj(req.query); return setup.listControlIdMaps(c, { instrumentId: q['instrument_id'], lotId: q['lot_id'], isActive: q['is_active'], cursor: q['cursor'], limit: q['limit'] }); }),
  createControlIdMap: staff((c, req) => setup.createControlIdMap(c, { body: req.body }), E),
  deactivateControlIdMap: staff((c, req) => setup.deactivateControlIdMap(c, { mapId: p(req, 'map_id'), expectedVersion: ifMatch(req) }), E),
} satisfies Record<string, Handler>);
