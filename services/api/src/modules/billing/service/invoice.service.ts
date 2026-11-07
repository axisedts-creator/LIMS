// BillingCommandPort.issueOrderInvoice (02-TRD §6.3, §12; PRD US-BL-01.1–.5, US-BL-13.1/.3, US-FD-03.1/.4/.5; 03-APP-FLOW state `issued`).
// One caller transaction (ctx.tx): fingerprint check -> number allocation LAST (no repo call between it and the invoice insert) -> invoice + lines
// -> activity -> CBMS job -> billing.invoice.issued.v1 -> balance recompute + billing.balance.changed.v1. Any throw rolls everything back,
// the counter bump with it (gapless, D-25); this service never retries. Tenant and actor come from ctx only.
//
// LD-25 (2026-11-07, A33-2 downtime mode, BL-T06): `entry` = { mode: 'live' | 'downtime_backentry', occurredAt?, downtimeRef? }. Back-entry needs
// occurredAt (<= now, >= now - downtime_backentry_max_hours, tenant setting, default 72) and downtimeRef (paper serial, <= 32 characters). Both are
// audited in the activity row only; issued_at, invoice_date_bs and created_at stay server values, and neither value reaches an event or the CBMS job.
import type { IssuedInvoiceRef } from '../../../../../../contracts/ports/BillingCommandPort.js';
import type { IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { formatBs, instantToBs } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, isLimsError, type FieldError } from '../../../core/errors.js';
import { splitCredit, type Parts } from '../domain/creditSplit.js';
import { fiscalYearOf } from '../domain/fiscalYear.js';
import { formatDocumentNumber, seriesKey, type SeriesScope } from '../domain/numberFormat.js';
import { moneyOf, toPaisa } from '../domain/money/paisa.js';
import type { BillingEvents } from '../events/publish.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import { createBalanceService } from './balance.service.js';
import { computeQuote } from './quote.service.js';

export interface InvoiceCtx {
  readonly tenantId: string;
  readonly requestId?: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly tx: unknown;
  readonly now: () => string;
  readonly ports?: { readonly IdentityPort?: { getTenantSettings(ctx: any, input: { keys: readonly string[] }): Promise<any> } };
}
interface Counter { allocate(tx: never, input: { tenantId: string; series: string; fiscalYearBs: string; actorId: string; invoiceNoPattern?: string; timezone?: string }): Promise<{ lastNo: number; allocatedAt: string }> }

export const DOWNTIME_MAX_HOURS_KEY = 'downtime_backentry_max_hours';
const DEFAULT_MAX_HOURS = 72;
const MAX_REF_CHARS = 32;
const HOUR_MS = 3_600_000;
const REGISTRATION_UNIQUE = 'invoices__tenant_id_order_registration__p_uq';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRANCH_CODE = /^[A-Za-z0-9_-]{1,20}$/; // invoices__series__ck
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const isRec = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

const invalid = (...errors: FieldError[]): LimsError => new LimsError('common.validation_failed', undefined, errors);
const fieldError = (path: string, message = 'Field invalid'): FieldError => ({ path, code: 'common.field_invalid', message });
const text = (v: unknown, max: number, required: boolean): v is string =>
  typeof v === 'string' && v.length <= max && (!required || v.trim() !== '') && !CONTROL.test(v);

interface Entry { readonly occurredAt?: string; readonly downtimeRef?: string }

