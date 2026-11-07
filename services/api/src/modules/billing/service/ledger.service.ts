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
    if (!totals || typeof totals.branch_id !== 'string' || typeof totals.centre_id !== 'string') throw new LimsError(manual ? 'billing.order_not_invoiced' : 'common.not_found');
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
  return { recordPayment };
}
export type LedgerService = ReturnType<typeof createLedgerService>;

function balanceOf(orderId: string, t: { invoiced_paisa: string; credited_paisa: string }, paid: number, balanceVersion: number, asOf: string) {
  const invoiced = toPaisa(t.invoiced_paisa), credited = toPaisa(t.credited_paisa);
  return { orderId, invoiced: npr(invoiced), paid: npr(paid), credited: npr(credited), balanceDue: npr(invoiced - credited - paid), balanceVersion, asOf };
}
