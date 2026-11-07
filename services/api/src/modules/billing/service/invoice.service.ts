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
import { fiscalYearOf } from '../domain/fiscalYear.js';
import { formatDocumentNumber, seriesKey, type SeriesScope } from '../domain/numberFormat.js';
import { moneyOf, toPaisa } from '../domain/money/paisa.js';
import type { BillingEvents } from '../events/publish.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import { createBalanceService } from './balance.service.js';
import { lineOf, present, iso, STAFF_DISPLAY, totalsOf } from './invoiceRead.service.js';
import { computeQuote } from './quote.service.js';

export interface InvoiceCtx {
  readonly tenantId: string;
  readonly requestId?: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly tx: unknown;
  readonly now: () => string;
  readonly ports?: {
    readonly IdentityPort?: {
      getTenantSettings(ctx: any, input: { keys: readonly string[] }): Promise<any>;
      assertRole?(ctx: any, req: { permission: string; centreId?: string }): Promise<void>; // print (BL-T09)
      readBrandingAsset?(ctx: any, input: { assetId: string }): Promise<{ kind: string; mimeType: string; base64: string }>;
    };
  };
  /** core ctx.audit.access: one audit.access_log row on ctx.tx (print, BL-T09). */
  readonly audit?: { access(entry: { action: string; entityType: string; entityId?: string; centreId?: string; outcome: 'allowed' | 'denied'; detail?: Record<string, string | number | boolean> }): Promise<unknown> };
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

// ---- print (B3 printInvoice / B6 printCreditNote; 03-APP-FLOW §2.10, 07-SECURITY A6) ----
export const COPY_MARK = 'Copy of Original / प्रतिलिपि';
const CANCELLED_BANNER = 'CANCELLED';
const REPRINT_PERMISSION = 'billing.invoice.reprint';
const PRINT_REASONS: readonly string[] = ['first_print', 'reprint', 'printer_fault', 'customer_copy'];

function checkPrintInput(raw: unknown, idKey: 'invoiceId' | 'creditNoteId'): { id: string; reasonCode?: string } {
  const errors: FieldError[] = [];
  const o = isRec(raw) ? raw : {};
  if (typeof o[idKey] !== 'string' || !UUID.test(o[idKey])) errors.push(fieldError(idKey === 'invoiceId' ? '/invoice_id' : '/credit_note_id'));
  const rc = o['reasonCode'];
  if (rc !== undefined && (typeof rc !== 'string' || !PRINT_REASONS.includes(rc))) errors.push(fieldError('/reason_code'));
  if (errors.length) throw invalid(...errors);
  return { id: o[idKey], ...(rc === undefined ? {} : { reasonCode: rc as string }) };
}

const adDate = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));