/** LD-25 limits. `undefined` = live. Paths are JSON pointers into the request body. */
function checkEntry(raw: unknown, nowMs: number, maxHours: unknown): Entry | undefined {
  if (raw === undefined) return undefined;
  if (!isRec(raw)) throw invalid(fieldError('/entry'));
  const { mode, occurredAt, downtimeRef } = raw;
  if (mode !== 'live' && mode !== 'downtime_backentry') throw invalid(fieldError('/entry/mode'));
  const errors: FieldError[] = [];
  if (mode === 'live') { // no back-dating of a normal invoice
    if (occurredAt !== undefined) errors.push(fieldError('/entry/occurred_at'));
    if (downtimeRef !== undefined) errors.push(fieldError('/entry/downtime_ref'));
    if (errors.length) throw invalid(...errors);
    return undefined;
  }
  // a nonsense setting never widens the window: it falls back to the default
  const hours = typeof maxHours === 'number' && Number.isFinite(maxHours) && maxHours > 0 ? maxHours : DEFAULT_MAX_HOURS;
  let at: string | undefined;
  if (typeof occurredAt !== 'string' || !UTC_INSTANT.test(occurredAt)) errors.push(fieldError('/entry/occurred_at'));
  else {
    const ms = Date.parse(occurredAt);
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== occurredAt.slice(0, 10) || ms > nowMs || ms < nowMs - hours * HOUR_MS) errors.push(fieldError('/entry/occurred_at'));
    else at = new Date(ms).toISOString();
  }
  let ref: string | undefined;
  if (typeof downtimeRef !== 'string' || downtimeRef.trim() === '' || Array.from(downtimeRef).length > MAX_REF_CHARS || CONTROL.test(downtimeRef)) errors.push(fieldError('/entry/downtime_ref'));
  else ref = downtimeRef.trim();
  if (errors.length) throw invalid(...errors);
  return { occurredAt: at!, downtimeRef: ref! };
}

// LD-25: `entry` (checked in checkEntry) and `branchCode` are not yet in contracts/ports/BillingCommandPort.ts issueOrderInvoice;
// requested in CR-C4-BL06-002 (.orchestra/cr/BL-T06.nonblocking.md). `branchCode` is interim until C0 names the {branch} source.
function checkInput(input: unknown): Record<string, any> {
  if (!isRec(input)) throw invalid(fieldError('/'));
  const errors: FieldError[] = [];
  if (input['purpose'] !== 'registration' && input['purpose'] !== 'supplementary') errors.push(fieldError('/purpose'));
  for (const k of ['orderId', 'patientId', 'branchId', 'centreId']) if (typeof input[k] !== 'string' || !UUID.test(input[k])) errors.push(fieldError(`/${k}`));
  if (input['referrerId'] !== undefined && (typeof input['referrerId'] !== 'string' || !UUID.test(input['referrerId']))) errors.push(fieldError('/referrerId'));
  const b = input['buyer'];
  if (!isRec(b) || !text(b['name'], 200, true)) errors.push(fieldError('/buyer/name'));
  else {
    if (b['pan'] !== undefined && !text(b['pan'], 20, false)) errors.push(fieldError('/buyer/pan')); // invoices__pan__ck
    if (b['address'] !== undefined && !text(b['address'], 300, false)) errors.push(fieldError('/buyer/address'));
  }
  if (!Array.isArray(input['lines']) || input['lines'].length === 0 || input['lines'].length > 200) errors.push(fieldError('/lines'));
  if (!Array.isArray(input['discounts'])) errors.push(fieldError('/discounts'));
  if (typeof input['expectedFingerprint'] !== 'string') errors.push(fieldError('/expectedFingerprint'));
  if (input['branchCode'] !== undefined && (typeof input['branchCode'] !== 'string' || !BRANCH_CODE.test(input['branchCode']))) errors.push(fieldError('/branchCode'));
  if (errors.length) throw invalid(...errors);
  return input;
}

const isRegistrationDuplicate = (e: unknown): boolean => {
  const x = e as { code?: unknown; constraint?: unknown; message?: unknown } | null;
  return x?.code === '23505' && (x.constraint === REGISTRATION_UNIQUE || (typeof x.message === 'string' && x.message.includes(REGISTRATION_UNIQUE)));
};

// ---- B4 cancel / B5 partial credit (BL-T10) ----
const CANCEL_UNIQUE = 'credit_notes__tenant_id_invoice_cancellation__p_uq';
const REASON_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // tab / newline allowed in free text
const MAX_NOTE_LINES = 200;
const MAX_TASK_IDS = 50;
type Row = Record<string, any>;
interface NotePick { readonly line: Row; readonly parts: Parts }

