// BillingCommandPort.recordPayment (02-TRD §5 B8, §6.3, §6.5, §12; PRD US-FD-08.1–.3, US-BL-11.2/.3; 07-SECURITY REQ-SEC-050/051/056; 08 A19 D-128).
// One caller transaction (ctx.tx). Order of work: shape validation -> order_balances lock -> idempotent replay -> order/invoice/method checks -> overpay rule
// -> cash session (manual only) -> RC number LAST -> ledger row -> balance recompute + billing.balance.changed.v1 -> activity. Any throw rolls everything back,
// the counter bump with it (gapless). Tenant and actor come from ctx only; a body can never attribute money to someone else.
import type { IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, isLimsError, type FieldError } from '../../../core/errors.js';
import { fiscalYearOf } from '../domain/fiscalYear.js';
import { formatDocumentNumber } from '../domain/numberFormat.js';
import { toPaisa } from '../domain/money/paisa.js';
import type { BillingEvents } from '../events/publish.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import { createBalanceService, type BalanceCtx } from './balance.service.js';
import { DEFAULT_TZ, ledgerEntryDto, localDate, names } from './ledgerDto.js';
import { iso, isRec, UTC_INSTANT, UUID } from './invoiceRead.service.js';

interface Counter { allocate(tx: never, input: { tenantId: string; series: string; fiscalYearBs: string; actorId: string; timezone?: string }): Promise<{ lastNo: number; allocatedAt: string }> }
type Npr = { amountPaisa: number; currency: 'NPR' };
const npr = (amountPaisa: number): Npr => ({ amountPaisa, currency: 'NPR' });

const CONTROL = /[\u0000-\u001f\u007f]/;
const CARD_DIGITS = /[0-9]{13,19}/; // ledger_entries__ref__ck (REQ-SEC-056): no card numbers, not even inside text

const invalid = (...errors: FieldError[]): LimsError => new LimsError('common.validation_failed', undefined, errors);
const fieldError = (path: string, message = 'Field invalid'): FieldError => ({ path, code: 'common.field_invalid', message });

interface PaymentInput {
  orderId: string; invoiceId?: string; methodCode: string; amountPaisa: number; reference?: string; captureKind: 'manual' | 'home_collection';
  idempotencyKey: string; collectedByMembershipId?: string; capturedAt?: string; issueReceiptNo: boolean;
}

function checkInput(raw: unknown): PaymentInput {
  if (!isRec(raw)) throw invalid(fieldError('/'));
  const errors: FieldError[] = [];
  const bad = (path: string, message?: string) => { errors.push(fieldError(path, message)); };
  const uuidAt = (k: string, required: boolean): string | undefined => {
    const v = raw[k];
    if (v === undefined && !required) return undefined;
    if (typeof v !== 'string' || !UUID.test(v)) { bad(`/${k}`); return undefined; }
    return v;
  };
  const orderId = uuidAt('orderId', true);
  const invoiceId = uuidAt('invoiceId', false);
  const collectedByMembershipId = uuidAt('collectedByMembershipId', false);
  const a = raw['amount'];
  const amountPaisa = isRec(a) && a['currency'] === 'NPR' && typeof a['amountPaisa'] === 'number' && Number.isSafeInteger(a['amountPaisa']) && a['amountPaisa'] >= 1 ? a['amountPaisa'] : undefined;
  if (amountPaisa === undefined) bad('/amount');
  const m = raw['methodCode'];
  if (typeof m !== 'string' || m.length < 1 || m.length > 64 || CONTROL.test(m)) bad('/methodCode');
  const kind = raw['captureKind']; // gateway money enters through recordGatewayPayment, never here
  if (kind !== 'manual' && kind !== 'home_collection') bad('/captureKind');
  const key = raw['idempotencyKey'];
  if (typeof key !== 'string' || key.length < 1 || key.length > 255 || CONTROL.test(key)) bad('/idempotencyKey');
  if (typeof raw['issueReceiptNo'] !== 'boolean') bad('/issueReceiptNo');
  let reference: string | undefined;
  if (raw['reference'] !== undefined) {
    const r = raw['reference'];
    const t = typeof r === 'string' ? r.trim() : undefined;
    if (t === undefined || t.length > 100 || CONTROL.test(t) || CARD_DIGITS.test(t)) bad('/reference', 'Reference invalid'); // never echo the value
    else if (t !== '') reference = t;
  }
  const at = raw['capturedAt'];
  if (at !== undefined && (typeof at !== 'string' || !UTC_INSTANT.test(at) || Number.isNaN(Date.parse(at)))) bad('/capturedAt');
  if (errors.length) throw invalid(...errors);
  return {
    orderId: orderId!, ...(invoiceId === undefined ? {} : { invoiceId }), methodCode: m as string, amountPaisa: amountPaisa!, ...(reference === undefined ? {} : { reference }),
    captureKind: kind as PaymentInput['captureKind'], idempotencyKey: key as string, ...(collectedByMembershipId === undefined ? {} : { collectedByMembershipId }),
    ...(at === undefined ? {} : { capturedAt: at as string }), issueReceiptNo: raw['issueReceiptNo'] as boolean,
  };
}

