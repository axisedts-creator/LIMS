// E41 createPaymentRequest, E42 getPaymentRequest (patient actor) over engagement.payment_requests (02-TRD §4.7 steps 1 / 3 / 4, §5 E41/E42, §8.1 job keys pay:<id> / payref:<id>;
// 01-PRD US-EN-10.1-10.3, 10.5, 10.6; 07-SECURITY REQ-SEC-046 (no amount from the client), REQ-SEC-059 (Paid only from server state), REQ-SEC-024, P-L1; 08 R8: the API never calls PaymentProviderPort / BillingPort).
// E41 inserts one `queued` row and enqueues engagement.create_payment_intent; E42 reads the row only and, for a `ready` row last checked >= 3 s ago, enqueues engagement.refresh_payment_request.
// [CONV] "last checked" = payment_requests.updated_at (the refresh task touches it). [CONV] a body with any key but `gateway`, or a gateway outside settings.app_gateways -> common.validation_failed.
// [CONV] an open request of ANOTHER account for the same order (RLS hides it; the partial unique index stops the insert) -> common.idempotency_in_progress (declared on E41).
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { invalid, isUuid } from './slot.service.js';
import { myLinks, scope, type OrdersCtx } from './orders.service.js';

type Row = Record<string, any>;
type Out = { status: number; body: Record<string, unknown> };
const GATEWAYS = ['esewa', 'khalti'];
const KEY = /^[\x21-\x7e]{1,128}$/; // Idempotency-Key: printable ASCII
const REFRESH_AFTER_MS = 3_000; // 03-APP-FLOW §4.2
const ENQUEUE = 'SELECT app.enqueue_job($1, $2::jsonb, $3)';
export const CREATE_JOB = 'engagement.create_payment_intent';
export const REFRESH_JOB = 'engagement.refresh_payment_request';

const ms = (v: unknown): number => new Date(v as string).getTime();
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
const header = (h: unknown, name: string): unknown => Object.entries(obj(h)).find(([k]) => k.toLowerCase() === name)?.[1];

/** PaymentRequest DTO (TRD §5): no intent id, account, patient, key or version. action / amount only while they apply; failure_code only when failed. */
function dto(r: Row): Record<string, unknown> {
  const live = r['status'] === 'ready' || r['status'] === 'completed';
  return {
    id: r['id'], order_id: r['order_id'], gateway: r['gateway'], status: r['status'], review: r['review'] === true,
    ...(live && r['amount_paisa'] != null ? { amount: { amount_paisa: Number(r['amount_paisa']), currency: 'NPR' } } : {}),
    ...(r['status'] === 'ready' && r['action_json'] ? { action: { kind: obj(r['action_json'])['kind'], url: obj(r['action_json'])['url'] } } : {}),
    ...(r['status'] === 'failed' && r['failure_code'] ? { failure_code: r['failure_code'] } : {}),
    ...(r['status'] === 'ready' && r['expires_at'] ? { expires_at: new Date(r['expires_at']).toISOString() } : {}),
  };
}
const cols = 'id, order_id, gateway, status, review, amount_paisa, action_json, failure_code, expires_at, updated_at';

async function myAccountId(tx: any, tenantId: string, membershipId: string): Promise<string | undefined> {
  return (await tx.query("SELECT id FROM engagement.accounts WHERE tenant_id = $1 AND membership_id = $2 AND status <> 'deleted'", [tenantId, membershipId])).rows[0]?.['id'];
}

export function createPaymentService() {
  return {
    /** E41: 202 + queued request; 200 + the open request when the order already has one (idempotent by order). */
    async create(ctx: OrdersCtx, req: { orderId: unknown; body: unknown; headers: unknown }): Promise<Out> {
      const { tx, tenantId, membershipId } = scope(ctx);
      const key = header(req.headers, 'idempotency-key');
      if (typeof key !== 'string' || !KEY.test(key)) return invalid('/idempotency-key');
      const body = obj(req.body); const gateway = body['gateway'];
      if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body) || Object.keys(body).length !== 1 || typeof gateway !== 'string' || !GATEWAYS.includes(gateway)) return invalid('/gateway'); // REQ-SEC-046: no amount, no other key
      if (!isUuid(req.orderId)) return invalid('/order_id');

      const settings = (await tx.query('SELECT app_enabled, app_gateways FROM engagement.settings WHERE tenant_id = $1', [tenantId])).rows[0];
      if (!settings || settings['app_enabled'] !== true) throw new LimsError('common.feature_disabled');
      if (!Array.isArray(settings['app_gateways']) || !settings['app_gateways'].includes(gateway)) return invalid('/gateway');

      // the patient comes from the order projection filtered by the caller's own ACTIVE links (REQ-SEC-024, P-L1); anything else is the same 404
      const links = await myLinks(tx, tenantId, membershipId);
      const o = (await tx.query('SELECT order_id, patient_id, visible_at FROM engagement.patient_orders WHERE tenant_id = $1 AND order_id = $2', [tenantId, req.orderId])).rows[0];
      const link = o ? links.find((l) => l.patientId === o['patient_id']) : undefined;
      if (!o || !link || (link.visibleFrom && ms(o['visible_at']) < ms(link.visibleFrom))) throw new LimsError('common.not_found');
      const accountId = await myAccountId(tx, tenantId, membershipId); if (!accountId) throw new LimsError('common.not_found');

      const open = (await tx.query(`SELECT ${cols} FROM engagement.payment_requests WHERE tenant_id = $1 AND order_id = $2 AND account_id = $3 AND status IN ('queued', 'ready')`, [tenantId, req.orderId, accountId])).rows[0];
      if (open) return { status: 200, body: dto(open) };

      const id = uuidv7(); const actor = ctx.actor.id;
      const { rowCount } = await tx.query(
        `INSERT INTO engagement.payment_requests (id, tenant_id, account_id, order_id, patient_id, gateway, status, idempotency_key, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $8) ON CONFLICT DO NOTHING`,
        [id, tenantId, accountId, req.orderId, o['patient_id'], gateway, key, actor]);
      if (!rowCount) throw new LimsError('common.idempotency_in_progress');
      await tx.query(ENQUEUE, [CREATE_JOB, JSON.stringify({ tenant_id: tenantId, payment_request_id: id }), `pay:${id}`]);
      return { status: 202, body: { id, order_id: req.orderId, gateway, status: 'queued', review: false } };
    },

    /** E42: payment_requests only (never a port). A foreign / unknown id is the same 404 (P-L1). */
    async get(ctx: OrdersCtx, req: { paymentRequestId: unknown }): Promise<Out> {
      const { tx, tenantId, nowMs, membershipId } = scope(ctx);
      if (!isUuid(req.paymentRequestId)) throw new LimsError('common.not_found');
      const accountId = await myAccountId(tx, tenantId, membershipId); if (!accountId) throw new LimsError('common.not_found');
      const r = (await tx.query(`SELECT ${cols} FROM engagement.payment_requests WHERE tenant_id = $1 AND id = $2 AND account_id = $3`, [tenantId, req.paymentRequestId, accountId])).rows[0];
      if (!r) throw new LimsError('common.not_found');
      if (r['status'] === 'ready' && nowMs - ms(r['updated_at']) >= REFRESH_AFTER_MS) // job_key dedups concurrent polls
        await tx.query(ENQUEUE, [REFRESH_JOB, JSON.stringify({ tenant_id: tenantId, payment_request_id: r['id'] }), `payref:${r['id']}`]);
      return { status: 200, body: dto(r) };
    },
  };
}
export type PaymentService = ReturnType<typeof createPaymentService>;
