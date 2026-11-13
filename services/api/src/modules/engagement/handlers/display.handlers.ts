// Q8 listQueueDisplays / pairQueueDisplay / revokeQueueDisplay (staff, engagement.queue.manage) and Q9 getQueueBoard (display device, engagement.queue.board_read) (02-TRD §5, §7 device).
// Order: fail closed without request context -> actor kind (Q9: device only) -> IdentityPort.assertRole (before any query) -> service. A display token reaches no other operation:
// every other handler asserts a staff/patient permission that a device never holds (REQ-SEC-017, AB-8).
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { createDisplayService, type DisplayService } from '../service/display.service.js';
import { isUuid, type QueueCtx } from '../service/queue.service.js';

type Assert = (r: { permission: string; centreId?: string }) => Promise<void>;
type Ports = { IdentityPort?: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<void> } };
const MANAGE = 'engagement.queue.manage';
const BOARD = 'engagement.queue.board_read';
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});

function bind(fn: (svc: DisplayService, c: QueueCtx, req: HandlerRequest, assertRole: Assert, now: string) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>, deviceOnly = false): Handler {
  return async (req: HandlerRequest, hctx: HandlerContext): Promise<HandlerResult> => {
    const c = hctx as unknown as Partial<QueueCtx> & { ports?: Ports; now?: () => string };
    if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    if (deviceOnly && c.actor.type !== 'device') throw new LimsError('auth.forbidden'); // TRD §3: the board handler requires a device
    const identity = c.ports?.IdentityPort;
    if (!identity) throw new LimsError('common.service_unavailable'); // never serve unauthorised
    const out = await fn(createDisplayService(), c as QueueCtx, req, (r) => identity.assertRole(hctx, r), c.now?.() ?? new Date().toISOString());
    const v = obj(out.body)['version'];
    return { status: out.status, ...(out.body === undefined ? {} : { body: out.body }), headers: { ...(typeof v === 'number' ? { etag: `"${v}"` } : {}), ...out.headers } };
  };
}

const list = bind(async (svc, c, req, assertRole) => {
  const centre = obj(req.query)['centre_id'];
  await assertRole({ permission: MANAGE, ...(isUuid(centre) ? { centreId: centre } : {}) });
  if (centre !== undefined && !isUuid(centre)) throw new LimsError('common.validation_failed', undefined, [{ path: '/centre_id', code: 'common.field_invalid', message: 'Field invalid' }]);
  return svc.list(c, { centreId: centre as string | undefined });
});

const pair = bind(async (svc, c, req, assertRole, now) => {
  const centre = obj(req.body)['centre_id'];
  await assertRole({ permission: MANAGE, ...(isUuid(centre) ? { centreId: centre } : {}) });
  return svc.pair(c, { body: req.body, now });
});

const revoke = bind(async (svc, c, req, assertRole, now) => {
  await assertRole({ permission: MANAGE });
  return svc.revoke(c, { id: obj(req.params)['display_id'], headers: req.headers, now, authorizeRow: (centreId) => assertRole({ permission: MANAGE, centreId }) });
});

const board = bind(async (svc, c, req, assertRole, now) => {
  await assertRole({ permission: BOARD });
  return svc.board(c, { headers: req.headers, now });
}, true);

export const displayHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listQueueDisplays: list, pairQueueDisplay: pair, revokeQueueDisplay: revoke, getQueueBoard: board,
});
