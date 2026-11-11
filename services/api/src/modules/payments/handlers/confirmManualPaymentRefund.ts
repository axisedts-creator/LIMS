// PG-T15 — P11 confirmManualPaymentRefund (TRD §5.1, §6.6 step 5; AC-PG-09.4 / 09.5): finance states the gateway reference + date of a manual refund, then the gateway check runs
// IN-REQUEST. Visible (right kind) -> completed + ledger once + intent refunded / partially_refunded; not visible -> held_for_review (reference kept). The amount is the approved one.
import type { Handler } from '../../../core/module.js';
import { invalid, type Ctx, type PaymentsDeps } from '../repository/shared.js';
import { createRefundCompletion } from '../service/refund.completion.js';
import { APPROVE, loadOpen, only, refundId, reply, staff, unavailable, type RefundCtx, type Req } from './refundShared.js';

const REF = /^[A-Za-z0-9_.:/-]{1,100}$/;                 // refunds__ref__ck
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function createConfirmManualPaymentRefund(deps: PaymentsDeps): Handler {
  const completion = createRefundCompletion(deps);
  const run = async (req: Req, ctx: RefundCtx) => {
    await staff(ctx, APPROVE);
    const id = refundId(req);
    const b = only(req.body, ['gateway_refund_reference', 'refunded_on']);
    const reference = typeof b['gateway_refund_reference'] === 'string' && REF.test(b['gateway_refund_reference']) ? b['gateway_refund_reference'] : invalid('gateway_refund_reference');
    const day = typeof b['refunded_on'] === 'string' && DAY.test(b['refunded_on']) && new Date(`${b['refunded_on']}T00:00:00Z`).toISOString().slice(0, 10) === b['refunded_on']
      ? b['refunded_on'] : invalid('refunded_on');
    const confirmer = ctx.actor.membershipId ?? invalid('membership');

    const c = ctx as unknown as Ctx;
    const row = await loadOpen(ctx, id, APPROVE);
    const { verdict, flush } = await completion.check(c, row);
    if (verdict.kind === 'transient') throw unavailable();                                     // nothing stored, not even the reference
    const done = await completion.apply(c, id, verdict, { gateway_refund_reference: reference, refunded_on: day, confirmed_by_membership_id: confirmer, confirmed_at: ctx.now() });
    await flush();
    return reply(done);
  };
  return (req, ctx) => run(req as Req, ctx as unknown as RefundCtx);
}
