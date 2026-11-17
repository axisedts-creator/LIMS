// D1 listDeliveries, D2 getDelivery, D3 sendReportDelivery, D4 retryDelivery (02-TRD §6.3; AC-09.6, AC-09.7). Schema, auth, x-permission and Idempotency-Key are
// enforced by the core pipeline; the handlers re-check what they need (fail closed) and never echo input.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { FlowCtx } from '../service/delivery.flow.service.js';
import * as svc from '../service/delivery.staff.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {});

function scope(hctx: HandlerContext): FlowCtx {
  const c = hctx as unknown as Partial<FlowCtx>;
  if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx || !c.ports || !c.events) throw new LimsError('auth.unauthenticated');
  return c as FlowCtx;
}

function parseSend(raw: unknown) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw svc.bad('/');
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'recipient_kind' && k !== 'channel' && k !== 'centre_contact_id') throw svc.bad('/');   // additionalProperties: false
  if (typeof b['recipient_kind'] !== 'string' || !['patient', 'referrer', 'centre'].includes(b['recipient_kind'])) throw svc.bad('/recipient_kind');
  if (typeof b['channel'] !== 'string' || !['whatsapp', 'sms', 'email'].includes(b['channel'])) throw svc.bad('/channel');
  const contact = b['centre_contact_id'];
  if ((b['recipient_kind'] === 'centre') !== (contact !== undefined)) throw svc.bad('/centre_contact_id');
  if (contact !== undefined && (typeof contact !== 'string' || !UUID.test(contact))) throw svc.bad('/centre_contact_id');
  return { recipientKind: b['recipient_kind'], channel: b['channel'] as 'whatsapp' | 'sms' | 'email', ...(contact !== undefined ? { centreContactId: contact as string } : {}) };
}

export const deliveryHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  listDeliveries: async (req: HandlerRequest, hctx: HandlerContext) => {
    const ctx = scope(hctx);
    return { status: 200, body: await svc.list(ctx, obj(req.query)) };
  },
  getDelivery: async (req: HandlerRequest, hctx: HandlerContext) => {
    const ctx = scope(hctx);
    const r = await svc.get(ctx, obj(req.params)['delivery_id']);
    return { status: 200, headers: { etag: `"${r.version}"` }, body: r.body };
  },
  sendReportDelivery: async (req: HandlerRequest, hctx: HandlerContext) => {
    const ctx = scope(hctx);
    const body = parseSend(req.body);
    return { status: 201, body: await svc.send(ctx, obj(req.params)['report_id'], body) };
  },
  retryDelivery: async (req: HandlerRequest, hctx: HandlerContext) => {
    const ctx = scope(hctx);
    const header = obj(req.headers)['if-match'];
    if (header === undefined) throw new LimsError('common.precondition_required');
    const m = typeof header === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(header) : null;
    if (!m || Number(m[1]) > 2147483647) throw svc.bad('/If-Match');
    return { status: 201, body: await svc.retry(ctx, obj(req.params)['delivery_id'], Number(m[1])) };
  },
});
