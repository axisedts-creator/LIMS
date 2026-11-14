// Task reporting.create_portal_payment_intent (02-TRD §6.6 PP1/PP2 step 2, §9; 08 A11.1; 01-PRD AC-18.3, AC-18.7; 07-SECURITY REQ-SEC-046/059). Job key ppay:<id>, maxAttempts 3.
// Lock the request (a duplicate run waits, then sees it is no longer `queued` and exits) -> link still live -> BillingPort.getOrderBalance (<= 0 -> failed nothing_due, createIntent is NOT called)
// -> PaymentProviderPort.createIntent as the system actor with idempotencyKey rpt_<id> (a retry after a lost run replays the same intent). The amount is never passed: C15 computes it (REQ-SEC-046)
// and the row stores what C15 charged. payments.* errors are terminal (row `failed`, code suffix); anything else THROWS for the queue retry and leaves the row `queued`.
// The gateway URL goes only into action_json: never into a log line, audit row, metric label or job payload (AC-18.5).
import type { TaskHandler } from '../../../core/manifest.js';

type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_SUFFIX = /^[a-z][a-z0-9_]{0,63}$/;

export const createPortalPaymentIntent: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId; const id = payload?.['portal_payment_request_id'];
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId || typeof id !== 'string' || !UUID.test(id)) {
    ctx.log?.warn?.({ event: 'create_portal_payment_intent_skipped', reason: 'bad_payload' });
    return;
  }
  const tx = ctx.tx; const now: string = ctx.now(); const actorId: string = ctx.actor.id;
  const rows = async (sql: string, values: unknown[]): Promise<Row[]> => (await tx.query(sql, values)).rows;

  const r = (await rows(`SELECT id, link_id, order_id, gateway, status FROM reporting.portal_payment_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, id]))[0];
  if (!r || r['status'] !== 'queued') { ctx.log?.info?.({ event: 'create_portal_payment_intent_noop' }); return; }

  const fail = async (code: string) => {
    await tx.query(`UPDATE reporting.portal_payment_requests SET status = 'failed', failure_code = $3, updated_at = $4, updated_by = $5, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`,
      [tenantId, id, code, now, actorId]);
  };

  const link = (await rows(`SELECT id FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`, [tenantId, r['link_id']]))[0];
  if (!link) { await fail('link_revoked'); return; }                              // revoked before the worker ran: never reaches the gateway; frees the order's open slot

  const origin = String(process.env['LIMS_ORIGIN_PORTAL'] ?? '').replace(/\/+$/, '');
  if (!origin) throw new Error('LIMS_ORIGIN_PORTAL is not configured');           // retry; never send the gateway a broken return URL

  const balance = await ctx.ports.BillingPort.getOrderBalance(ctx, { orderId: r['order_id'] });   // any error retries
  if (!(Number(balance?.balanceDue?.amountPaisa) > 0)) { await fail('nothing_due'); return; }

  const doneUrl = `${origin}/r/payments/${id}/done`;                              // route portal.payment_done (03-IC §7)
  let out: Row;
  try {
    out = await ctx.ports.PaymentProviderPort.createIntent(ctx, { orderId: r['order_id'], gateway: r['gateway'], idempotencyKey: `rpt_${id}`, returnUrl: doneUrl, cancelUrl: doneUrl });
  } catch (e) {
    const code = String((e as Row)?.['code'] ?? '');
    if (code.startsWith('payments.') && CODE_SUFFIX.test(code.slice('payments.'.length))) { await fail(code.slice('payments.'.length)); return; }   // [CONV] terminal; network retries live inside C15
    throw e;
  }

  const action = out?.['action'] as Row | undefined;
  const url = action?.['kind'] === 'form_post' ? action['launchUrl'] : action?.['url'];
  if (typeof url !== 'string' || !url.startsWith('https://')) { await fail('unsupported_action'); return; }   // [CONV] eSewa form_post without launchUrl

  await tx.query(`UPDATE reporting.portal_payment_requests SET status = 'ready', intent_id = $3, amount_paisa = $4, action_json = $5::jsonb, intent_expires_at = $6, last_checked_at = $7,
      updated_at = $7, updated_by = $8, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`,
    [tenantId, id, out['intentId'], out['amount']?.['amountPaisa'], JSON.stringify({ url }), out['expiresAt'] ?? null, now, actorId]);
};
