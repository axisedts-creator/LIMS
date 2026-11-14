// E05 submitHostQuery and E22-E32 / E40-E41 handlers (02-TRD §7.2/§7.3). Schema, auth, x-permission (+aal2 for privileged) and Idempotency-Key are enforced by the
// core pipeline from contracts/openapi/instruments.yaml; these map request -> service, set ETag, and fail closed without a request context.
// Names are snake_case on the wire (path `instrument_id`, query, body); If-Match is `"<version>"` (02-CV §4.2).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { DeviceCtx, DeviceResult } from '../service/enrolment.service.js';
import type { AgentsCtx, Result } from '../service/agents.service.js';
import { createHostQueryService, type HostQueryCtx } from '../service/hostQuery.service.js';
import { createInstrumentsService } from '../service/instruments.service.js';
import { createObservedCodesService } from '../service/observedCodes.service.js';
import { createSettingsService } from '../service/settings.service.js';

const instruments = createInstrumentsService();
const observed = createObservedCodesService();
const settings = createSettingsService();
const hostQuery = createHostQueryService();

const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {});
const authed = (c: Partial<DeviceCtx> | undefined): boolean => typeof c?.tenantId === 'string' && typeof c.actor?.id === 'string' && !!c.tx;

/** If-Match: "<version>". Absent -> undefined (service answers 428); malformed -> 400 here. */
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

/** etag: single-object responses only (lists carry no version). */
function staff(fn: (ctx: AgentsCtx, req: HandlerRequest) => Promise<Result>, o: { etag?: boolean } = {}): Handler {
  return (async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<AgentsCtx>;
    if (!authed(c)) throw new LimsError('auth.unauthenticated');
    const out = await fn(c as AgentsCtx, req);
    return { status: out.status, body: out.body, ...(o.etag && out.version !== undefined ? { headers: { etag: `"${out.version}"` } } : {}) };
  }) as Handler;
}
const insId = (req: HandlerRequest) => obj(req.params)['instrument_id'];
const transition = (fn: (c: AgentsCtx, i: { instrumentId: unknown; expectedVersion: number | undefined; body: unknown }) => Promise<Result>) =>
  staff((c, req) => fn(c, { instrumentId: insId(req), expectedVersion: ifMatch(req), body: req.body }), { etag: true });

export const instrumentsHandlers = Object.freeze({
  // E05 (deviceToken)
  submitHostQuery: (async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<HostQueryCtx>;
    if (!authed(c)) throw new LimsError('auth.unauthenticated');
    const out: DeviceResult = await hostQuery.submitHostQuery(c as HostQueryCtx, { body: req.body });
    return { status: out.status, body: out.body, ...(out.headers && Object.keys(out.headers).length ? { headers: out.headers } : {}) };
  }) as Handler,

  listDrivers: staff((c, req) => { const q = obj(req.query); return instruments.listDrivers(c, { protocol: q['protocol'], status: q['status'] }); }),
  listInstruments: staff((c, req) => {
    const q = obj(req.query);
    return instruments.listInstruments(c, { centreId: q['centre_id'], agentId: q['agent_id'], state: q['state'], protocol: q['protocol'], sort: q['sort'], cursor: q['cursor'], limit: q['limit'] });
  }),
  createInstrument: staff((c, req) => instruments.createInstrument(c, { body: req.body }), { etag: true }),
  getInstrument: staff((c, req) => instruments.getInstrument(c, { instrumentId: insId(req) }), { etag: true }),
  updateInstrument: staff((c, req) => instruments.updateInstrument(c, { instrumentId: insId(req), expectedVersion: ifMatch(req), patch: req.body }), { etag: true }),
  startInstrumentCommissioning: transition((c, i) => instruments.startInstrumentCommissioning(c, i)),
  goLiveInstrument: transition((c, i) => instruments.goLiveInstrument(c, i)),
  suspendInstrument: transition((c, i) => instruments.suspendInstrument(c, i)),
  resumeInstrument: transition((c, i) => instruments.resumeInstrument(c, i)),
  retireInstrument: transition((c, i) => instruments.retireInstrument(c, i)),
  listObservedInstrumentCodes: staff((c, req) => {
    const q = obj(req.query);
    return observed.listObservedInstrumentCodes(c, { instrumentId: insId(req), recordClass: q['record_class'], mappingStatus: q['mapping_status'], cursor: q['cursor'], limit: q['limit'] });
  }),
  getInstrumentSettings: staff((c) => settings.getInstrumentSettings(c), { etag: true }),
  updateInstrumentSettings: staff((c, req) => settings.updateInstrumentSettings(c, { expectedVersion: ifMatch(req), body: req.body }), { etag: true }),
} satisfies Record<string, Handler>);
