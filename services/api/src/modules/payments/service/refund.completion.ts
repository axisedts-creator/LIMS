// PG-T15 — the ONE refund completion step shared by P11 confirmManualPaymentRefund, P7b recheckPaymentRefund, P11b failManualPaymentRefund (read-only part) and the
// payments.check_refund task (TRD §6.6 steps 6-9; R5-R8; intent I10/I11/I12; BillingPort.recordGatewayRefund [CR-C15-002]).
// check(): one gateway status call, evidence row QUEUED (flush it only if the caller writes). apply(): lock refund + intent, decide, write. Money moves only on a gateway answer
// that shows a refund of the expected kind; the amount is always the approved one (07-SECURITY AB-7), never a caller value.
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as the PG-T08 services).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { findById, insertTransition, updateIntent } from '../repository/intents.repo.js';
import { findRefund, updateRefund } from '../repository/refunds.repo.js';
import { money, notFound, type Ctx, type PaymentsDeps, type Row } from '../repository/shared.js';
import { createOutcomeService } from './outcome.service.js';

export const OPEN_REFUND = ['requested', 'held_for_review'] as const;
const FULL = ['FULL_REFUND', 'Refunded'], PARTIAL = ['PARTIAL_REFUND', 'Partially Refunded'];   // eSewa / Khalti, exact strings (REQ-SEC-047)

/** what the gateway said: transient = no usable answer (nothing may change); none = answered, no refund; full / partial / unknown = a refund is visible (unknown: only the `refunded` flag) */
export type Verdict = { kind: 'transient' } | { kind: 'none' } | { kind: 'visible'; visible: 'full' | 'partial' | 'unknown' };
type BillingRefund = { recordGatewayRefund(ctx: unknown, i: Record<string, unknown>): Promise<{ ledgerEntryId: string }> };

export function createRefundCompletion(deps: PaymentsDeps) {
  const outcome = createOutcomeService(deps);

  async function check(ctx: Ctx, refund: Row): Promise<{ verdict: Verdict; flush(): Promise<void> }> {
    let p: Awaited<ReturnType<typeof outcome.probeDeferred>> | undefined;
    try { p = await outcome.probeDeferred(ctx, refund['intent_id'], refund['id']); } catch (e) {
      if (e instanceof LimsError && e.code === 'payments.gateway_not_available') return { verdict: { kind: 'transient' }, flush: async () => undefined };   // account off / no secret: no answer
      throw e;
    }
    const r = p.res;
    if (r.kind === 'auth_error') deps.log?.error('payments_credential_rejected', { refundId: refund['id'], gateway: refund['gateway'] });
    if (r.kind !== 'answer') return { verdict: { kind: 'transient' }, flush: p.flush };            // transient / auth_error / not_found: unusable, never read as "no refund"
    const raw = r.statusRaw;
    const visible = FULL.includes(raw) ? 'full' : PARTIAL.includes(raw) ? 'partial' : 'refundedFlag' in r && r.refundedFlag ? 'unknown' : undefined;
    return { verdict: visible ? { kind: 'visible', visible } : { kind: 'none' }, flush: p.flush };
  }

  /**
   * Decide + write for a refund in requested / held_for_review. `extra` rides in the same UPDATE (P11: reference, date, confirmer). Returns the stored refund.
   * Throws refund_not_allowed when the row left requested / held_for_review meanwhile (a concurrent completion: nothing is written twice).
   */
  async function apply(ctx: Ctx, refundId: string, v: Exclude<Verdict, { kind: 'transient' }>, extra: Row = {}): Promise<Row> {
    const now = ctx.now();
    const refund = await findRefund(ctx, refundId, true);
    if (!refund || !(OPEN_REFUND as readonly string[]).includes(refund['status'])) throw new LimsError('payments.refund_not_allowed');
    const intent = await findById(ctx, refund['intent_id'], true) ?? notFound();
    const amount = Number(refund['amount_paisa']), captured = Number(intent['amount_paisa']), before = Number(intent['refunded_paisa']);

    let held: string | undefined;
    if (v.kind === 'none') held = refund['held_reason'] === 'api_outcome_unknown' ? 'api_outcome_unknown' : 'refund_not_visible';
    else if (v.visible !== (before + amount === captured ? 'full' : 'partial')
      || !['settled', 'partially_refunded'].includes(intent['status']) || before + amount > captured) held = 'refund_kind_mismatch';   // [CONV] an intent that cannot take the refund is also left to finance
    if (held) {
      const row = await updateRefund(ctx, refund, { status: 'held_for_review', held_reason: held, last_checked_at: now, ...extra }, OPEN_REFUND);
      return row ?? (() => { throw new LimsError('common.internal'); })();
    }

    const approver = refund['approved_by_membership_id'];
    const led = await (ctx.ports.BillingPort as unknown as BillingRefund).recordGatewayRefund(ctx, { refundId: refund['id'], intentId: intent['id'], orderId: refund['order_id'],
      gateway: refund['gateway'], gatewayTxnRef: intent['gateway_txn_ref'], amount: money(amount), reasonCode: refund['reason_code'], approvedByMembershipId: approver, refundedAt: now });
    const done = await updateRefund(ctx, refund, { status: 'completed', held_reason: null, completed_at: now, last_checked_at: now, ledger_entry_id: led.ledgerEntryId, ...extra }, OPEN_REFUND);
    if (!done) throw new LimsError('common.internal');                                              // row is locked; a lost update would be a bug, so the unit rolls back (ledger call included)
    const to = before + amount === captured ? 'refunded' : 'partially_refunded';
    const upd = await updateIntent(ctx, intent, { status: to, refunded_paisa: before + amount }, { from: ['settled', 'partially_refunded'] });
    if (!upd) throw new LimsError('common.internal');
    if (to !== intent['status']) await insertTransition(ctx, deps.newId?.() ?? uuidv7(), intent['id'], { from: intent['status'], to, cause: 'refund' });   // I10 / I11; I12 = version + 1 only
    return done;
  }

  return { check, apply };
}
