// PG-T15 — P11b failManualPaymentRefund (TRD §5.1, §6.6 step 8, R8; AC-PG-09.9, review #6): mark a requested / held_for_review refund failed ONLY after a fresh read-only gateway
// check shows NO refund. A visible refund -> 409 payments.refund_not_allowed (detail gateway_shows_refund), nothing written (finance uses P7b); transient -> 503. If-Match required.
// failed frees the in-flight slot; no ledger row, intent untouched.
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { findRefund, updateRefund } from '../repository/refunds.repo.js';
import { invalid, type Ctx, type PaymentsDeps } from '../repository/shared.js';
import { createRefundCompletion, OPEN_REFUND } from '../service/refund.completion.js';
import { activeCode } from '../service/refund.service.js';
import { APPROVE, ifMatch, loadOpen, only, refundId, reply, staff, text500, unavailable, type RefundCtx, type Req } from './refundShared.js';

export function createFailManualPaymentRefund(deps: PaymentsDeps): Handler {
  const completion = createRefundCompletion(deps);
  const run = async (req: Req, ctx: RefundCtx) => {
    await staff(ctx, APPROVE);
    const id = refundId(req);
    const expected = ifMatch(req.headers);
    const b = only(req.body, ['reason_code', 'note']);
    const note = text500(b['note'], 'note');
    const c = ctx as unknown as Ctx;
    const reason = await activeCode(c, 'refund_fail_reasons', b['reason_code']);
    if (reason.requires_text && !note?.trim()) invalid('note');

    const row = await loadOpen(ctx, id, APPROVE);
    if (Number(row['version']) !== expected) throw new LimsError('common.version_conflict');
    const { verdict, flush } = await completion.check(c, row);
    if (verdict.kind === 'transient') throw unavailable();
    if (verdict.kind === 'visible') throw new LimsError('payments.refund_not_allowed', 'gateway_shows_refund');

    const locked = await findRefund(c, id, true);                                              // the check ran unlocked: re-verify under the lock
    if (!locked || !(OPEN_REFUND as readonly string[]).includes(locked['status'])) throw new LimsError('payments.refund_not_allowed');
    if (Number(locked['version']) !== expected) throw new LimsError('common.version_conflict');
    const done = await updateRefund(c, locked, { status: 'failed', failure_reason: reason.code, ...(note !== undefined ? { failure_note: note } : {}), last_checked_at: ctx.now() }, OPEN_REFUND);
    if (!done) throw new LimsError('common.version_conflict');
    await flush();
    return reply(done);
  };
  return (req, ctx) => run(req as Req, ctx as unknown as RefundCtx);
}
