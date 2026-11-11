// PG-T15 — payments.check_refund (02-TRD §8.3 row 6, §6.6 step 6; AC-PG-09.4 / 09.5): one gateway check of a requested / held_for_review refund through the SAME completion step the
// P11 / P7b handlers use. Confirmed -> completed + ledger + intent; not visible / wrong kind -> held_for_review. No usable answer -> THROW (queue backoff, max_attempts 8; nothing written).
// Any other status -> no-op. No min interval (that is P7b's) and unconfirmed_run_count is reconciliation's, not touched here. The payload is untrusted: ids only, never a status or amount.
import { LimsError } from '../../../../../api/src/core/errors.js';
import { findRefund } from '../../../../../api/src/modules/payments/repository/refunds.repo.js';
import type { Ctx, PaymentsDeps } from '../../../../../api/src/modules/payments/repository/shared.js';
import { OPEN_REFUND, createRefundCompletion } from '../../../../../api/src/modules/payments/service/refund.completion.js';
import { isUuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const CHECK_REFUND = 'payments.check_refund';

export function createCheckRefund(deps: PaymentsDeps, ports: Ctx['ports']): TaskHandler {
  const completion = createRefundCompletion(deps);
  return async (payload, ctx) => {
    const id = payload?.['refund_id'];
    if (!ctx.tenantId || payload?.['tenant_id'] !== ctx.tenantId || typeof id !== 'string' || !isUuidv7(id)) return;   // never retry a malformed job
    const c = { ...ctx, tenantId: ctx.tenantId, ports } as unknown as Ctx;
    const row = await findRefund(c, id);                                    // tenant-scoped: a foreign / unknown id is "not found" -> nothing to check
    if (!row || !(OPEN_REFUND as readonly string[]).includes(row['status'])) return;

    const { verdict, flush } = await completion.check(c, row);
    if (verdict.kind === 'transient') throw new Error('payments.check_refund: no usable gateway answer');   // rolls the unit back; backoff retries
    try { await completion.apply(c, id, verdict); } catch (e) {
      if (e instanceof LimsError && e.code === 'payments.refund_not_allowed') return;   // completed / failed by a person meanwhile: nothing left to do
      throw e;
    }
    await flush();
  };
}
