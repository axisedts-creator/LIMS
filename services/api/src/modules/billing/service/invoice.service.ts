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
import { moneyOf } from '../domain/money/paisa.js';
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
  return { issue };
}
export type InvoiceService = ReturnType<typeof createInvoiceService>;
