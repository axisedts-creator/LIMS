// BillingPort implementation (02-TRD §6.3, 03-IC §4.4; 08 CR-C15-002; PRD US-BL-07.1, US-BL-08.1/.3; 07-SECURITY REQ-SEC-050/051/057).
// Every method runs in the caller's transaction (ctx.tx): no transaction of its own. The FIRST thing each method does is the actor-type guard (staff user or system,
// else auth.forbidden - before any validation, port or repo call). Tenant and actor come from ctx only. Gateway money is never attributed to a person:
// capture_kind 'gateway' rows carry no collector (ledger_entries__collector__ck, 08 R8), no cash session and no receipt number.
// Ordering rule: any check that can refuse runs before any write. Lock order (TRD §12): order_balances first, then the replay lookup, then the insert.
import type { BillingPortV1, OrderBalance } from '../../../../../../contracts/ports/BillingPort.js';
import type { IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { createEvents } from '../../../core/events/publish.js';
import { fiscalYearOf } from '../domain/fiscalYear.js';
import { toPaisa } from '../domain/money/paisa.js';
import { createBillingEvents, type BillingEvents } from '../events/publish.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import { createBalanceService } from '../service/balance.service.js';
import { isRec, UTC_INSTANT, UUID } from '../service/invoiceRead.service.js';
import { DEFAULT_TZ, localDate } from '../service/ledgerDto.js';
import { createReleaseService, loadOrder, npr, session, type ReleaseCtx } from '../service/release.service.js';

const GATEWAYS = ['esewa', 'khalti', 'fonepay'] as const;
type Gateway = (typeof GATEWAYS)[number];
const CONTROL = /[\u0000-\u001f\u007f]/;
const invalid = (...paths: string[]): LimsError => new LimsError('common.validation_failed', undefined, paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));

/** Allowed to call the port: a staff user or the system. patient / portal / partner / device never. */
function guard(ctx: ReleaseCtx): void {
  const t = (ctx as { actor?: { type?: unknown } } | undefined)?.actor?.type;
  if (t !== 'user' && t !== 'system') throw new LimsError('auth.forbidden');
}

const uuidAt = (raw: Record<string, any>, k: string, required: boolean, bad: string[]): string | undefined => {
  const v = raw[k];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || !UUID.test(v)) { bad.push(`/${k}`); return undefined; }
  return v;
};
const strAt = (raw: Record<string, any>, k: string, max: number, bad: string[]): string => {
  const v = raw[k];
  if (typeof v !== 'string' || v.length < 1 || v.length > max || CONTROL.test(v)) { bad.push(`/${k}`); return ''; }
  return v;
};
const instantAt = (raw: Record<string, any>, k: string, bad: string[]): string => {
  const v = raw[k];
  if (typeof v !== 'string' || !UTC_INSTANT.test(v) || Number.isNaN(Date.parse(v))) { bad.push(`/${k}`); return ''; }
  return v;
};
const amountAt = (raw: Record<string, any>, bad: string[]): number => {
  const a = raw['amount'];
  if (isRec(a) && a['currency'] === 'NPR' && typeof a['amountPaisa'] === 'number' && Number.isSafeInteger(a['amountPaisa']) && a['amountPaisa'] >= 1) return a['amountPaisa'];
  bad.push('/amount'); return 0;
};
const gatewayAt = (raw: Record<string, any>, bad: string[]): Gateway => {
  const g = raw['gateway'];
  if (!GATEWAYS.includes(g)) { bad.push('/gateway'); return 'esewa'; }
  return g as Gateway;
};

function checkPayment(raw: unknown) {
  if (!isRec(raw)) throw invalid('/');
  const bad: string[] = [];
  const v = {
    intentId: uuidAt(raw, 'intentId', true, bad)!, orderId: uuidAt(raw, 'orderId', true, bad)!, invoiceId: uuidAt(raw, 'invoiceId', false, bad), gateway: gatewayAt(raw, bad),
    gatewayTxnRef: strAt(raw, 'gatewayTxnRef', 255, bad), amountPaisa: amountAt(raw, bad), verifiedAt: instantAt(raw, 'verifiedAt', bad),
    allowExceedsDue: raw['allowExceedsDue'] === undefined ? false : raw['allowExceedsDue'],
  };
  if (typeof v.allowExceedsDue !== 'boolean') bad.push('/allowExceedsDue');
  if (bad.length) throw invalid(...bad);
  return v as typeof v & { allowExceedsDue: boolean };
}
function checkRefund(raw: unknown) {
  if (!isRec(raw)) throw invalid('/');
  const bad: string[] = [];
  const v = {
    refundId: uuidAt(raw, 'refundId', true, bad)!, intentId: uuidAt(raw, 'intentId', true, bad)!, orderId: uuidAt(raw, 'orderId', true, bad)!, gateway: gatewayAt(raw, bad),
    gatewayTxnRef: strAt(raw, 'gatewayTxnRef', 255, bad), amountPaisa: amountAt(raw, bad), reasonCode: strAt(raw, 'reasonCode', 64, bad),
    approvedByMembershipId: uuidAt(raw, 'approvedByMembershipId', true, bad)!, refundedAt: instantAt(raw, 'refundedAt', bad),
  };
  if (bad.length) throw invalid(...bad);
  return v;
}

