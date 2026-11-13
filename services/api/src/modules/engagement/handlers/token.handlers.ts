// Q3 issueQueueToken, Q4 listQueueTokens, Q5 callNextQueueToken, Q6 recall/startServing/complete/skip/cancel, Q7 transferQueueToken (02-TRD §5).
// Order: fail closed without request context -> IdentityPort.assertRole({permission}) (before any query; with centre_id when a list names one) -> service,
// which asserts the stored row's centre (authorizeRow). All nine need engagement.queue.operate; manage alone does not grant them.
// [CONV] business date = ctx.now() in the tenant timezone (IdentityPort.getTenantSettings keys ['timezone']); v1 tenants are Asia/Kathmandu only (05-SCHEMA P-15), also the fallback.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { isUuid, type QueueCtx } from '../service/queue.service.js';
import { createTokenService, type TokenOp, type TokenService } from '../service/token.service.js';

type Assert = (r: { permission: string; centreId?: string }) => Promise<void>;
type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<void>; getTenantSettings?(ctx: unknown, i: { keys: string[] }): Promise<{ timezone?: unknown }> } };
type Env = { ctx: QueueCtx; req: HandlerRequest; assertRole: Assert; now: string; tz: string; authorizeRow: (centreId: string) => Promise<void> };
const OPERATE = 'engagement.queue.operate';
const DEFAULT_TZ = 'Asia/Kathmandu';
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
const validTz = (z: unknown): z is string => { if (typeof z !== 'string') return false; try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } };

function bind(fn: (svc: TokenService, e: Env) => Promise<{ status: number; body?: unknown }>, floorCentre?: (req: HandlerRequest) => unknown): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<QueueCtx> & { ports?: Ports; now?: () => string };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const identity = c.ports?.IdentityPort;
    if (!identity) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    const assertRole: Assert = (r) => identity.assertRole(hctx, r);
    const fc = floorCentre?.(req);
    await assertRole({ permission: OPERATE, ...(isUuid(fc) ? { centreId: fc } : {}) }); // floor first: a refused actor causes no query and no tenant-settings call
    const tz = (await identity.getTenantSettings?.(hctx, { keys: ['timezone'] }))?.timezone;
    const out = await fn(createTokenService(), { ctx: c as QueueCtx, req, assertRole, now: c.now?.() ?? new Date().toISOString(), tz: validTz(tz) ? tz : DEFAULT_TZ,
      authorizeRow: (centreId) => assertRole({ permission: OPERATE, centreId }) });
    const v = obj(out.body)['version'];
    return { status: out.status, ...(out.body === undefined ? {} : { body: out.body }), ...(typeof v === 'number' ? { headers: { etag: `"${v}"` } } : {}) };
  };
}

const issue = bind((svc, e) => svc.issue(e.ctx, { body: e.req.body, now: e.now, tz: e.tz, authorizeRow: e.authorizeRow }));

/** A named centre is asserted (a foreign centre -> auth.forbidden, zero queries); a missing/malformed one is a 400 from the service. */
const list = bind((svc, e) => svc.list(e.ctx, { query: e.req.query, now: e.now, tz: e.tz }), (req) => obj(req.query)['centre_id']);

const callNext = bind((svc, e) => svc.callNext(e.ctx, { queueId: obj(e.req.params)['queue_id'], body: e.req.body, now: e.now, tz: e.tz, authorizeRow: e.authorizeRow }));

const transition = (op: TokenOp) => bind((svc, e) => svc.transition(e.ctx, op, { id: obj(e.req.params)['token_id'], headers: e.req.headers, body: e.req.body, now: e.now, tz: e.tz, authorizeRow: e.authorizeRow }));

const transfer = bind((svc, e) => svc.transfer(e.ctx, { id: obj(e.req.params)['token_id'], headers: e.req.headers, body: e.req.body, now: e.now, tz: e.tz, authorizeRow: e.authorizeRow }));

export const tokenHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  issueQueueToken: issue, listQueueTokens: list, callNextQueueToken: callNext,
  recallQueueToken: transition('recall'), startServingQueueToken: transition('serve'), completeQueueToken: transition('complete'),
  skipQueueToken: transition('skip'), cancelQueueToken: transition('cancel'), transferQueueToken: transfer,
});