const isRegistrationDuplicate = (e: unknown): boolean => {
  const x = e as { code?: unknown; constraint?: unknown; message?: unknown } | null;
  return x?.code === '23505' && (x.constraint === REGISTRATION_UNIQUE || (typeof x.message === 'string' && x.message.includes(REGISTRATION_UNIQUE)));
};

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
  /**
   * Print an issued invoice (kind 'invoice') or credit note ('credit_note'). One caller transaction. Order: validate -> load (tenant from ctx; unknown and
   * another tenant's id both common.not_found) -> assertRole -> port reads (settings, branding images) -> mark*Printed (row lock + print_count + 1 RETURNING:
   * the number is never a read + 1, so parallel prints are distinct) -> document -> print_log -> activity -> access_log. Any throw rolls all of it back.
   * print_no >= 2 is always a copy, whatever reason_code the client sends (A6). Fails closed (common.internal) without IdentityPort or ctx.audit.access.
   */
  async function printDocument(ctx: InvoiceCtx, kind: 'invoice' | 'credit_note', raw: unknown) {
    if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
    const isInvoice = kind === 'invoice';
    const { id, reasonCode } = checkPrintInput(raw, isInvoice ? 'invoiceId' : 'creditNoteId');
    const idp = ctx.ports?.IdentityPort;
    const audit = ctx.audit;
    if (!idp?.assertRole || !idp.readBrandingAsset || typeof audit?.access !== 'function') throw new LimsError('common.internal');
    const tx = ctx.tx as never;
    const tenantId = ctx.tenantId;
    const actorId = ctx.actor.id;
    const load = async (): Promise<Record<string, any> | undefined> => (isInvoice ? repo.getInvoice(tx, { tenantId, invoiceId: id }) : repo.getCreditNote(tx, { tenantId, creditNoteId: id }));

    const found = await load();
    if (!found) throw new LimsError('common.not_found');
    const centreId = typeof found['centre_id'] === 'string' ? found['centre_id'] : undefined;
    await idp.assertRole(ctx, { permission: REPRINT_PERMISSION, ...(centreId === undefined ? {} : { centreId }) });

    const tenant = await idp.getTenantSettings(ctx, { keys: ['branding', 'timezone'] });
    const b = tenant?.branding;
    const legalName = [b?.legalName, b?.displayName].find((n) => typeof n === 'string' && n.trim() !== '');
    if (typeof legalName !== 'string') throw new LimsError('common.internal'); // tenant branding not configured
    const timezone: string = typeof tenant?.timezone === 'string' ? tenant.timezone : 'Asia/Kathmandu';
    const images: Array<{ kind: string; mime_type: string; base64: string }> = [];
    for (const assetId of [b?.logoAssetId, b?.letterheadHeaderAssetId, b?.letterheadFooterAssetId]) { // a failed read aborts the print: no original without its letterhead
      if (typeof assetId !== 'string') continue;
      const a = await idp.readBrandingAsset(ctx, { assetId });
      images.push({ kind: a.kind, mime_type: a.mimeType, base64: a.base64 });
    }
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const branding = present({ legal_name: legalName, address_lines: arr(b?.addressLines), phones: arr(b?.phones), receipt_footer_note: b?.receiptFooterNote, images });

    // ---- the row lock is taken here; nothing below may fail on user input ----
    const printNo = isInvoice
      ? await repo.markInvoicePrinted(tx, { tenantId, invoiceId: id, userId: actorId })
      : await repo.markCreditNotePrinted(tx, { tenantId, creditNoteId: id, userId: actorId });
    if (printNo === undefined) throw new LimsError('common.not_found');
    if (!Number.isSafeInteger(printNo) || printNo < 1) throw new LimsError('common.internal');
    const row = await load(); // after the lock: status / version are the committed ones
    if (!row) throw new LimsError('common.internal');

    const copy = printNo > 1;
    const now = ctx.now();
    const orderId = row['order_id'];
    const bal = typeof orderId === 'string' ? await repo.getOrderBalance(tx, { tenantId, orderId }) : undefined;
    // [CONV] no balance row (cannot happen for an invoiced order) prints a zero payment block rather than guessing
    const paid = bal ? toPaisa(bal['paid_paisa']) : 0;
    const due = bal ? toPaisa(bal['invoiced_paisa']) - toPaisa(bal['credited_paisa']) - paid : 0;
    const common = {
      branding, dates: { bs: row[isInvoice ? 'invoice_date_bs' : 'credit_note_date_bs'], ad: adDate(iso(row['issued_at']), timezone) },
      payment_block: { paid: moneyOf(paid), balance_due: moneyOf(due) }, print_no: printNo, ...(copy ? { copy_mark: COPY_MARK } : {}),
    };

    let document: Record<string, unknown>;
    let documentNo: string;
    if (isInvoice) {
      documentNo = String(row['invoice_no']);
      const lines = await repo.listInvoiceLines(tx, { tenantId, invoiceId: id });
      const credited = toPaisa(row['credited_total_paisa']) > 0 ? await repo.sumCreditedByLine(tx, { tenantId, invoiceLineIds: lines.map((l) => String(l['id'])) }) : new Map<string, string>();
      let cancellation;
      if (row['status'] === 'cancelled' && row['cancelled_at']) {
        const cn = row['credit_note_id'] ? await repo.getCreditNote(tx, { tenantId, creditNoteId: String(row['credit_note_id']) }) : undefined;
        cancellation = present({
          cancelled_at: iso(row['cancelled_at']), cancelled_by_display: STAFF_DISPLAY, reason_code: row['cancel_reason_code'], reason_text: row['cancel_reason_text'],
          credit_note_id: row['credit_note_id'], credit_note_no: typeof cn?.['credit_note_no'] === 'string' ? cn['credit_note_no'] : '',
        });
      }
      document = present({
        id: row['id'], invoice_no: row['invoice_no'], invoice_seq: row['invoice_seq'], series: row['series'], fiscal_year_bs: row['fiscal_year_bs'], invoice_kind: row['invoice_kind'],
        status: row['status'], is_active: row['is_active'], issued_at: iso(row['issued_at']), invoice_date_bs: row['invoice_date_bs'], branch_id: row['branch_id'], centre_id: row['centre_id'],
        order_id: row['order_id'], credit_party_id: row['credit_party_id'], is_periodic_credit_bill: row['is_periodic_credit_bill'], referrer_id: row['referrer_id'],
        buyer: present({ name: row['buyer_name'], pan: row['buyer_pan'], address: row['buyer_address'] }),
        seller: present({ name: row['seller_name'], pan: row['seller_pan'], address: row['seller_address'] }),
        lines: lines.map((l) => lineOf(l, credited.get(String(l['id'])))), totals: totalsOf(row), credited_total: moneyOf(toPaisa(row['credited_total_paisa'])), cancellation,
        print_count: printNo, last_printed_at: now, cbms_state: row['cbms_state'], cbms_cancel_state: row['cbms_cancel_state'], version: row['version'],
        cancelled_banner: row['status'] === 'cancelled' ? CANCELLED_BANNER : undefined, ...common,
      });
    } else {
      documentNo = String(row['credit_note_no']);
      const lines = await repo.listCreditNoteLines(tx, { tenantId, creditNoteId: id });
      document = present({
        id: row['id'], credit_note_no: row['credit_note_no'], credit_note_seq: row['credit_note_seq'], kind: row['kind'], invoice_id: row['invoice_id'], invoice_no: row['invoice_no'],
        fiscal_year_bs: row['fiscal_year_bs'], issued_at: iso(row['issued_at']), credit_note_date_bs: row['credit_note_date_bs'], centre_id: row['centre_id'],
        reason_code: row['reason_code'], reason_text: row['reason_text'],
        lines: lines.map((l) => ({ invoice_line_id: l['invoice_line_id'], amount: moneyOf(toPaisa(l['net_paisa'])) })),
        totals: { exempt: moneyOf(toPaisa(row['exempt_paisa'])), taxable: moneyOf(toPaisa(row['taxable_paisa'])), vat: moneyOf(toPaisa(row['vat_paisa'])),
          other_tax: moneyOf(toPaisa(row['other_tax_paisa'])), net: moneyOf(toPaisa(row['net_paisa'])) },
        print_count: printNo, cbms_state: row['cbms_state'], version: row['version'], ...common,
      });
    }

    await repo.insertPrintLog(tx, {
      id: uuidv7(), tenant_id: tenantId, ...(centreId === undefined ? {} : { centre_id: centreId }), document_kind: kind, document_id: id, document_no: documentNo,
      print_no: printNo, is_copy: copy, ...(reasonCode === undefined ? {} : { reason_code: reasonCode }), printed_at: now, created_by: actorId,
    });
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: centreId ?? null, action: `${kind}_printed`, document_kind: kind, document_id: id, document_no: documentNo,
      actor_id: actorId, actor_membership_id: ctx.actor.membershipId ?? null, actor_type: ctx.actor.type, occurred_at: now, request_id: ctx.requestId ?? null,
      details: { print_no: printNo, ...(reasonCode === undefined ? {} : { reason_code: reasonCode }) }, created_by: actorId,
    });
    await audit.access({ action: `${kind}.print`, entityType: kind, entityId: id, ...(centreId === undefined ? {} : { centreId }), outcome: 'allowed', detail: { print_no: printNo } });

    return { print_no: printNo, ...(copy ? { copy_mark: COPY_MARK } : {}), document };
  }
  const print = (ctx: InvoiceCtx, input: unknown) => printDocument(ctx, 'invoice', input);
  const printCreditNote = (ctx: InvoiceCtx, input: unknown) => printDocument(ctx, 'credit_note', input);

  return { issue, print, printCreditNote };
}
export type InvoiceService = ReturnType<typeof createInvoiceService>;
