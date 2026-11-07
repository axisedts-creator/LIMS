// order_balances recompute + billing.balance.changed.v1 (02-TRD §6.2 "Balance:" + eligibility rules 1–6, §8.1; PRD US-FD-03.1; 05-SCHEMA order_balances guard).
// Runs in the caller's transaction (ctx.tx). balance_version = stored version + 1, written only when invoiced/paid/credited moved
// (the DB guard enforces the same), and exactly one event is published per write. Tenant and actor come from ctx only.
import { LimsError } from '../../../core/errors.js';
import { moneyOf, toPaisa } from '../domain/money/paisa.js';
import type { BillingEvents } from '../events/publish.js';
import { billingRepo } from '../repository/index.js';

export const BALANCE_CAUSES = ['invoice_issued', 'invoice_cancelled', 'payment_recorded', 'payment_reversed', 'credit_note_issued', 'gateway_payment_recorded'] as const;
export type BalanceCause = (typeof BALANCE_CAUSES)[number];
export type ReleaseBasis = 'paid_in_full' | 'zero_balance' | 'credit_party' | 'override' | 'policy_not_enforced' | 'due_outstanding' | 'no_invoice';
export type BalanceRepo = Pick<typeof billingRepo, 'readOrderTotals' | 'getOrderBalance' | 'upsertOrderBalance' | 'findActiveOverride'>;

export interface BalanceCtx {
  readonly tenantId: string;
  readonly requestId?: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly tx: unknown;
  readonly now: () => string;
  readonly ports?: { readonly IdentityPort?: { getTenantSettings(ctx: any, input: { keys: readonly string[] }): Promise<any> } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** TRD §6.2 eligibility, first match wins. `policyEnforced` is `releaseRequiresPayment !== false` (an unreadable policy is enforced: fail closed). */
export function decideRelease(i: {
  policyEnforced: boolean; billingMode: string; hasActiveOverride: boolean; issuedInvoiceCount: number;
  invoicedPaisa: number; paidPaisa: number; creditedPaisa: number;
}): { eligible: boolean; basis: ReleaseBasis } {
  if (!i.policyEnforced) return { eligible: true, basis: 'policy_not_enforced' };           // rule 1
  if (i.billingMode === 'credit') return { eligible: true, basis: 'credit_party' };         // rule 2
  if (i.hasActiveOverride) return { eligible: true, basis: 'override' };                    // rule 3
  if (i.issuedInvoiceCount === 0) return { eligible: false, basis: 'no_invoice' };          // rule 4
  const due = i.invoicedPaisa - i.creditedPaisa - i.paidPaisa;
  if (due <= 0) return { eligible: true, basis: i.paidPaisa > 0 ? 'paid_in_full' : 'zero_balance' }; // rule 5
  return { eligible: false, basis: 'due_outstanding' };                                     // rule 6
}

export async function releasePolicyEnforced(ctx: BalanceCtx): Promise<boolean> {
  const s = await ctx.ports?.IdentityPort?.getTenantSettings(ctx, { keys: ['releaseRequiresPayment'] });
  return s?.releaseRequiresPayment !== false;
}

export function createBalanceService(deps: { repo?: BalanceRepo; events: BillingEvents }) {
  const repo = deps.repo ?? billingRepo;

  /** Re-reads the four amounts. Unchanged -> no write, no event. Changed -> upsert (version + 1) and ONE balance.changed event. */
  async function applyChange(ctx: BalanceCtx, input: { orderId: string; cause: string }): Promise<{ changed: boolean; balanceVersion: number }> {
    if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
    const orderId = input?.orderId;
    const cause = input?.cause as BalanceCause;
    if (typeof orderId !== 'string' || !UUID.test(orderId) || !BALANCE_CAUSES.includes(cause)) throw new LimsError('common.validation_failed');
    const tx = ctx.tx as never;
    const tenantId = ctx.tenantId;

    const totals = await repo.readOrderTotals(tx, { tenantId, orderId });
    if (!totals) throw new LimsError('common.not_found');
    const invoiced = toPaisa(totals.invoiced_paisa);
    const paid = toPaisa(totals.paid_paisa);
    const credited = toPaisa(totals.credited_paisa);
    if (typeof totals.centre_id !== 'string' || (totals.billing_mode !== 'cash' && totals.billing_mode !== 'credit')) throw new LimsError('common.internal');

    const old = await repo.getOrderBalance(tx, { tenantId, orderId });
    if (old && toPaisa(old['invoiced_paisa']) === invoiced && toPaisa(old['paid_paisa']) === paid && toPaisa(old['credited_paisa']) === credited) {
      return { changed: false, balanceVersion: Number(old['balance_version']) };
    }
    const balanceVersion = (old ? Number(old['balance_version']) : 0) + 1;
    if (!Number.isSafeInteger(balanceVersion) || balanceVersion > 2147483647) throw new LimsError('common.internal');

    const policyEnforced = await releasePolicyEnforced(ctx);
    const hasActiveOverride = policyEnforced && totals.billing_mode !== 'credit'
      && (await repo.findActiveOverride(tx, { tenantId, orderId, at: ctx.now() })) !== undefined;
    const verdict = decideRelease({
      policyEnforced, billingMode: totals.billing_mode, hasActiveOverride, issuedInvoiceCount: Number(totals.issued_invoice_count),
      invoicedPaisa: invoiced, paidPaisa: paid, creditedPaisa: credited,
    });

    const written = await repo.upsertOrderBalance(tx, {
      tenantId, orderId, centreId: totals.centre_id, billingMode: totals.billing_mode, invoicedPaisa: invoiced, paidPaisa: paid, creditedPaisa: credited,
      balanceVersion, releaseBasis: verdict.basis, userId: ctx.actor.id,
    });
    // [CONV] optimistic concurrency: the repo applies the write only on top of version - 1; a concurrent writer won -> 409, the caller retries and re-reads.
    if (!written) throw new LimsError('common.version_conflict');
    await deps.events.balanceChanged(ctx as never, {
      order_id: orderId, balance_version: balanceVersion, invoiced: moneyOf(invoiced), paid: moneyOf(paid), credited: moneyOf(credited),
      balance_due: moneyOf(invoiced - credited - paid), cause, release_eligible: verdict.eligible, release_basis: verdict.basis,
    });
    return { changed: true, balanceVersion };
  }
  return { applyChange };
}
export type BalanceService = ReturnType<typeof createBalanceService>;