const isCancelDuplicate = (e: unknown): boolean => {
  const x = e as { code?: unknown; constraint?: unknown; message?: unknown } | null;
  return x?.code === '23505' && (x.constraint === CANCEL_UNIQUE || (typeof x.message === 'string' && x.message.includes(CANCEL_UNIQUE)));
};
const partsOf = (r: Row): Parts => ({
  gross: toPaisa(r['gross_paisa']), discount: toPaisa(r['discount_paisa']), exempt: toPaisa(r['exempt_paisa']), taxable: toPaisa(r['taxable_paisa']),
  vat: toPaisa(r['vat_paisa']), otherTax: toPaisa(r['other_tax_paisa']), net: toPaisa(r['net_paisa']),
});
const COLS = { gross: 'gross_paisa', discount: 'discount_paisa', exempt: 'exempt_paisa', taxable: 'taxable_paisa', vat: 'vat_paisa', otherTax: 'other_tax_paisa', net: 'net_paisa' } as const;
const sumParts = (ps: readonly Parts[]): Parts =>
  ps.reduce((t, p) => ({ gross: t.gross + p.gross, discount: t.discount + p.discount, exempt: t.exempt + p.exempt, taxable: t.taxable + p.taxable, vat: t.vat + p.vat, otherTax: t.otherTax + p.otherTax, net: t.net + p.net }),
    { gross: 0, discount: 0, exempt: 0, taxable: 0, vat: 0, otherTax: 0, net: 0 });
const minus = (a: Parts, b: Parts): Parts => ({ gross: a.gross - b.gross, discount: a.discount - b.discount, exempt: a.exempt - b.exempt, taxable: a.taxable - b.taxable, vat: a.vat - b.vat, otherTax: a.otherTax - b.otherTax, net: a.net - b.net });
const colsOf = (p: Parts) => Object.fromEntries((Object.keys(COLS) as Array<keyof Parts>).map((k) => [COLS[k], p[k]]));

/** Shape of the common request fields; returns trimmed text (blank = none). */
function checkReasonFields(input: Row, errors: FieldError[]): { reasonCode: string; reasonText: string | undefined } {
  const code = input['reasonCode'];
  if (typeof code !== 'string' || !REASON_CODE.test(code)) errors.push(fieldError('/reason_code'));
  const t = input['reasonText'];
  let reasonText: string | undefined;
  if (t !== undefined) {
    if (typeof t !== 'string' || t.length > 500 || TEXT_CONTROL.test(t)) errors.push(fieldError('/reason_text'));
    else if (t.trim() !== '') reasonText = t.trim();
  }
  return { reasonCode: code as string, reasonText };
}
/** The record, a UUID invoice id and the reason fields; throws ONE validation error carrying every path found. */
function checkNoteInput(raw: unknown, extra?: (input: Row, errors: FieldError[]) => void) {
  if (!isRec(raw)) throw invalid(fieldError('/'));
  const errors: FieldError[] = [];
  if (typeof raw['invoiceId'] !== 'string' || !UUID.test(raw['invoiceId'])) errors.push(fieldError('/invoice_id'));
  const reason = checkReasonFields(raw, errors);
  extra?.(raw, errors);
  if (errors.length) throw invalid(...errors);
  return { invoiceId: raw['invoiceId'] as string, ...reason, input: raw };
}