export function createLedgerService(deps: { repo?: BillingRepo; counter: Counter; events: BillingEvents }) {
  const repo = deps.repo ?? billingRepo;
  const balance = createBalanceService({ repo, events: deps.events });

  async function recordPayment(ctx: BalanceCtx, rawInput: unknown) {
    if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
    const i = checkInput(rawInput);
    const tx = ctx.tx as never;
    const { tenantId } = ctx;
    const actorId = ctx.actor.id;
    const manual = i.captureKind === 'manual';
    // manual: the cashier is the actor, whatever the body says. home_collection: the named collector, else the actor.
    const collector = manual ? ctx.actor.membershipId : i.collectedByMembershipId ?? ctx.actor.membershipId;
    if (collector === undefined) throw invalid(fieldError('/collectedByMembershipId', 'No collector'));
    const nowIso = ctx.now();

    // TRD §12: order_balances first. Taking it before the replay lookup also makes two concurrent calls with one key serialize: the second one replays.
    await repo.lockOrderBalance(tx, { tenantId, orderId: i.orderId });
    const prior = await repo.findLedgerByIdempotencyKey(tx, { tenantId, idempotencyKey: i.idempotencyKey });
    const totals = await repo.readOrderTotals(tx, { tenantId, orderId: i.orderId });
    if (prior) {
      if (prior['order_id'] !== i.orderId || prior['method_code'] !== i.methodCode || toPaisa(prior['amount_paisa']) !== i.amountPaisa) throw new LimsError('common.idempotency_key_reused');
      const bal = await repo.getOrderBalance(tx, { tenantId, orderId: i.orderId });
      if (!totals || !bal) throw new LimsError('common.internal');
      const due = toPaisa(totals.invoiced_paisa) - toPaisa(totals.credited_paisa) - toPaisa(totals.paid_paisa);
      const display = await names(ctx, [prior['collected_by_membership_id']]);
      return {
        ledgerEntryId: String(prior['id']), ...(typeof prior['receipt_no'] === 'string' ? { receiptNo: prior['receipt_no'] } : {}), duplicate: true, exceedsDue: prior['capture_kind'] === 'home_collection' && due < 0,
        balance: balanceOf(i.orderId, totals, toPaisa(totals.paid_paisa), Number(bal['balance_version']), bal['updated_at'] ? iso(bal['updated_at']) : nowIso),
        entry: ledgerEntryDto(prior, display),
      };
    }

    // ---- order / invoice / method ----
    // No billing rows yet: ask C6 whether the order exists for this tenant (07-SECURITY §6.1: invisible id -> 404 common.not_found, never order_not_invoiced).
    // [CONV] ctx without a FrontdeskPort (BL-T08 unit world) keeps the pre-BL-T22 answer; production ctx always carries the port.
    const fd = (ctx.ports as Record<string, unknown> | undefined)?.['FrontdeskPort'] as { getOrderSummary(c: unknown, a: { orderId: string }): Promise<{ billingMode?: string }> } | undefined;
    if (!totals && fd) {
      const summary = await fd.getOrderSummary(ctx, { orderId: i.orderId });   // rejects common.not_found when not visible
      if (summary?.billingMode === 'credit') throw invalid(fieldError('/orderId', 'Credit orders are paid by the credit party'));
    }
    if (!totals ||typeof totals.branch_id !== 'string' || typeof totals.centre_id !== 'string') throw new LimsError(manual ? 'billing.order_not_invoiced' : 'common.not_found');
    if (totals.billing_mode === 'credit') throw invalid(fieldError('/orderId', 'Credit orders are paid by the credit party'));
    if (manual && Number(totals.issued_invoice_count) === 0) throw new LimsError('billing.order_not_invoiced');
    if (i.invoiceId !== undefined) {
      const inv = await repo.findInvoiceForPayment(tx, { tenantId, invoiceId: i.invoiceId });
      if (!inv || inv.order_id !== i.orderId) throw invalid(fieldError('/invoiceId')); // id swap: another order's / unknown invoice
    }
    // D-128: a home collection is money already taken - never rejected for its method or its amount.
    const method = await repo.getPaymentMethod(tx, { tenantId, code: i.methodCode });
    if (manual) {
      if (!method || method.is_active !== true) throw invalid(fieldError('/methodCode'));
      if (method.requires_reference && i.reference === undefined) throw invalid(fieldError('/reference', 'Reference required'));
    }
    const invoiced = toPaisa(totals.invoiced_paisa), paid = toPaisa(totals.paid_paisa), credited = toPaisa(totals.credited_paisa);
    const exceedsDue = i.amountPaisa > invoiced - credited - paid;
    if (manual && exceedsDue) throw new LimsError('billing.payment_exceeds_due');

    // ---- fiscal year, business date, receipt pattern (fail closed before anything is written) ----
    const idp = ctx.ports?.IdentityPort;
    if (!idp) throw new LimsError('common.internal');
    const tenant = await idp.getTenantSettings(ctx, { keys: ['numbering', 'timezone'] });
    const timezone: string = typeof tenant?.timezone === 'string' ? tenant.timezone : DEFAULT_TZ;
    const fy = fiscalYearOf(nowIso as IsoUtc, timezone);
    const businessDate = localDate(nowIso, timezone);
    let pattern: string | undefined;
    if (i.issueReceiptNo && (await repo.getBillingSettings(tx, { tenantId }))?.['receipt_no_enabled'] !== false) {
      const p = tenant?.numbering?.receiptNoPattern;
      if (typeof p !== 'string') throw new LimsError('billing.numbering_pattern_invalid');
      try { formatDocumentNumber(p, { fy, seq: 1 }); } // dry run, so a broken pattern consumes no number
      catch (e) { throw isLimsError(e, 'common.validation_failed') ? new LimsError('billing.numbering_pattern_invalid') : e; }
      pattern = p;
    }

    // ---- cash session: manual payments only (home_collection and B22 have none) ----
    let cashSessionId: string | null = null;
    if (manual) {
      const find = () => repo.findOpenCashSession(tx, { tenantId, membershipId: collector, centreId: totals.centre_id! });
      const session = (await find())
        ?? (await repo.insertCashSession(tx, { id: uuidv7(), tenantId, branchId: totals.branch_id, centreId: totals.centre_id, membershipId: collector, openedAt: nowIso, userId: actorId }))
        ?? (await find()); // a concurrent open won the partial unique index
      if (!session) throw new LimsError('common.internal');
      cashSessionId = String(session['id']);
    }

    // ---- allocation LAST: the ledger insert is the next repo call (TRD §12) ----
    const ledgerId = uuidv7();
    let receiptNo: string | undefined;
    let receiptSeq: number | undefined;
    if (pattern !== undefined) {
      const { lastNo } = await deps.counter.allocate(tx, { tenantId, series: 'RC', fiscalYearBs: fy.long, actorId, timezone });
      receiptSeq = lastNo;
      receiptNo = formatDocumentNumber(pattern, { fy, seq: lastNo });
    }
    const row = await repo.insertLedgerEntry(tx, {
      id: ledgerId, tenantId, branchId: totals.branch_id, centreId: totals.centre_id, orderId: i.orderId, invoiceId: i.invoiceId ?? null, entryKind: 'payment', captureKind: i.captureKind,
      methodCode: i.methodCode, amountPaisa: i.amountPaisa, fiscalYearBs: fy.long, businessDate, collectedByMembershipId: collector, userId: actorId, idempotencyKey: i.idempotencyKey,
      receiptNo: receiptNo ?? null, receiptSeq: receiptSeq ?? null, cashSessionId, referenceText: i.reference ?? null, capturedAtDevice: i.capturedAt ?? null,
    });
    if (!row) throw new LimsError('common.internal');

    const applied = await balance.applyChange(ctx, { orderId: i.orderId, cause: 'payment_recorded' });
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: totals.centre_id, action: 'payment_recorded', document_kind: 'ledger_entry', document_id: ledgerId, document_no: receiptNo ?? null,
      actor_id: actorId, actor_membership_id: ctx.actor.membershipId ?? null, actor_type: ctx.actor.type, occurred_at: nowIso, request_id: ctx.requestId ?? null,
      details: { order_id: i.orderId, method_code: i.methodCode, capture_kind: i.captureKind, amount_paisa: i.amountPaisa, exceeds_due: exceedsDue }, created_by: actorId, // never the reference text
    });
    const display = await names(ctx, [collector]);
    return {
      ledgerEntryId: ledgerId, ...(receiptNo === undefined ? {} : { receiptNo }), duplicate: false, exceedsDue,
      balance: balanceOf(i.orderId, totals, paid + i.amountPaisa, applied.balanceVersion, nowIso),
      entry: ledgerEntryDto(row, display),
    };
  }

  /**
   * B9 reverseLedgerEntry (TRD §5 B9, §6.5 "Reversal"; PRD US-BL-06.1; REQ-SEC-057). One new signed row that copies the original's capture fields (billing.ledger_reversal_guard
   * checks the same list); the original is never touched. Order: validate -> load original -> lock order_balances -> replay -> kind / already-reversed checks -> session -> insert ->
   * balance recompute -> activity. The reverser (ctx membership) is the approver; no receipt number is consumed.
   */
  async function reverseEntry(ctx: BalanceCtx, rawInput: unknown) {
    if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
    const reverser = ctx.actor.membershipId;
    if (reverser === undefined) throw new LimsError('auth.forbidden');
    const i = checkReverse(rawInput);
    const tx = ctx.tx as never;
    const { tenantId } = ctx;
    const actorId = ctx.actor.id;
    const nowIso = ctx.now();

    const orig = await repo.getLedgerEntry(tx, { tenantId, entryId: i.ledgerEntryId });
    if (!orig) throw new LimsError('common.not_found');
    // ponytail: order-less rows (credit-party payments, B22) have no order_balances row to lock or recompute; refused until their reversal is specified.
    if (typeof orig['order_id'] !== 'string') throw new LimsError('billing.ledger_reversal_invalid');
    const orderId = orig['order_id'];
    await repo.lockOrderBalance(tx, { tenantId, orderId });

    const prior = await repo.findLedgerByIdempotencyKey(tx, { tenantId, idempotencyKey: i.idempotencyKey });
    const totals = await repo.readOrderTotals(tx, { tenantId, orderId });
    if (!totals) throw new LimsError('common.internal');
    if (prior) {
      if (prior['reverses_entry_id'] !== i.ledgerEntryId) throw new LimsError('common.idempotency_key_reused');
      const bal = await repo.getOrderBalance(tx, { tenantId, orderId });
      if (!bal) throw new LimsError('common.internal');
      const display = await names(ctx, [prior['collected_by_membership_id']]);
      return {
        duplicate: true, entry: ledgerEntryDto(prior, display),
        balance: balanceOf(orderId, totals, toPaisa(totals.paid_paisa), Number(bal['balance_version']), bal['updated_at'] ? iso(bal['updated_at']) : nowIso),
      };
    }
    if (orig['entry_kind'] !== 'payment' || (await repo.findReversalOf(tx, { tenantId, entryId: i.ledgerEntryId }))) throw new LimsError('billing.ledger_reversal_invalid');

    // cash session (TRD §6.5): the original's while it is still open, else the reverser's open session at the original's centre, else none. A reversal never opens one.
    const centreId = typeof orig['centre_id'] === 'string' ? orig['centre_id'] : null;
    let cashSessionId: string | null = null;
    const origSession = typeof orig['cash_session_id'] === 'string' ? await repo.getCashSession(tx, { tenantId, sessionId: orig['cash_session_id'] }) : undefined;
    if (origSession?.['status'] === 'open') cashSessionId = String(origSession['id']);
    else if (centreId !== null) {
      const mine = await repo.findOpenCashSession(tx, { tenantId, membershipId: reverser, centreId });
      if (mine) cashSessionId = String(mine['id']);
    }

    const idp = ctx.ports?.IdentityPort;
    if (!idp) throw new LimsError('common.internal');
    const tenant = await idp.getTenantSettings(ctx, { keys: ['timezone'] });
    const timezone: string = typeof tenant?.timezone === 'string' ? tenant.timezone : DEFAULT_TZ;
    const fy = fiscalYearOf(nowIso as IsoUtc, timezone);

    const amount = -toPaisa(orig['amount_paisa']);
    const ledgerId = uuidv7();
    let row: Record<string, unknown> | undefined;
    try {
      row = await repo.insertLedgerEntry(tx, {
        id: ledgerId, tenantId, branchId: String(orig['branch_id']), centreId, orderId, invoiceId: strOrNull(orig['invoice_id']), creditPartyId: strOrNull(orig['credit_party_id']),
        entryKind: 'reversal', captureKind: orig['capture_kind'] as 'manual' | 'gateway' | 'home_collection', methodCode: String(orig['method_code']), amountPaisa: amount,
        gateway: strOrNull(orig['gateway']), gatewayTxnRef: strOrNull(orig['gateway_txn_ref']), intentId: strOrNull(orig['intent_id']),
        collectedByMembershipId: strOrNull(orig['collected_by_membership_id']), approvedByMembershipId: reverser, reversesEntryId: i.ledgerEntryId,
        reasonCode: i.reasonCode, reasonText: i.reasonText ?? null, fiscalYearBs: fy.long, businessDate: localDate(nowIso, timezone), cashSessionId, userId: actorId, idempotencyKey: i.idempotencyKey,
      });
    } catch (e) {
      throw reversalRace(e) ? new LimsError('billing.ledger_reversal_invalid') : e; // a lost race on the unique index, or the DB guard refusing a stale copy
    }
    if (!row) throw new LimsError('common.internal');

    const applied = await balance.applyChange(ctx, { orderId, cause: 'payment_reversed' });
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: centreId, action: 'payment_reversed', document_kind: 'ledger_entry', document_id: ledgerId, document_no: null,
      actor_id: actorId, actor_membership_id: reverser, actor_type: ctx.actor.type, occurred_at: nowIso, request_id: ctx.requestId ?? null,
      details: { order_id: orderId, reverses_entry_id: i.ledgerEntryId, amount_paisa: amount, reason_code: i.reasonCode }, created_by: actorId, // never the free reason text
    });
    const display = await names(ctx, [orig['collected_by_membership_id']]);
    return {
      duplicate: false, entry: ledgerEntryDto(row, display),
      balance: balanceOf(orderId, totals, toPaisa(totals.paid_paisa) + amount, applied.balanceVersion, nowIso),
    };
  }
  return { recordPayment, reverseEntry };
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function checkReverse(raw: unknown): { ledgerEntryId: string; reasonCode: string; reasonText?: string; idempotencyKey: string } {
  if (!isRec(raw)) throw invalid(fieldError('/'));
  const errors: FieldError[] = [];
  const bad = (path: string) => { errors.push(fieldError(path)); };
  const id = raw['ledgerEntryId'];
  if (typeof id !== 'string' || !UUID.test(id)) bad('/ledgerEntryId');
  const code = raw['reasonCode'];
  if (typeof code !== 'string' || code.length < 1 || code.length > 64 || CONTROL.test(code)) bad('/reasonCode');
  const text = raw['reasonText'];
  if (text !== undefined && (typeof text !== 'string' || text.length > 500)) bad('/reasonText');
  const key = raw['idempotencyKey'];
  if (typeof key !== 'string' || key.length < 1 || key.length > 255 || CONTROL.test(key)) bad('/idempotencyKey');
  if (errors.length) throw invalid(...errors);
  return { ledgerEntryId: id as string, reasonCode: code as string, ...(text === undefined ? {} : { reasonText: text as string }), idempotencyKey: key as string };
}

/** 23505 on ledger_entries__tenant_id_reverses__p_uq, or the guard's P0001 reversal_mismatch. */
function reversalRace(e: unknown): boolean {
  const x = e as { code?: unknown; message?: unknown; constraint?: unknown } | null;
  const text = `${String(x?.constraint ?? '')} ${String(x?.message ?? '')}`;
  return (x?.code === '23505' && text.includes('reverses')) || (x?.code === 'P0001' && text.includes('reversal_mismatch'));
}
export type LedgerService = ReturnType<typeof createLedgerService>;

function balanceOf(orderId: string, t: { invoiced_paisa: string; credited_paisa: string }, paid: number, balanceVersion: number, asOf: string) {
  const invoiced = toPaisa(t.invoiced_paisa), credited = toPaisa(t.credited_paisa);
  return { orderId, invoiced: npr(invoiced), paid: npr(paid), credited: npr(credited), balanceDue: npr(invoiced - credited - paid), balanceVersion, asOf };
}
