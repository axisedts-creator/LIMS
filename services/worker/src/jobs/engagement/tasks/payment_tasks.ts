// Tasks engagement.create_payment_intent / engagement.refresh_payment_request {tenant_id, payment_request_id} and the cron engagement.expire_payment_requests {tenant_id}
// (02-TRD §4.7 steps 2-4, §6.2 createIntent / getIntent, §8.1 max 3 + job keys pay:<id> / payref:<id>, §8.2 every 10 min; 01-PRD US-EN-10.1, 10.3, 10.4; 07-SECURITY REQ-SEC-046, REQ-SEC-059; 08 R8: only the system actor calls PaymentProviderPort).
// [CONV] createIntent input is EXACTLY {orderId, gateway, idempotencyKey: 'eng:<id>', returnUrl, cancelUrl} - never an amount. returnUrl = cancelUrl = <LIMS_ORIGIN_PORTAL>/app/payments/<id>/done.
// [CONV] any payments.* error -> failed + failure_code verbatim (terminal, the task resolves); any other error rejects (retry) with a fixed message: the port's text is never echoed.
// [CONV] eSewa form_post: only launchUrl is stored (as action url); the signed fields are never persisted. "Paid" = intent status `settled` only (REQ-SEC-059); nothing in the payload is trusted.
// ponytail: refunded / partially_refunded on a still-`ready` row, qr actions and a form_post without launchUrl are not mapped: the row keeps polling until expire_payment_requests closes it (30 min after expires_at).
import type { TaskHandler } from '../../../core/manifest.js';

type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENTS_CODE = /^payments\.[a-z0-9_]{1,50}$/; // failure_code <= 64 (payment_requests__failure__ck)
const GRACE_MS = 30 * 60_000; // TRD §8.2
export const EXPIRE_PAYMENT_REQUESTS = 'engagement.expire_payment_requests';

const unavailable = (what: string) => Object.assign(new Error(`${what}: PaymentProviderPort unavailable`), { code: 'common.dependency_unavailable' });
const codeOf = (e: unknown): unknown => (e as { code?: unknown })?.code;

/** The request id when the payload is for THIS job's tenant, else undefined (the task then resolves without a statement or a port call; REQ-SEC-024). */
function target(payload: any, ctx: any): string | undefined {
  const id = payload?.['payment_request_id'];
  if (typeof ctx.tenantId !== 'string' || (payload?.['tenant_id'] !== undefined && payload['tenant_id'] !== ctx.tenantId) || typeof id !== 'string' || !UUID.test(id)) return undefined;
  return id;
}
async function load(ctx: any, id: string, status: string): Promise<Row | undefined> {
  const { rows } = await ctx.tx.query('SELECT id, order_id, gateway, status, intent_id, review FROM engagement.payment_requests WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id]) as { rows: Row[] };
  return rows[0]?.['status'] === status ? rows[0] : undefined;
}

export function createCreatePaymentIntent(): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any; const id = target(payload, ctx); if (!id) return;
    const row = await load(ctx, id, 'queued'); if (!row) return; // retry / double enqueue: never a second intent
    const origin = String(process.env['LIMS_ORIGIN_PORTAL'] ?? '').replace(/\/+$/, '');
    const back = `${origin}/app/payments/${id}/done`;
    let out: Row;
    try { out = await ctx.ports.PaymentProviderPort.createIntent(ctx, { orderId: row['order_id'], gateway: row['gateway'], idempotencyKey: `eng:${id}`, returnUrl: back, cancelUrl: back }); }
    catch (e) {
      const code = codeOf(e);
      if (typeof code === 'string' && PAYMENTS_CODE.test(code)) {
        await ctx.tx.query("UPDATE engagement.payment_requests SET status = 'failed', failure_code = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2 AND status = 'queued'", [ctx.tenantId, id, code, ctx.actor.id]);
        ctx.log?.info?.({ event: 'create_payment_intent_failed', failure_code: code });
        return;
      }
      throw unavailable('create_payment_intent');
    }
    const a = out?.['action']; const url = a?.['kind'] === 'redirect' ? a['url'] : a?.['kind'] === 'form_post' ? a['launchUrl'] : undefined;
    const paisa = Number(out?.['amount']?.['amountPaisa']);
    if (typeof out?.['intentId'] !== 'string' || typeof url !== 'string' || !Number.isSafeInteger(paisa) || paisa <= 0 || !Number.isFinite(Date.parse(out['expiresAt']))) throw unavailable('create_payment_intent'); // unusable answer: retry, then dead-letter
    await ctx.tx.query(
      "UPDATE engagement.payment_requests SET status = 'ready', intent_id = $3, amount_paisa = $4, action_json = $5::jsonb, expires_at = $6, failure_code = NULL, version = version + 1, updated_at = now(), updated_by = $7 WHERE tenant_id = $1 AND id = $2 AND status = 'queued'",
      [ctx.tenantId, id, out['intentId'], paisa, JSON.stringify({ kind: a['kind'], url }), new Date(out['expiresAt']).toISOString(), ctx.actor.id]);
    ctx.log?.info?.({ event: 'create_payment_intent_ready', gateway: row['gateway'] });
  };
}

export function createRefreshPaymentRequest(): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any; const id = target(payload, ctx); if (!id) return;
    const row = await load(ctx, id, 'ready'); if (!row) return;
    let status: unknown;
    try { status = (await ctx.ports.PaymentProviderPort.getIntent(ctx, { intentId: row['intent_id'] }))?.['status']; }
    catch (e) { if (codeOf(e) === 'common.not_found') status = 'expired'; else throw unavailable('refresh_payment_request'); }
    const set = status === 'settled' ? "status = 'completed', action_json = NULL, version = version + 1, "
      : status === 'failed' || status === 'expired' ? "status = 'expired', action_json = NULL, version = version + 1, "
      : status === 'held_for_review' && row['review'] !== true ? 'review = true, version = version + 1, ' : ''; // created / initiated / pending: only "last checked" moves
    await ctx.tx.query(`UPDATE engagement.payment_requests SET ${set}updated_at = now(), updated_by = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'ready'`, [ctx.tenantId, id, ctx.actor.id]);
  };
}

/** Cron: ready rows more than 30 min past expires_at -> expired, action scrubbed. Never calls a port. */
export const expirePaymentRequests: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any; const tenantId = payload?.['tenant_id'];
  if (typeof tenantId !== 'string' || !UUID.test(tenantId) || ctx.tenantId !== tenantId) return;
  await ctx.tx.query("UPDATE engagement.payment_requests SET status = 'expired', action_json = NULL, version = version + 1, updated_at = now(), updated_by = $2 WHERE tenant_id = $1 AND status = 'ready' AND expires_at < $3",
    [tenantId, ctx.actor.id, new Date(Date.parse(ctx.now()) - GRACE_MS).toISOString()]);
};
