// FD-T06: typed publisher for frontdesk.order.created.v1 (02-TRD §8.1; 03-IC §3.1). Same seam as billing/events/publish.ts.
// The payload goes through verbatim: core validates it against contracts/events/frontdesk.order.created.v1.schema.json (additionalProperties false),
// so a name, phone or registration no fails closed with common.internal and nothing is stored (REQ-SEC-006, P1/P3).
import { LimsError } from '../../../core/errors.js';
import type { PublishInput } from '../../../core/events/publish.js';

interface Events { publish(ctx: never, type: string, input: PublishInput): Promise<{ eventId: string; duplicate: boolean }> }
type Ctx = Parameters<Events['publish']>[0];
type Payload = Readonly<Record<string, unknown>>;

export function createFrontdeskEvents(events: Events) {
  return {
    /** Key `<order_id>:created`; aggregate order, seq = orders.version after the write (a replay or an in-tx retry is a duplicate no-op). */
    orderCreated: async (ctx: Ctx, p: Payload, orderVersion: number) => {
      if (!Number.isSafeInteger(orderVersion) || orderVersion < 1) throw new LimsError('common.internal');
      return events.publish(ctx, 'frontdesk.order.created.v1', {
        aggregate: { type: 'order', id: p['order_id'] as string, seq: orderVersion }, idempotencyKey: `${String(p['order_id'])}:created`, payload: p,
      });
    },
    /** FD-T09: key `<order_id>:items:<order_version>`, seq = orders.version after the F13 write. `added`/`removed` are never both empty (the caller guarantees it). */
    itemsChanged: async (ctx: Ctx, p: Payload, orderVersion: number) => {
      if (!Number.isSafeInteger(orderVersion) || orderVersion < 1) throw new LimsError('common.internal');
      return events.publish(ctx, 'frontdesk.order.items_changed.v1', {
        aggregate: { type: 'order', id: p['order_id'] as string, seq: orderVersion }, idempotencyKey: `${String(p['order_id'])}:items:${orderVersion}`, payload: p,
      });
    },
    /** FD-T09: key `<order_id>:cancelled`, seq = orders.version after the F14 write. Payload carries no reason text (P3). */
    cancelled: async (ctx: Ctx, p: Payload, orderVersion: number) => {
      if (!Number.isSafeInteger(orderVersion) || orderVersion < 1) throw new LimsError('common.internal');
      return events.publish(ctx, 'frontdesk.order.cancelled.v1', {
        aggregate: { type: 'order', id: p['order_id'] as string, seq: orderVersion }, idempotencyKey: `${String(p['order_id'])}:cancelled`, payload: p,
      });
    },
  };
}
export type FrontdeskEvents = ReturnType<typeof createFrontdeskEvents>;
