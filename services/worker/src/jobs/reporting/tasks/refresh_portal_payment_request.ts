// Task reporting.refresh_portal_payment_request (02-TRD §6.6 PP1/PP2 step 3, §9; 01-PRD AC-18.5, AC-18.6). Job key ppref:<id>, maxAttempts 3.
// PP2 enqueues it for a `ready` row not checked for 3 s. PaymentProviderPort.getIntent as the system actor (read only: no verify, no BillingPort, no ledger write: the ledger row is C15's).
//   settled / refunded / partially_refunded -> completed (completed_at) | failed -> failed `payment_failed` | expired -> expired | held_for_review -> stays ready, review = true | other -> last_checked_at only.
// [CONV] C16 maps failed and expired both to expired; C6 keeps them apart for the page copy. action_json is scrubbed whenever the row leaves ready / review = false (DB CHECK).
// A getIntent failure THROWS (queue retry) and leaves the row as it was. Terminal rows are never touched again (guard trigger).
import type { TaskHandler } from '../../../core/manifest.js';

type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DONE = new Set(['settled', 'refunded', 'partially_refunded']);

export const refreshPortalPaymentRequest: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId; const id = payload?.['portal_payment_request_id'];
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId || typeof id !== 'string' || !UUID.test(id)) {
    ctx.log?.warn?.({ event: 'refresh_portal_payment_request_skipped', reason: 'bad_payload' });
    return;
  }
  const tx = ctx.tx; const now: string = ctx.now(); const actorId: string = ctx.actor.id;
  const r = (await tx.query(`SELECT id, intent_id, status FROM reporting.portal_payment_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, id])).rows[0] as Row | undefined;
  if (!r || r['status'] !== 'ready' || !r['intent_id']) { ctx.log?.info?.({ event: 'refresh_portal_payment_request_noop' }); return; }

  const intent = await ctx.ports.PaymentProviderPort.getIntent(ctx, { intentId: r['intent_id'] });
  const status = String(intent?.status);

  // static SQL per outcome (no interpolation): every branch also moves last_checked_at; created / initiated / pending change nothing else
  const U = `UPDATE reporting.portal_payment_requests SET`; const W = `last_checked_at = $3, updated_at = $3, updated_by = $4, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND status = 'ready'`;
  const args = [tenantId, id, now, actorId];
  if (DONE.has(status)) await tx.query(`${U} status = 'completed', completed_at = $3, review = false, action_json = NULL, ${W}`, args);
  else if (status === 'failed') await tx.query(`${U} status = 'failed', failure_code = 'payment_failed', review = false, action_json = NULL, ${W}`, args);
  else if (status === 'expired') await tx.query(`${U} status = 'expired', review = false, action_json = NULL, ${W}`, args);
  else if (status === 'held_for_review') await tx.query(`${U} review = true, action_json = NULL, ${W}`, args);
  else await tx.query(`${U} ${W}`, args);
};