export function createInvoiceService(deps: { repo?: BillingRepo; counter: Counter; events: BillingEvents }) {
  const repo = deps.repo ?? billingRepo;
  const balance = createBalanceService({ repo, events: deps.events });

  async function issue(ctx: InvoiceCtx, rawInput: unknown): Promise<IssuedInvoiceRef> {
    if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
    const input = checkInput(rawInput);
    const tx = ctx.tx as never;
    const tenantId = ctx.tenantId;
    const actorId = ctx.actor.id;
    const idp = ctx.ports?.IdentityPort;
    if (!idp) throw new LimsError('common.internal');

    const nowIso = ctx.now();
    const backEntry = isRec(input['entry']) && input['entry']['mode'] === 'downtime_backentry';
    const tenant = await idp.getTenantSettings(ctx, { keys: ['numbering', 'ird', 'branding', 'timezone', ...(backEntry ? [DOWNTIME_MAX_HOURS_KEY] : [])] });
    const entry = checkEntry(input['entry'], Date.parse(nowIso), tenant?.[DOWNTIME_MAX_HOURS_KEY]);

    // the fingerprint is recomputed from the submitted lines/discounts: never trusted (catalog.tax_config_missing propagates)
    const quote = await computeQuote(ctx as never, { lines: input['lines'], discounts: input['discounts'] });
    if (quote.fingerprint !== input['expectedFingerprint']) throw new LimsError('common.version_conflict');
    if (quote.lines.length > 200) throw invalid(fieldError('/lines'));

    const settings = (await repo.getBillingSettings(tx, { tenantId })) ?? { invoice_series_scope: 'tenant', prices_include_tax: false, abbreviated_invoice_enabled: false };
    const scope = settings['invoice_series_scope'];
    if (scope !== 'tenant' && scope !== 'branch') throw new LimsError('common.internal');
    const pattern = tenant?.numbering?.invoiceNoPattern;
    const sellerName = [tenant?.branding?.legalName, tenant?.branding?.displayName].find((n) => typeof n === 'string' && n.trim() !== '');
    if (typeof pattern !== 'string') throw new LimsError('billing.numbering_pattern_invalid');
    if (typeof sellerName !== 'string') throw new LimsError('common.internal'); // tenant branding not configured
    const timezone: string = typeof tenant?.timezone === 'string' ? tenant.timezone : 'Asia/Kathmandu';
    const branchCode = input['branchCode'] as string | undefined;

    const series = seriesKey('INV', scope as SeriesScope, branchCode);
    const fy = fiscalYearOf(nowIso as IsoUtc, timezone);
    // dry-run the pattern with seq 1 BEFORE allocating, so a broken pattern (e.g. branch scope without {branch}) consumes nothing
    try { formatDocumentNumber(pattern, { fy, seq: 1, scope: scope as SeriesScope, ...(branchCode === undefined ? {} : { branch: branchCode }) }); }
    catch (e) { throw isLimsError(e, 'common.validation_failed') ? new LimsError('billing.numbering_pattern_invalid') : e; }

    // ---- allocation LAST: no repo call between this line and insertInvoice (TRD §12) ----
    const { lastNo, allocatedAt } = await deps.counter.allocate(tx, { tenantId, series, fiscalYearBs: fy.long, actorId, invoiceNoPattern: pattern, timezone });
    const invoiceNo = formatDocumentNumber(pattern, { fy, seq: lastNo, scope: scope as SeriesScope, ...(branchCode === undefined ? {} : { branch: branchCode }) });
    const invoiceId = uuidv7();
    const t = quote.totals;
    const buyer = input['buyer'] as { name: string; pan?: string; address?: string };
    const net = t.net.amountPaisa;
    const limit = tenant?.ird?.abbreviatedInvoiceLimitPaisa;
    const kind = settings['abbreviated_invoice_enabled'] === true && buyer.pan === undefined && typeof limit === 'number' && net <= limit ? 'abbreviated_tax_invoice' : 'tax_invoice';
    const cbmsRequired = tenant?.ird?.cbmsRealtimeRequired !== false; // unknown = required: never silently skip the tax authority
    const addressLines: unknown = tenant?.branding?.addressLines;

    try {
      await repo.insertInvoice(tx, {
        id: invoiceId, tenant_id: tenantId, branch_id: input['branchId'], centre_id: input['centreId'], series, fiscal_year_bs: fy.long, invoice_seq: lastNo, invoice_no: invoiceNo,
        invoice_kind: kind, purpose: input['purpose'], order_id: input['orderId'], patient_id: input['patientId'], credit_party_id: null, is_periodic_credit_bill: false,
        period_month: null, referrer_id: input['referrerId'] ?? null, buyer_name: buyer.name, buyer_pan: buyer.pan ?? null, buyer_address: buyer.address ?? null,
        seller_name: sellerName, seller_pan: tenant?.ird?.pan ?? null,
        seller_address: Array.isArray(addressLines) && addressLines.length > 0 ? addressLines.join(', ') : null,
        issued_at: allocatedAt, invoice_date_bs: formatBs(instantToBs(allocatedAt as IsoUtc, timezone)),
        gross_paisa: t.gross.amountPaisa, discount_paisa: t.discount.amountPaisa, exempt_paisa: t.exempt.amountPaisa, taxable_paisa: t.taxable.amountPaisa,
        vat_paisa: t.vat.amountPaisa, other_tax_paisa: t.otherTax.amountPaisa, net_paisa: net,
        prices_include_tax: settings['prices_include_tax'] === true, quote_fingerprint: quote.fingerprint, status: 'issued', is_active: true, print_count: 0,
        cbms_state: cbmsRequired ? 'pending' : 'not_required', cbms_attempts: 0, created_by: actorId, updated_by: actorId,
      });
    } catch (e) {
      if (isRegistrationDuplicate(e)) throw invalid(fieldError('/purpose', 'An invoice for this order already exists'));
      throw e;
    }
    await repo.insertInvoiceLines(tx, quote.lines.map((l, i) => ({
      id: uuidv7(), tenant_id: tenantId, invoice_id: invoiceId, centre_id: input['centreId'], line_no: i + 1, line_kind: l.lineKind,
      order_item_id: l.orderItemId ?? null, orderable_id: l.orderableId, orderable_kind: l.orderableKind, credit_charge_id: null, code: l.code, name: l.name,
      department_id: l.departmentId ?? null, hs_code: l.tax.hsCode ?? null, quantity: 1, unit_price_paisa: l.gross.amountPaisa,
      gross_paisa: l.gross.amountPaisa, discount_paisa: l.discount.amountPaisa, exempt_paisa: l.exempt.amountPaisa, taxable_paisa: l.taxable.amountPaisa,
      vat_treatment: l.tax.vat, vat_rate_bp: l.tax.vat === 'taxable' ? l.tax.vatRateBp ?? null : null, vat_paisa: l.vat.amountPaisa,
      other_tax_code: l.tax.otherTaxCode ?? null, other_tax_rate_bp: l.tax.otherTaxCode != null ? l.tax.otherTaxRateBp ?? null : null, other_tax_paisa: l.otherTax.amountPaisa,
      net_paisa: l.net.amountPaisa, price_list_id: l.priceListId, price_list_version: l.priceListVersion, price_source: l.priceSource, created_by: actorId,
    })));
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: input['centreId'], action: 'invoice_issued', document_kind: 'invoice', document_id: invoiceId, document_no: invoiceNo,
      actor_id: actorId, actor_membership_id: ctx.actor.membershipId ?? null, actor_type: ctx.actor.type, occurred_at: allocatedAt, request_id: ctx.requestId ?? null,
      details: entry ? { entry_mode: 'downtime_backentry', occurred_at: entry.occurredAt, downtime_ref: entry.downtimeRef } : {}, created_by: actorId,
    });
    if (cbmsRequired) await repo.enqueueCbmsSync(tx, { tenantId, documentKind: 'invoice', documentId: invoiceId }); // never marked synced here (US-BL-13.1)

    await deps.events.invoiceIssued(ctx as never, {
      invoice_id: invoiceId, invoice_no: invoiceNo, fiscal_year_bs: fy.long, invoice_kind: kind, order_id: input['orderId'], branch_id: input['branchId'],
      centre_id: input['centreId'], issued_at: allocatedAt,
      totals: { gross: moneyOf(t.gross.amountPaisa), discount: moneyOf(t.discount.amountPaisa), exempt: moneyOf(t.exempt.amountPaisa), taxable: moneyOf(t.taxable.amountPaisa),
        vat: moneyOf(t.vat.amountPaisa), other_tax: moneyOf(t.otherTax.amountPaisa), net: moneyOf(net) },
    });
    await balance.applyChange(ctx, { orderId: input['orderId'], cause: 'invoice_issued' });

    return { invoiceId, invoiceNo, fiscalYearBs: fy.long, issuedAt: allocatedAt, totals: t };
  }

  /** Loads and locks the invoice (tenant-filtered: another tenant's id is "not found"); state first, then the reason rule. */
  async function lockIssued(ctx: InvoiceCtx, invoiceId: string, reasonCode: string, reasonText: string | undefined): Promise<Row> {
    const inv = await repo.getInvoiceForUpdate(ctx.tx as never, { tenantId: ctx.tenantId, invoiceId }) as Row | undefined;
    if (!inv) throw new LimsError('common.not_found');
    if (inv['status'] === 'cancelled') throw new LimsError('billing.invoice_already_cancelled');
    if (inv['status'] !== 'issued') throw new LimsError('billing.invoice_immutable');
    if (reasonCode === 'other' && reasonText === undefined) throw new LimsError('billing.cancel_reason_required');
    return inv;
  }
  /** What is left of each invoice line after the earlier credit notes (per component), keyed by invoice line id. */
  async function remainingByLine(ctx: InvoiceCtx, invoiceId: string): Promise<{ lines: Row[]; remaining: Map<string, Parts> }> {
    const tx = ctx.tx as never;
    const lines = await repo.listInvoiceLines(tx, { tenantId: ctx.tenantId, invoiceId }) as Row[];
    const prior = await repo.listCreditNoteLinesByInvoice(tx, { tenantId: ctx.tenantId, invoiceId }) as Row[];
    const remaining = new Map<string, Parts>();
    for (const l of lines) remaining.set(String(l['id']), minus(partsOf(l), sumParts(prior.filter((p) => p['invoice_line_id'] === l['id']).map(partsOf))));
    return { lines, remaining };
  }

  /** The common write path: number (LAST) -> note -> note lines -> invoice -> tasks -> activity -> CBMS -> events -> balance. Any throw rolls the caller's tx back. */
  async function writeNote(ctx: InvoiceCtx, a: { kind: 'cancellation' | 'partial'; inv: Row; picks: NotePick[]; reasonCode: string; reasonText: string | undefined; taskIds: string[] }) {
    const tx = ctx.tx as never, tenantId = ctx.tenantId, actorId = ctx.actor.id, inv = a.inv;
    const idp = ctx.ports?.IdentityPort;
    if (!idp) throw new LimsError('common.internal');
    const nowIso = ctx.now();
    const tenant = await idp.getTenantSettings(ctx, { keys: ['numbering', 'ird', 'timezone'] });
    const pattern = tenant?.numbering?.creditNoteNoPattern;
    if (typeof pattern !== 'string') throw new LimsError('billing.numbering_pattern_invalid');
    const timezone: string = typeof tenant?.timezone === 'string' ? tenant.timezone : 'Asia/Kathmandu';
    const fy = fiscalYearOf(nowIso as IsoUtc, timezone);
    // dry-run with seq 1 BEFORE allocating, so a broken pattern consumes no number
    try { formatDocumentNumber(pattern, { fy, seq: 1, scope: 'tenant' }); }
    catch (e) { throw isLimsError(e, 'common.validation_failed') ? new LimsError('billing.numbering_pattern_invalid') : e; }
    const cbmsRequired = tenant?.ird?.cbmsRealtimeRequired !== false; // unknown = required: never silently skip the tax authority
    const cbmsState = cbmsRequired ? 'pending' : 'not_required';
    const tot = sumParts(a.picks.map((p) => p.parts));
    const priorCredited = toPaisa(inv['credited_total_paisa']);

    // ---- allocation LAST: no repo call between this line and insertCreditNote (TRD §12) ----
    const { lastNo, allocatedAt } = await deps.counter.allocate(tx, { tenantId, series: seriesKey('CN', 'tenant'), fiscalYearBs: fy.long, actorId, timezone });
    const creditNoteNo = formatDocumentNumber(pattern, { fy, seq: lastNo, scope: 'tenant' });
    const creditNoteId = uuidv7();
    try {
      await repo.insertCreditNote(tx, {
        id: creditNoteId, tenant_id: tenantId, branch_id: inv['branch_id'], centre_id: inv['centre_id'] ?? null, series: 'CN', fiscal_year_bs: fy.long, credit_note_seq: lastNo,
        credit_note_no: creditNoteNo, kind: a.kind, invoice_id: inv['id'], invoice_no: inv['invoice_no'], invoice_fiscal_year_bs: inv['fiscal_year_bs'], order_id: inv['order_id'] ?? null,
        credit_party_id: inv['credit_party_id'] ?? null, buyer_name: inv['buyer_name'], buyer_pan: inv['buyer_pan'] ?? null, issued_at: allocatedAt,
        credit_note_date_bs: formatBs(instantToBs(allocatedAt as IsoUtc, timezone)), reason_code: a.reasonCode, reason_text: a.reasonText ?? null, ...colsOf(tot),
        cbms_state: cbmsState, created_by: actorId, updated_by: actorId,
      });
    } catch (e) {
      if (isCancelDuplicate(e)) throw new LimsError('billing.invoice_already_cancelled'); // DB backstop: one cancellation note per invoice
      throw e;
    }
    await repo.insertCreditNoteLines(tx, a.picks.map((p) => ({
      id: uuidv7(), tenant_id: tenantId, credit_note_id: creditNoteId, invoice_line_id: p.line['id'], centre_id: inv['centre_id'] ?? p.line['centre_id'] ?? null,
      ...colsOf(p.parts), created_by: actorId,
    })));

    const creditedTotal = priorCredited + tot.net;
    const updated = (a.kind === 'cancellation'
      ? await repo.markInvoiceCancelled(tx, {
        tenantId, invoiceId: inv['id'], cancelledAt: allocatedAt, cancelledBy: actorId, reasonCode: a.reasonCode, reasonText: a.reasonText ?? null, creditNoteId,
        creditedTotalPaisa: creditedTotal, cbmsCancelState: cbmsState, userId: actorId,
      })
      : await repo.addInvoiceCredit(tx, { tenantId, invoiceId: inv['id'], creditedTotalPaisa: creditedTotal, userId: actorId })) as Row | undefined;
    if (!updated) throw new LimsError('common.version_conflict');

    if (a.taskIds.length > 0) { // one statement; every id was an open task of this invoice when checked, and the invoice row is locked
      const done = await repo.resolveCreditNoteTasks(tx, { tenantId, taskIds: a.taskIds, creditNoteId, userId: actorId, resolvedAt: allocatedAt });
      if (done.length !== a.taskIds.length) throw new LimsError('common.version_conflict');
    }
    const cancelled = a.kind === 'cancellation';
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: inv['centre_id'] ?? null, action: cancelled ? 'invoice_cancelled' : 'credit_note_issued', document_kind: cancelled ? 'invoice' : 'credit_note',
      document_id: cancelled ? inv['id'] : creditNoteId, document_no: cancelled ? inv['invoice_no'] : creditNoteNo, actor_id: actorId, actor_membership_id: ctx.actor.membershipId ?? null,
      actor_type: ctx.actor.type, occurred_at: allocatedAt, request_id: ctx.requestId ?? null,
      details: cancelled ? { credit_note_id: creditNoteId, credit_note_no: creditNoteNo, reason_code: a.reasonCode } : { invoice_id: inv['id'], reason_code: a.reasonCode }, created_by: actorId,
    });
    if (cbmsRequired) { // never marked synced here (US-BL-13.1); the cancellation job is keyed by the INVOICE, the credit note job by the note
      if (cancelled) await repo.enqueueCbmsSync(tx, { tenantId, documentKind: 'invoice_cancellation', documentId: inv['id'] });
      await repo.enqueueCbmsSync(tx, { tenantId, documentKind: 'credit_note', documentId: creditNoteId });
    }
    if (cancelled) { // no PHI / free text in the payload (REQ-SEC-006)
      await deps.events.invoiceCancelled(ctx as never, {
        invoice_id: inv['id'], invoice_no: inv['invoice_no'], fiscal_year_bs: inv['fiscal_year_bs'], ...(inv['order_id'] ? { order_id: inv['order_id'] } : {}),
        credit_note_id: creditNoteId, credit_note_no: creditNoteNo, reason_code: a.reasonCode, cancelled_at: allocatedAt, credited_total: moneyOf(creditedTotal),
      }, Number(updated['version']));
    }
    if (inv['order_id']) await balance.applyChange(ctx, { orderId: inv['order_id'], cause: cancelled ? 'invoice_cancelled' : 'credit_note_issued' }); // periodic bills have no order balance
    return { creditNoteId, creditNoteNo, issuedAt: allocatedAt, invoiceId: inv['id'] as string };
  }

  function authed(ctx: InvoiceCtx): void {
    if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  }

  /** B4: cancel an issued invoice = status cancelled + a full credit note of what is not yet credited (US-BL-04.1–.3, .5). */
  async function cancel(ctx: InvoiceCtx, rawInput: unknown) {
    authed(ctx);
    const { invoiceId, reasonCode, reasonText } = checkNoteInput(rawInput);
    const inv = await lockIssued(ctx, invoiceId, reasonCode, reasonText);
    const { lines, remaining } = await remainingByLine(ctx, invoiceId);
    const picks: NotePick[] = lines.filter((l) => remaining.get(String(l['id']))!.net > 0).map((l) => ({ line: l, parts: remaining.get(String(l['id']))! }));
    if (picks.length === 0) throw new LimsError('billing.invoice_immutable'); // fully credited already: a zero-value note is forbidden (credit_notes__totals__ck)
    const open = await repo.listOpenCreditNoteTasks(ctx.tx as never, { tenantId: ctx.tenantId, invoiceId }) as Row[]; // the cancellation resolves them (03-APP-FLOW §2.11)
    return writeNote(ctx, { kind: 'cancellation', inv, picks, reasonCode, reasonText, taskIds: open.map((t) => String(t['id'])) });
  }

  /** B5: partial credit note for chosen lines (amount omitted = the line's remaining); optionally resolves listed open tasks of this invoice (US-BL-05.1/.2). */
  async function credit(ctx: InvoiceCtx, rawInput: unknown) {
    authed(ctx);
    const { invoiceId, reasonCode, reasonText, input } = checkNoteInput(rawInput, (i, errors) => {
      const ls = i['lines'];
      if (!Array.isArray(ls) || ls.length < 1 || ls.length > MAX_NOTE_LINES) errors.push(fieldError('/lines'));
      else ls.forEach((l, n) => {
        if (!isRec(l)) { errors.push(fieldError(`/lines/${n}`)); return; }
        if (typeof l['invoiceLineId'] !== 'string' || !UUID.test(l['invoiceLineId'])) errors.push(fieldError(`/lines/${n}/invoice_line_id`));
        const amt = l['amountPaisa'];
        if (amt !== undefined && !(typeof amt === 'number' && Number.isSafeInteger(amt) && amt >= 1)) errors.push(fieldError(`/lines/${n}/amount_paisa`));
      });
      const ids = i['resolvesTaskIds'];
      if (ids === undefined) return;
      if (!Array.isArray(ids) || ids.length > MAX_TASK_IDS) errors.push(fieldError('/resolves_task_ids'));
      else ids.forEach((t, n) => { if (typeof t !== 'string' || !UUID.test(t)) errors.push(fieldError(`/resolves_task_ids/${n}`)); });
    });
    const inv = await lockIssued(ctx, invoiceId, reasonCode, reasonText);
    const { lines, remaining } = await remainingByLine(ctx, invoiceId);
    const lineById = new Map(lines.map((l) => [String(l['id']), l]));

    const errors: FieldError[] = [];
    const picks: NotePick[] = [];
    const seen = new Set<string>();
    (input['lines'] as Row[]).forEach((req, n) => {
      const id = req['invoiceLineId'] as string;
      const rem = remaining.get(id);
      if (!rem) { errors.push(fieldError(`/lines/${n}/invoice_line_id`)); return; }
      const amount: number = req['amountPaisa'] ?? rem.net;
      if (amount < 1 || amount > rem.net) { // a repeated line exhausted by an earlier entry is reported on the id, not the amount
        errors.push(fieldError(seen.has(id) ? `/lines/${n}/invoice_line_id` : `/lines/${n}/amount_paisa`));
        return;
      }
      const parts = splitCredit(rem, amount);
      remaining.set(id, minus(rem, parts));
      seen.add(id);
      picks.push({ line: lineById.get(id)!, parts });
    });
    if (errors.length) throw invalid(...errors);

    const taskIds: string[] = [];
    const ids = (input['resolvesTaskIds'] ?? []) as string[];
    for (const [n, taskId] of ids.entries()) {
      if (taskIds.includes(taskId)) continue;
      const task = await repo.getCreditNoteTask(ctx.tx as never, { tenantId: ctx.tenantId, taskId }) as Row | undefined;
      if (!task) throw new LimsError('common.not_found'); // unknown and another tenant's task look the same (A11)
      if (task['invoice_id'] !== invoiceId || task['status'] !== 'open') throw invalid(fieldError(`/resolves_task_ids/${n}`));
      taskIds.push(taskId);
    }
    return writeNote(ctx, { kind: 'partial', inv, picks, reasonCode, reasonText, taskIds });
  }
  return { issue, cancel, credit };
}
export type InvoiceService = ReturnType<typeof createInvoiceService>;
