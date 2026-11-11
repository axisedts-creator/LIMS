// S1-S7 + R17 handlers (02-TRD §6.5). Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline from
// contracts/openapi/reporting.yaml; these map request -> service and fail closed without an authenticated request context.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { createSettingsService, type SettingsCtx, type SettingsDeps } from '../service/settings.service.js';

type Svc = ReturnType<typeof createSettingsService>;
/** [CONV] the full HandlerContext (tenantId/actor/tx/core) lands with T0D-02..10; until then a context without them is unauthenticated. */
function bind(fn: (svc: Svc, ctx: SettingsCtx, req: HandlerRequest) => Promise<{ status: number; body: unknown; version?: number }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<SettingsCtx> & { core?: SettingsDeps['core'] };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.core) throw new LimsError('auth.unauthenticated');
    const out = await fn(createSettingsService({ core: c.core }), c as SettingsCtx, req);
    return { status: out.status, body: out.body, ...(out.version === undefined ? {} : { headers: { etag: `"${out.version}"` } }) };
  };
}
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
/** If-Match: "<version>" (02-CV §4.2). Absent -> undefined (428); malformed -> 0 (400). */
function ifMatch(req: HandlerRequest): number | undefined {
  const h = obj(req.headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  return m ? Number(m[1]) : 0;
}

export const settingsHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  getReportingSettings: bind(async (s, ctx) => { const b = await s.getSettings(ctx); return { status: 200, body: b, version: b['version'] as number }; }),
  updateReportingSettings: bind(async (s, ctx, req) => {
    const b = await s.updateSettings(ctx, { expectedVersion: ifMatch(req), patch: req.body });
    return { status: 200, body: b, version: b['version'] as number };
  }),
  listCentreContacts: bind(async (s, ctx, req) => ({ status: 200, body: await s.listCentreContacts(ctx, { centreId: obj(req.query)['centre_id'] }) })),
  createCentreContact: bind(async (s, ctx, req) => { const b = await s.createCentreContact(ctx, req.body); return { status: 201, body: b, version: b.version }; }),
  updateCentreContact: bind(async (s, ctx, req) => {
    const b = await s.updateCentreContact(ctx, { centreContactId: obj(req.params)['centre_contact_id'], expectedVersion: ifMatch(req), patch: req.body });
    return { status: 200, body: b, version: b.version };
  }),
  replaceStaffAssignments: bind(async (s, ctx, req) => ({ status: 200, body: await s.replaceStaffAssignments(ctx, req.body) })),
  upsertReferrerPreference: bind(async (s, ctx, req) => {
    const body = obj(req.body);
    if (Object.keys(body).some((k) => k !== 'disabled_channels')) throw new LimsError('common.validation_failed');
    return { status: 200, body: await s.upsertReferrerPreference(ctx, { referrerId: obj(req.params)['referrer_id'], disabledChannels: body['disabled_channels'] }) };
  }),
  listReportingCodes: bind(async (s, ctx, req) => ({ status: 200, body: await s.listCodes(ctx, { setName: obj(req.params)['set_name'] }) })),
});
