// PG-T15 — payments.execute_refund (02-TRD §8.3 row 5, §6.6 step 4, §7.4; AC-PG-09.7). max_attempts 1: the refund API's idempotency is undocumented, so the POST is never retried [CONV].
// Acts only on a `requested`, mode 'api', Khalti refund whose merchant account has api_refunds_enabled (else zero refund calls, no write). Lookup FIRST: already Refunded / Partially
// Refunded -> skip the POST. Then ONE refundViaApi. Confirmation is never the POST answer: every outcome except 'rejected' enqueues payments.check_refund (lookup decides).
// accepted -> stays requested; unknown (or a throw) -> held_for_review / api_outcome_unknown (a held row is never POSTed again); rejected -> failed / refund_rejected_by_provider.
import { LimsError } from '../../../../../api/src/core/errors.js';
import { accountById, findById, usable } from '../../../../../api/src/modules/payments/repository/intents.repo.js';
import { findRefund, updateRefund } from '../../../../../api/src/modules/payments/repository/refunds.repo.js';
import type { Ctx, PaymentsDeps } from '../../../../../api/src/modules/payments/repository/shared.js';
import { createOutcomeService } from '../../../../../api/src/modules/payments/service/outcome.service.js';
import { isUuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { CHECK_REFUND } from './check_refund.js';

export const EXECUTE_REFUND = 'payments.execute_refund';

export function createExecuteRefund(deps: PaymentsDeps, ports: Ctx['ports']): TaskHandler {
  const outcome = createOutcomeService(deps);
  return async (payload, ctx) => {
    const id = payload?.['refund_id'];
    if (!ctx.tenantId || payload?.['tenant_id'] !== ctx.tenantId || typeof id !== 'string' || !isUuidv7(id)) return;   // never retry a malformed job
    const c = { ...ctx, tenantId: ctx.tenantId, ports } as unknown as Ctx;
    const refund = await findRefund(c, id);
    if (!refund || refund['status'] !== 'requested' || refund['mode'] !== 'api' || refund['gateway'] !== 'khalti' || typeof deps.adapters.khalti.refundViaApi !== 'function') return;
    const intent = await findById(c, refund['intent_id']);
    const acct = intent ? await accountById(c, intent['merchant_account_id']) : undefined;
    if (!intent || acct?.['api_refunds_enabled'] !== true) return;           // the tenant flag is checked HERE too: a stale api-mode row makes no refund call

    // 1. lookup first (read-only, evidence queued): never POST blind, never POST what is already refunded
    const look = await outcome.probeDeferred(c, intent['id'], id);
    if (look.res.kind !== 'answer') throw new LimsError('payments.gateway_not_available');   // no POST on a guess; one attempt only, so the dead letter is the alert
    await look.flush();
    const enqueue = (): Promise<void> => deps.jobs.enqueue(c, CHECK_REFUND, { tenant_id: ctx.tenantId, refund_id: id }, { key: `check_refund:${id}` });
    if (['Refunded', 'Partially Refunded'].includes(look.res.statusRaw)) return enqueue();

    // 2. ONE POST
    const txn = look.res.secondaryRef ?? intent['gateway_secondary_ref'];
    if (typeof txn !== 'string' || txn === '') return enqueue();             // no Khalti transaction id to refund: leave it to the check (-> held) and the manual path
    const { handle } = usable(deps.kek, c, acct);
    const log = outcome.gatewayLog(c, 'khalti', intent['id'], acct, 'khalti_refund', { refundId: id });
    const amount = Number(refund['amount_paisa']);
    let out: { kind: 'accepted' | 'rejected' | 'unknown' }, threw = false;
    try {
      out = await deps.adapters.khalti.refundViaApi!({ refundId: id, intentId: intent['id'], transactionId: txn, amountPaisa: amount,
        fullRefund: Number(intent['refunded_paisa']) + amount === Number(intent['amount_paisa']) }, handle, { timeoutClass: 'job', sink: log.sink });
    } catch { out = { kind: 'unknown' }; threw = true; }                                   // a throw after (possibly) sending is an unknown outcome, never a retry
    await log.fallback(threw ? 'network_error' : 'answer');

    if (out.kind === 'rejected') {
      await updateRefund(c, refund, { status: 'failed', failure_reason: 'refund_rejected_by_provider' }, ['requested']);
      return;
    }
    if (out.kind === 'unknown') await updateRefund(c, refund, { status: 'held_for_review', held_reason: 'api_outcome_unknown', last_checked_at: ctx.now() }, ['requested']);
    await enqueue();
  };
}