/** 23505 on the gateway unique index / the refund idempotency key: a concurrent writer committed first. */
const lostRace = (e: unknown): boolean => {
  const x = e as { code?: unknown; message?: unknown; constraint?: unknown } | null;
  return x?.code === '23505' && /gateway_txn|idem/.test(`${String(x.constraint ?? '')} ${String(x.message ?? '')}`);
};

export function createBillingPort(deps: { repo?: BillingRepo; events: BillingEvents }): BillingPortV1 {
  const repo = deps.repo ?? billingRepo;
  const balance = createBalanceService({ repo, events: deps.events });
  const release = createReleaseService({ repo });

  const balanceOf = (orderId: string, t: { invoiced_paisa: unknown; credited_paisa: unknown }, paid: number, balanceVersion: number, asOf: string): OrderBalance => {
    const invoiced = toPaisa(t.invoiced_paisa), credited = toPaisa(t.credited_paisa);
    return { orderId, invoiced: npr(invoiced), paid: npr(paid), credited: npr(credited), balanceDue: npr(invoiced - credited - paid), balanceVersion, asOf: asOf as IsoUtc } as OrderBalance;
  };
  /** The stored result of an earlier write: the current balance of the row's order. */
  async function replay(ctx: ReleaseCtx, prior: Record<string, unknown>) {
    const { tenantId, tx } = session(ctx);
    const orderId = String(prior['order_id']);
    const totals = await repo.readOrderTotals(tx, { tenantId, orderId });
    const bal = await repo.getOrderBalance(tx, { tenantId, orderId });
    if (!totals || !bal) throw new LimsError('common.internal');
    return { ledgerEntryId: String(prior['id']), duplicate: true, balance: balanceOf(orderId, totals, toPaisa(totals.paid_paisa), Number(bal['balance_version']), ctx.now()) };
  }
  /** Insert in a savepoint (when the tx has one) so a lost unique race does not abort the caller's transaction. */
  async function insertLedger(ctx: ReleaseCtx, row: Parameters<BillingRepo['insertLedgerEntry']>[1]) {
    const tx = session(ctx).tx as { savepoint?: (fn: (s: never) => Promise<unknown>) => Promise<unknown> };
    const out = (typeof tx.savepoint === 'function' ? await tx.savepoint((s) => repo.insertLedgerEntry(s, row)) : await repo.insertLedgerEntry(tx as never, row)) as Record<string, unknown> | undefined;
    if (!out) throw new LimsError('common.internal');
    return out;
  }
  async function fiscal(ctx: ReleaseCtx, nowIso: string) {
    const idp = ctx.ports?.['IdentityPort'];
    if (!idp) throw new LimsError('common.internal');
    const tenant = await idp.getTenantSettings(ctx, { keys: ['timezone'] });
    const timezone: string = typeof tenant?.timezone === 'string' ? tenant.timezone : DEFAULT_TZ;
    return { fy: fiscalYearOf(nowIso as IsoUtc, timezone), businessDate: localDate(nowIso, timezone) };
  }

  async function recordGatewayPayment(ctx: ReleaseCtx, rawInput: unknown) {
    guard(ctx);
    const { tenantId, tx } = session(ctx);
    const i = checkPayment(rawInput);
    const { summary } = await loadOrder(ctx, i.orderId);
    const actorId = ctx.actor.id;
    const nowIso = ctx.now();

    await repo.lockOrderBalance(tx, { tenantId, orderId: i.orderId });
    // (a) replay: the stored row wins, whatever amount the retry carries (A14)
    const prior = await repo.findGatewayPayment(tx, { tenantId, gateway: i.gateway, gatewayTxnRef: i.gatewayTxnRef });
    if (prior) {
      if (prior['order_id'] !== i.orderId || prior['intent_id'] !== i.intentId) throw new LimsError('common.idempotency_key_reused');
      return replay(ctx, prior);
    }
    const totals = await repo.readOrderTotals(tx, { tenantId, orderId: i.orderId });
    if (!totals) throw new LimsError('common.not_found');
    const branchId = totals.branch_id ?? summary.branchId, centreId = totals.centre_id ?? summary.centreId;
    if (typeof branchId !== 'string' || typeof centreId !== 'string') throw new LimsError('common.internal');
    if (i.invoiceId !== undefined) {
      const inv = await repo.findInvoiceForPayment(tx, { tenantId, invoiceId: i.invoiceId });
      if (!inv || inv.order_id !== i.orderId) throw invalid('/invoiceId');   // id swap: another order's / unknown invoice
    }
    // (b) the intent ref (B12) is authoritative for amount and order; intents created by C16 have none
    const ref = await repo.getPaymentIntentRef(tx, { tenantId, intentId: i.intentId });
    if (ref) {
      if (ref['order_id'] !== i.orderId) throw invalid('/intentId');
      if (toPaisa(ref['amount_paisa']) !== i.amountPaisa) throw new LimsError('billing.amount_mismatch');
    }
    // (c) overpayment
    const paid = toPaisa(totals.paid_paisa), due = toPaisa(totals.invoiced_paisa) - toPaisa(totals.credited_paisa) - paid;
    const exceeds = i.amountPaisa > due;
    if (exceeds && !i.allowExceedsDue) throw new LimsError('billing.payment_exceeds_due');
    const { fy, businessDate } = await fiscal(ctx, nowIso);

    // (d) the ledger row: no collector, no cash session, no receipt
    const ledgerId = uuidv7();
    try {
      await insertLedger(ctx, {
        id: ledgerId, tenantId, branchId, centreId, orderId: i.orderId, invoiceId: i.invoiceId ?? null, entryKind: 'payment', captureKind: 'gateway', methodCode: i.gateway,
        amountPaisa: i.amountPaisa, fiscalYearBs: fy.long, businessDate, collectedByMembershipId: null, userId: actorId, gateway: i.gateway, gatewayTxnRef: i.gatewayTxnRef, intentId: i.intentId,
      });
    } catch (e) {
      if (!lostRace(e)) throw e;
      const winner = await repo.findGatewayPayment(tx, { tenantId, gateway: i.gateway, gatewayTxnRef: i.gatewayTxnRef });
      if (!winner) throw e;
      return replay(ctx, winner);
    }
    const applied = await balance.applyChange(ctx, { orderId: i.orderId, cause: 'gateway_payment_recorded' });
    if (exceeds) {
      await repo.insertFinanceReviewItem(tx, { id: uuidv7(), tenantId, centreId, orderId: i.orderId, kind: 'gateway_payment_exceeds_due', ledgerEntryId: ledgerId, amountPaisa: i.amountPaisa - Math.max(due, 0), userId: actorId });
    }
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: centreId, action: 'payment_recorded', document_kind: 'ledger_entry', document_id: ledgerId, document_no: null,
      actor_id: actorId, actor_membership_id: ctx.actor.membershipId ?? null, actor_type: ctx.actor.type, occurred_at: nowIso, request_id: ctx.requestId ?? null,
      details: { order_id: i.orderId, method_code: i.gateway, capture_kind: 'gateway', amount_paisa: i.amountPaisa, exceeds_due: exceeds }, created_by: actorId,
    });
    return { ledgerEntryId: ledgerId, duplicate: false, balance: balanceOf(i.orderId, totals, paid + i.amountPaisa, applied.balanceVersion, nowIso) };
  }

  async function recordGatewayRefund(ctx: ReleaseCtx, rawInput: unknown) {
    guard(ctx);
    const { tenantId, tx } = session(ctx);
    const i = checkRefund(rawInput);
    const { summary } = await loadOrder(ctx, i.orderId);
    const actorId = ctx.actor.id;
    const nowIso = ctx.now();
    const idempotencyKey = `gw_refund:${i.refundId}`;

    await repo.lockOrderBalance(tx, { tenantId, orderId: i.orderId });
    const prior = await repo.findLedgerByIdempotencyKey(tx, { tenantId, idempotencyKey });   // replay is checked before the refundable arithmetic
    if (prior) {
      if (prior['order_id'] !== i.orderId || prior['entry_kind'] !== 'refund') throw new LimsError('common.idempotency_key_reused');
      return replay(ctx, prior);
    }
    const totals = await repo.readOrderTotals(tx, { tenantId, orderId: i.orderId });
    if (!totals) throw new LimsError('common.not_found');
    const branchId = totals.branch_id ?? summary.branchId, centreId = totals.centre_id ?? summary.centreId;
    if (typeof branchId !== 'string' || typeof centreId !== 'string') throw new LimsError('common.internal');
    // refundable = gateway payments of the intent - earlier gateway refunds of it
    const ref = await repo.getPaymentIntentRef(tx, { tenantId, intentId: i.intentId });
    if (ref && ref['order_id'] !== i.orderId) throw new LimsError('billing.ledger_reversal_invalid');
    const sums = await repo.sumGatewayByIntent(tx, { tenantId, intentId: i.intentId });
    if (toPaisa(sums.payments_paisa) <= 0 || i.amountPaisa > toPaisa(sums.payments_paisa) - toPaisa(sums.refunds_paisa)) throw new LimsError('billing.ledger_reversal_invalid');
    const { fy, businessDate } = await fiscal(ctx, nowIso);

    const ledgerId = uuidv7();
    try {
      await insertLedger(ctx, {
        id: ledgerId, tenantId, branchId, centreId, orderId: i.orderId, invoiceId: null, entryKind: 'refund', captureKind: 'gateway', methodCode: i.gateway, amountPaisa: -i.amountPaisa,
        fiscalYearBs: fy.long, businessDate, collectedByMembershipId: null, userId: actorId, gateway: i.gateway, gatewayTxnRef: i.gatewayTxnRef, intentId: i.intentId,
        approvedByMembershipId: i.approvedByMembershipId, reasonCode: i.reasonCode, idempotencyKey,
      });
    } catch (e) {
      if (!lostRace(e)) throw e;
      const winner = await repo.findLedgerByIdempotencyKey(tx, { tenantId, idempotencyKey });
      if (!winner) throw e;
      return replay(ctx, winner);
    }
    const applied = await balance.applyChange(ctx, { orderId: i.orderId, cause: 'payment_reversed' });
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: centreId, action: 'refund_recorded', document_kind: 'ledger_entry', document_id: ledgerId, document_no: null,
      actor_id: actorId, actor_membership_id: ctx.actor.membershipId ?? null, actor_type: ctx.actor.type, occurred_at: nowIso, request_id: ctx.requestId ?? null,
      details: { order_id: i.orderId, method_code: i.gateway, capture_kind: 'gateway', amount_paisa: -i.amountPaisa, reason_code: i.reasonCode }, created_by: actorId,
    });
    return { ledgerEntryId: ledgerId, duplicate: false, balance: balanceOf(i.orderId, totals, toPaisa(totals.paid_paisa) - i.amountPaisa, applied.balanceVersion, nowIso) };
  }

  async function getOrderBalance(ctx: ReleaseCtx, input: unknown): Promise<OrderBalance> {
    guard(ctx);
    const { tenantId, tx } = session(ctx);
    const { orderId } = await loadOrder(ctx, isRec(input) ? input['orderId'] : undefined);
    const totals = await repo.readOrderTotals(tx, { tenantId, orderId });
    const bal = await repo.getOrderBalance(tx, { tenantId, orderId });
    return balanceOf(orderId, totals ?? { invoiced_paisa: '0', credited_paisa: '0' }, totals ? toPaisa(totals.paid_paisa) : 0, bal ? Number(bal['balance_version']) : 0, ctx.now());
  }

  return {
    getReleaseEligibility: (async (ctx: ReleaseCtx, input: unknown) => { guard(ctx); return release.getEligibility(ctx, input); }) as BillingPortV1['getReleaseEligibility'],
    recordGatewayPayment: recordGatewayPayment as BillingPortV1['recordGatewayPayment'],
    getOrderBalance: getOrderBalance as BillingPortV1['getOrderBalance'],
    recordGatewayRefund: recordGatewayRefund as BillingPortV1['recordGatewayRefund'],
  };
}

/** Production wiring for the manifest: real core event publisher, built on first use (no I/O at import time). */
let built: BillingPortV1 | undefined;
const real = (): BillingPortV1 => (built ??= createBillingPort({ events: createBillingEvents(createEvents({ producer: 'billing' }) as never) }));
export const billingPort: BillingPortV1 = {
  getReleaseEligibility: (c, i) => real().getReleaseEligibility(c, i),
  recordGatewayPayment: (c, i) => real().recordGatewayPayment(c, i),
  getOrderBalance: (c, i) => real().getOrderBalance(c, i),
  recordGatewayRefund: (c, i) => real().recordGatewayRefund(c, i),
};
