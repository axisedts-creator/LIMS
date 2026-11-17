// PG-T15 — P7b recheckPaymentRefund (TRD §5.1, §6.6 step 9; AC-PG-09.10): the in-request gateway check of §6.6 step 6 for a requested / held_for_review refund.
// Within VERIFY_MIN_INTERVAL_SECONDS of refunds.last_checked_at -> 429 + Retry-After (no gateway call, nothing written). Transient -> 503, nothing changes (so the retry is not throttled).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import type { Ctx, PaymentsDeps } from '../repository/shared.js';
import { createRefundCompletion } from '../service/refund.completion.js';
import { RESOLVE, loadOpen, only, refundId, reply, staff, unavailable, type RefundCtx, type Req } from './refundShared.js';

export function createRecheckPaymentRefund(deps: PaymentsDeps): Handler {
  const completion = createRefundCompletion(deps);
  const run = async (req: Req, ctx: RefundCtx) => {
    await staff(ctx, RESOLVE);
    const id = refundId(req);
    only(req.body, [], true);                                                                  // {} or no body; nothing from the caller steers the check
    const c = ctx as unknown as Ctx;
    const row = await loadOpen(ctx, id, RESOLVE);
    const min = deps.config.verifyMinIntervalSeconds;
    if (row['last_checked_at']) {
      const age = (Date.parse(ctx.now()) - new Date(row['last_checked_at']).getTime()) / 1000;
      if (age < min) throw Object.assign(new LimsError('common.rate_limited', 'recheck'), { retryAfterSeconds: Math.min(min, Math.max(1, Math.ceil(min - age))) });
    }
    const { verdict, flush } = await completion.check(c, row);
    if (verdict.kind === 'transient') throw unavailable();
    const done = await completion.apply(c, id, verdict);
    await flush();
    return reply(done);
  };
  return (req, ctx) => run(req as Req, ctx as unknown as RefundCtx);
}
