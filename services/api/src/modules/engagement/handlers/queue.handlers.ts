// Q1a listQueues, Q1b listQueueDefinitions, Q1c createQueue/updateQueue, Q2a listCounters, Q2b listCounterDefinitions, Q2c createCounter/updateCounter (02-TRD §5).
// Order: fail closed without request context -> IdentityPort.assertRole({permission, centreId?}) (before any query) -> service.
// Floors: console lists engagement.queue.operate; setup lists and writes engagement.queue.manage. Centre = query centre_id / body centre_id / the stored row's centre.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createQueueService, isUuid, type QueueCtx, type QueueKind, type QueueService } from '../service/queue.service.js';

type Assert = (r: { permission: string; centreId?: string }) => Promise<void>;
type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<void> } };
const OPERATE = 'engagement.queue.operate';
const MANAGE = 'engagement.queue.manage';
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(fn: (svc: QueueService, ctx: QueueCtx, req: HandlerRequest, assertRole: Assert) => Promise<{ status: number; body: Record<string, any> }>): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<QueueCtx> & { ports?: Ports };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const identity = c.ports?.IdentityPort;
    if (!identity) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    const out = await fn(createQueueService(), c as QueueCtx, req, (r) => identity.assertRole(hctx, r));
    const v = out.body['version'];
    return { status: out.status, body: out.body, ...(typeof v === 'number' ? { headers: { etag: `"${v}"` } } : {}) };
  };
}

/** Lists: the centre is asserted when given (a foreign centre -> auth.forbidden, zero queries); a malformed one is a 400 after the permission floor. */
const list = (kind: QueueKind, permission: string, centreRequired: boolean) => bind(async (svc, ctx, req, assertRole) => {
  const q = obj(req.query);
  const centre = q['centre_id'];
  await assertRole({ permission, ...(isUuid(centre) ? { centreId: centre } : {}) });
  if (centre === undefined ? centreRequired : !isUuid(centre)) throw new LimsError('common.validation_failed', undefined, [{ path: '/centre_id', code: centre === undefined ? 'common.field_required' : 'common.field_invalid', message: centre === undefined ? 'Field required' : 'Field invalid' }]);
  return { status: 200, body: await svc.list(ctx, kind, { centreId: centre as string | undefined, isActive: q['is_active'] }) };
});

const create = (kind: QueueKind) => bind(async (svc, ctx, req, assertRole) => {
  const centre = obj(req.body)['centre_id'];
  await assertRole({ permission: MANAGE, ...(isUuid(centre) ? { centreId: centre } : {}) });
  return { status: 201, body: await svc.create(ctx, kind, { body: req.body }) };
});

const update = (kind: QueueKind, idParam: string) => bind(async (svc, ctx, req, assertRole) => {
  await assertRole({ permission: MANAGE });
  const body = await svc.update(ctx, kind, {
    id: obj(req.params)[idParam], headers: req.headers, body: req.body,
    authorizeRow: (centreId) => assertRole({ permission: MANAGE, centreId }),
  });
  return { status: 200, body };
});

export const queueHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listQueues: list('queue', OPERATE, true),
  listQueueDefinitions: list('queue', MANAGE, false),
  createQueue: create('queue'),
  updateQueue: update('queue', 'queue_id'),
  listCounters: list('counter', OPERATE, true),
  listCounterDefinitions: list('counter', MANAGE, false),
  createCounter: create('counter'),
  updateCounter: update('counter', 'counter_id'),
});
