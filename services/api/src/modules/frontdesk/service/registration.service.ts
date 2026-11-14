// Registration F8 quoteRegistration + F9 createRegistration (02-TRD §5.1 F8/F9; 03-APP-FLOW §2.2/§2.3; PRD US-FD-03..06, 08.1, 14.1; 07-SECURITY REQ-SEC-046).
// Prices come from CatalogPort, taxes/totals/fingerprints from BillingCommandPort.computeQuote (08 R18: C4 owns no tax table). Unknown request keys are ignored (never trusted, never echoed).
// Ctx shape is ASSUMED as in patient.service (+ ports.CatalogPort/BillingCommandPort/NotificationPort, ctx.events, ctx.core.centre). Layout: shared parsing + pricing, then `create` (F9), then `quote` (F8, read-only, last).
// F9 is ONE request tx (ctx.tx) and opens no transaction statement of its own: the core pipeline commits, or undoes everything (rows, counters, billing events, events) when anything throws.
import type { BillingCommandPortV1, ComputedLine, DiscountInput, IssuedInvoiceRef, PricedLineInput, QuoteResult } from '../../../../../../contracts/ports/BillingCommandPort.js';
import type { CatalogPortV1, ResolvedOrderables } from '../../../../../../contracts/ports/CatalogPort.js';
import type { NotificationPortV1 } from '../../../../../../contracts/ports/NotificationPort.js';
import { fiscalYearBs, formatBs, instantToBs, type IsoDate, type IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { evaluateLimit, resolveDiscounts, type Discount, type LimitResult } from '../domain/discount.js';
import { formatNumber, hasToken } from '../domain/numbering.js';
import { ageDisplay } from '../domain/patient.js';
import { createFrontdeskEvents } from '../events/publish.js';
import { dateOnly } from '../mappers/patient.dto.js';
import { nextCounterValue } from '../repository/counters.repo.js';
import { listConsentsByPatient } from '../repository/consents.repo.js';
import { lockDiscountApproval } from '../repository/discountApprovals.repo.js';
import { insertDiscount } from '../repository/discounts.repo.js';
import { cancelOrderItem, insertOrderItem, listOrderItemsByOrder } from '../repository/orderItems.repo.js';
import { confirmOrderRow, insertOrder, lockOrderById, patientHasOrder } from '../repository/orders.repo.js';
import { getPatientById } from '../repository/patients.repo.js';
import { getSettings } from '../repository/settings.repo.js';
import { linkTrfToOrder, lockLinkableTrfDrafts } from '../repository/trf.repo.js';
import { loadFrontdeskConfig } from '../config.js';
import { FRONTDESK_PERMISSIONS as P } from '../permissions.js';
import { lockApprovalForRegistration, markConsumed, toApiDiscount } from './discount.service.js';
import { bad, createPatient, expectedVersion, isObj, patientCtx, strict, todayIn, type PatientCtx, type Result } from './patient.service.js';

export type QuoteCtx = PatientCtx & { readonly ports: { readonly CatalogPort: CatalogPortV1; readonly BillingCommandPort: BillingCommandPortV1 } };
type CreateCtx = QuoteCtx & {
  readonly ports: QuoteCtx['ports'] & { readonly NotificationPort: NotificationPortV1 };
  readonly events: { publish(ctx: never, type: string, input: never): Promise<{ eventId: string; duplicate: boolean }> };
  readonly core: { centre(ctx: unknown, i: { centreId: string }): Promise<{ branchId: string }>; branch(ctx: unknown, i: { branchId: string }): Promise<{ branchCode: string }> };
  readonly log?: { warn(o: object, msg?: string): void };
};
type Priority = 'routine' | 'urgent';
type CollectionMode = 'walk_in' | 'home' | 'centre' | 'partner';
interface DraftDiscount { scope: 'bill' | 'line'; orderableId?: string; kind: 'amount' | 'percent'; amountPaisa?: number; percentBp?: number; reasonCode: string; reasonText?: string }
export interface Draft {
  centreId: string; billingMode: 'cash' | 'credit'; visitType: 'opd' | 'ipd'; priority: Priority; collectionMode: CollectionMode; creditPartyId?: string; referrerId?: string;
  items: Array<{ orderableId: string; priority: Priority }>;
  discounts: DraftDiscount[];
}

const UUID = /^[0-9a-f-]{36}$/;
const uuid = (v: unknown, path: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(path); return v; };
const oneOf = <T extends string>(v: unknown, set: readonly T[], path: string): T => { if (!set.includes(v as T)) throw bad(path); return v as T; };
const int = (v: unknown): v is number => Number.isSafeInteger(v);
const INVOICE_ISSUE = 'billing.invoice.issue';       // 03-APP-FLOW §2.3 pre-transaction: second assert for cash
const TZ = 'Asia/Kathmandu';

export function quoteCtx(c: unknown): QuoteCtx {
  const x = patientCtx(c) as QuoteCtx;
  if (!x.ports.CatalogPort || !x.ports.BillingCommandPort) throw new LimsError('common.service_unavailable');
  return x;
}

/** Fixed messages only: no submitted value is echoed (07-SECURITY). */
function parseDraft(b: unknown): Draft {
  if (!isObj(b)) throw bad('');
  const p = b.patient;
  if (!isObj(p) || !(isObj(p.new_patient) || (typeof p.patient_id === 'string' && UUID.test(p.patient_id)))) throw bad('/patient');
  const centreId = uuid(b.centre_id, '/centre_id');
  const visitType = oneOf(b.visit_type, ['opd', 'ipd'], '/visit_type');
  const billingMode = oneOf(b.billing_mode, ['cash', 'credit'], '/billing_mode');
  const creditPartyId = b.credit_party_id === undefined ? undefined : uuid(b.credit_party_id, '/credit_party_id');
  if (billingMode === 'credit' && !creditPartyId) throw bad('/credit_party_id');           // US-FD-04.3
  const referrerId = b.referrer_id === undefined ? undefined : uuid(b.referrer_id, '/referrer_id');
  const dflt: Priority = b.priority === undefined ? 'routine' : oneOf(b.priority, ['routine', 'urgent'], '/priority');
  const collectionMode = b.collection_mode === undefined ? 'walk_in' : oneOf(b.collection_mode, ['walk_in', 'home', 'centre', 'partner'], '/collection_mode');
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 50) throw bad('/items');
  const seen = new Set<string>();
  const items = b.items.map((it: unknown, i) => {
    if (!isObj(it)) throw bad(`/items/${i}`);
    const orderableId = uuid(it.orderable_id, `/items/${i}/orderable_id`);
    if (seen.has(orderableId)) throw bad(`/items/${i}/orderable_id`);                     // one line per orderable: a line discount must name exactly one line
    seen.add(orderableId);
    return { orderableId, priority: it.priority === undefined ? dflt : oneOf(it.priority, ['routine', 'urgent'], `/items/${i}/priority`) };
  });
  const raw = b.discounts === undefined ? [] : b.discounts;
  if (!Array.isArray(raw) || raw.length > 20) throw bad('/discounts');
  const discounts = raw.map((d: unknown, i): DraftDiscount => {
    const at = `/discounts/${i}`;
    if (!isObj(d)) throw bad(at);
    const scope = oneOf(d.scope, ['bill', 'line'], `${at}/scope`);
    const kind = oneOf(d.kind, ['amount', 'percent'], `${at}/kind`);
    if (typeof d.reason_code !== 'string' || d.reason_code.length < 1 || d.reason_code.length > 64) throw bad(`${at}/reason_code`);     // US-FD-06.2
    if (d.reason_text !== undefined && (typeof d.reason_text !== 'string' || d.reason_text.length > 500 || d.reason_text.includes('\u0000'))) throw bad(`${at}/reason_text`);
    const orderableId = scope === 'line' ? uuid(d.orderable_id, `${at}/orderable_id`) : undefined;
    if (orderableId && !seen.has(orderableId)) throw bad(`${at}/orderable_id`);
    const common = { scope, reasonCode: d.reason_code, ...(typeof d.reason_text === 'string' ? { reasonText: d.reason_text } : {}), ...(orderableId ? { orderableId } : {}) };
    if (kind === 'percent') {
      if (!int(d.percent_bp) || d.percent_bp < 1 || d.percent_bp > 10000) throw bad(`${at}/percent_bp`);
      return { ...common, kind, percentBp: d.percent_bp };
    }
    if (!int(d.amount_paisa) || d.amount_paisa < 1) throw bad(`${at}/amount_paisa`);
    return { ...common, kind, amountPaisa: d.amount_paisa };
  });
  return { centreId, billingMode, visitType, priority: dflt, collectionMode, ...(creditPartyId ? { creditPartyId } : {}), ...(referrerId ? { referrerId } : {}), items, discounts };
}

const money = (m: { amountPaisa: number; currency: string }) => ({ amount_paisa: m.amountPaisa, currency: m.currency });
export const lineDto = (l: ComputedLine) => ({
  line_ref: l.lineRef, orderable_id: l.orderableId, orderable_kind: l.orderableKind, code: l.code, name: l.name, priority: l.priority, kind: l.lineKind,
  unit_price: money(l.gross), discount: money(l.discount), taxable: money(l.taxable), exempt: money(l.exempt), vat: money(l.vat), other_tax: money(l.otherTax),
  ...(l.otherTaxCode ? { other_tax_code: l.otherTaxCode } : {}), net: money(l.net),
  price_source: l.priceSource, price_list_id: l.priceListId, price_list_version: l.priceListVersion,
});
export const totalsDto = (t: QuoteResult['totals']) => ({ gross: money(t.gross), discount: money(t.discount), exempt: money(t.exempt), taxable: money(t.taxable), vat: money(t.vat), other_tax: money(t.otherTax), net: money(t.net) });

/** InvoiceDto of an issued invoice (F9/F12 registration, F13 supplementary). IssuedInvoiceRef carries ids + totals only, so the rest is composed here [CONV] (CR .orchestra/cr/FD-T09-invoice-dto.md):
 *  line ids are generated, invoice_seq = trailing number of invoice_no, series 'INV' (05-SCHEMA invoices__series__ck), cbms_state from ird.cbmsRealtimeRequired. */
export async function invoiceDto(c: QuoteCtx, inv: IssuedInvoiceRef, p: Priced, o: Record<string, any>, buyer: Record<string, any>): Promise<Record<string, any>> {
  const omitNull = (x: Record<string, any>) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined && v !== null));
  const t = (await c.ports.IdentityPort.getTenantSettings(c, { keys: ['timezone', 'branding', 'ird'] })) ?? {};
  const tz = typeof t.timezone === 'string' ? t.timezone : TZ;
  const seq = Number(/([0-9]+)$/.exec(inv.invoiceNo)?.[1] ?? 1);
  const zero = { amount_paisa: 0, currency: 'NPR' };
  return omitNull({
    id: inv.invoiceId, invoice_no: inv.invoiceNo, invoice_seq: Number.isSafeInteger(seq) && seq >= 1 && seq <= 2147483647 ? seq : 1, series: 'INV', fiscal_year_bs: inv.fiscalYearBs,
    invoice_kind: 'tax_invoice', status: 'issued', is_active: true, issued_at: inv.issuedAt, invoice_date_bs: formatBs(instantToBs(inv.issuedAt as IsoUtc, tz), 'iso'),
    branch_id: o['branch_id'], centre_id: o['centre_id'], order_id: o['id'], referrer_id: o['referrer_id'], is_periodic_credit_bill: false, buyer,
    seller: omitNull({ name: String(t.branding?.legalName ?? ''), pan: t.ird?.pan, address: Array.isArray(t.branding?.addressLines) ? t.branding.addressLines.join(', ') : undefined }),
    lines: p.q.lines.map((l, i) => omitNull({
      id: uuidv7(), line_no: i + 1, line_kind: l.lineKind, orderable_id: l.orderableId, code: l.code, name: l.name, department_id: l.departmentId, quantity: 1,
      unit_price: money(l.lineKind === 'urgent_surcharge' ? l.gross : l.unitPrice), gross: money(l.gross), discount: money(l.discount), exempt: money(l.exempt),
      taxable: money(l.taxable), vat: money(l.vat), other_tax: money(l.otherTax), other_tax_code: l.otherTaxCode, net: money(l.net), credited: zero,
    })),
    totals: totalsDto(inv.totals), credited_total: zero, print_count: 0, cbms_state: t.ird?.cbmsRealtimeRequired === true ? 'pending' : 'not_required', version: 1,
  });
}

/** Tenant-local A.D. date of `now` -> B.S. fiscal year "YYYY/YY" (FY starts Shrawan 1, 04 L16). */
export function fiscalYearOf(now: Date, tz: unknown): string {
  return fiscalYearBs(todayIn(typeof tz === 'string' ? tz : TZ, now) as IsoDate).long;
}

const lineRefOf = (orderableId: string, priority: Priority): string => `${orderableId}:${priority}`;

export interface Priced {
  resolved: ResolvedOrderables; priced: PricedLineInput[]; meta: Array<{ testIds: readonly string[]; departmentId?: string }>;
  discounts: DiscountInput[]; computed: number[]; byOrderable: Map<string, string>; q: QuoteResult;
  limits: { selfLimitBp: number; selfLimitPaisa: number; absoluteMaxBp: number }; verdict: LimitResult;
}

/** Shared by F8 and F9 (§2.2 steps 2-6, re-run inside the F9 tx so the fingerprint compares against live prices). Read-only. */
export async function priceDraft(c: QuoteCtx, d: Draft, settings: any): Promise<Priced> {
  const { CatalogPort: catalog, BillingCommandPort: billing } = c.ports;
  const at = c.now().toISOString();
  const limits = {
    selfLimitBp: Number(settings?.discount_self_limit_bp ?? 0), selfLimitPaisa: Number(settings?.discount_self_limit_paisa ?? 0),
    absoluteMaxBp: Number(settings?.discount_absolute_max_bp ?? 10000),   // missing row = schema defaults: every discount needs approval (05-SCHEMA §3)
  };

  // Catalog: expansion + revision, panel names, one price per orderable (precedence is C3's: credit_party > referrer > centre > tenant_default).
  const resolved = await catalog.resolveOrderables(c, { orderableIds: d.items.map((i) => i.orderableId), asOf: at as never });
  const context = { centreId: d.centreId, ...(d.referrerId ? { referrerId: d.referrerId } : {}), ...(d.billingMode === 'credit' ? { creditPartyId: d.creditPartyId } : {}) };
  const rows = await Promise.all(d.items.map(async (it) => {
    const o = resolved.orderables.find((x) => x.orderableId === it.orderableId);
    if (!o) throw new LimsError('common.not_found');
    const tests = o.testIds.map((id) => resolved.tests.find((t) => t.id === id)).filter((t) => t !== undefined);
    const [head, price] = await Promise.all([
      o.kind === 'panel' ? catalog.getPanel(c, { panelId: it.orderableId as never, asOf: at as never }) : tests[0],
      catalog.priceFor(c, { orderableId: it.orderableId as never, context: context as never, priority: it.priority, at: at as never }),
    ]);
    if (!head) throw new LimsError('common.not_found');
    const depts = new Set(tests.map((t) => t.departmentId));
    const line: PricedLineInput = {
      lineRef: lineRefOf(it.orderableId, it.priority), orderableId: it.orderableId as never, orderableKind: o.kind, code: head.code, name: head.name,
      ...(depts.size === 1 ? { departmentId: [...depts][0] } : {}), priority: it.priority, unitPrice: price.unitPrice,
      ...(it.priority === 'urgent' && price.urgentSurcharge ? { urgentSurcharge: price.urgentSurcharge } : {}),
      tax: price.tax, priceListId: price.priceListId, priceListVersion: price.priceListVersion, priceSource: price.source,
    };
    return { line, meta: { testIds: o.testIds, ...(depts.size === 1 ? { departmentId: [...depts][0] as string } : {}) } };
  }));
  const priced = rows.map((r) => r.line);

  // US-FD-06.3: reject a discount larger than what it applies to before billing sees it (exact paisa, bigint inside the domain helper).
  const grossRows = priced.flatMap((l) => [{ id: l.lineRef, grossPaisa: l.unitPrice.amountPaisa },
    ...(l.urgentSurcharge ? [{ id: `${l.lineRef}#surcharge`, grossPaisa: l.urgentSurcharge.amountPaisa }] : [])]);
  const byOrderable = new Map(priced.map((l) => [l.orderableId as string, l.lineRef]));
  const domainDiscounts: Discount[] = d.discounts.map((x) => ({
    scope: x.scope, ...(x.orderableId ? { lineId: byOrderable.get(x.orderableId)! } : {}),
    ...(x.kind === 'percent' ? { kind: 'percent' as const, percentBp: x.percentBp! } : { kind: 'amount' as const, amountPaisa: x.amountPaisa! }),
  }));
  const { computed } = resolveDiscounts(grossRows, domainDiscounts);

  const discounts: DiscountInput[] = d.discounts.map((x) => ({
    scope: x.scope, ...(x.orderableId ? { lineRef: byOrderable.get(x.orderableId)! } : {}), kind: x.kind,
    ...(x.kind === 'percent' ? { percentBp: x.percentBp! } : { amountPaisa: x.amountPaisa! }),
  }));
  const q = await billing.computeQuote(c, { lines: priced, discounts });

  // US-FD-06.1: the evaluation uses the TOTAL discount; over the absolute maximum nothing can be approved (422).
  const verdict = evaluateLimit({ grossPaisa: q.totals.gross.amountPaisa, discountPaisa: q.totals.discount.amountPaisa, ...limits });
  if (verdict === 'exceeds_limit') throw new LimsError('frontdesk.discount_exceeds_limit');
  return { resolved, priced, meta: rows.map((r) => r.meta), discounts, computed, byOrderable, q, limits, verdict };
}

// ======================= F9 createRegistration =======================

interface PaymentIn { methodCode: string; amountPaisa: number; reference?: string }
interface Downtime { occurredAt: string; downtimeRef: string }
interface CreateIn { draft: Draft; fingerprint: string; payments: PaymentIn[]; trfIds: string[]; approvalId?: string; buyerPan?: string; downtime?: Downtime }

// LD-25 (2026-11-07, A33-2 downtime mode): back-entry window default. ponytail: constant, not the tenant setting `downtime_backentry_max_hours`
// (TenantSettings has no such key yet, see .orchestra/cr/FD-T06-ld25-gaps.md); switch to the setting when C2 adds it.
const DOWNTIME_MAX_HOURS = 72;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** LD-25: `entry_mode` live (default) | downtime_backentry; back-entry needs occurred_at in [now - max hours, now] and downtime_ref <= 32 chars; live carries neither. */
function parseDowntime(b: Record<string, unknown>, now: Date): Downtime | undefined {
  const mode = b['entry_mode'] === undefined ? 'live' : oneOf(b['entry_mode'], ['live', 'downtime_backentry'], '/entry_mode');
  if (mode === 'live') {
    const extra = ['occurred_at', 'downtime_ref'].filter((k) => b[k] !== undefined).map((k) => `/${k}`);
    if (extra.length) throw bad(...extra);       // no back-dating of anything else
    return undefined;
  }
  const errs: string[] = [];
  const at = b['occurred_at'];
  const ms = typeof at === 'string' && ISO_INSTANT.test(at) ? Date.parse(at) : NaN;
  if (!Number.isFinite(ms) || ms > now.getTime() || ms < now.getTime() - DOWNTIME_MAX_HOURS * 3_600_000) errs.push('/occurred_at');
  const ref = b['downtime_ref'];
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 32 || ref.includes('\u0000')) errs.push('/downtime_ref');
  if (errs.length) throw bad(...errs);
  return { occurredAt: new Date(ms).toISOString(), downtimeRef: ref as string };
}

function parseCreate(b: unknown, now: Date): CreateIn {
  const draft = parseDraft(b);
  const o = b as Record<string, unknown>;
  const fp = o['quote_fingerprint'];
  if (typeof fp !== 'string' || !/^[0-9a-f]{64}$/.test(fp)) throw bad('/quote_fingerprint');
  const raw = o['payments'];
  if (!Array.isArray(raw) || raw.length > 5) throw bad('/payments');
  const payments = raw.map((p: unknown, i): PaymentIn => {
    const at = `/payments/${i}`;
    if (!isObj(p)) throw bad(at);
    if (typeof p.method_code !== 'string' || p.method_code.length < 1 || p.method_code.length > 64) throw bad(`${at}/method_code`);
    if (!int(p.amount_received_paisa) || p.amount_received_paisa < 1) throw bad(`${at}/amount_received_paisa`);
    if (p.reference !== undefined && (typeof p.reference !== 'string' || p.reference.length > 100)) throw bad(`${at}/reference`);
    if (p.tendered_paisa !== undefined && (!int(p.tendered_paisa) || p.tendered_paisa < 1)) throw bad(`${at}/tendered_paisa`);
    return { methodCode: p.method_code, amountPaisa: p.amount_received_paisa, ...(typeof p.reference === 'string' ? { reference: p.reference } : {}) };
  });
  if (draft.billingMode === 'credit' && payments.length > 0) throw bad('/payments');        // 03-APP-FLOW §2.3 step 6 credit
  const trf = o['trf_attachment_ids'];
  if (trf !== undefined && (!Array.isArray(trf) || trf.length > 5)) throw bad('/trf_attachment_ids');
  (trf as unknown[] | undefined)?.forEach((t, i) => uuid(t, `/trf_attachment_ids/${i}`));
  const approvalId = o['discount_approval_id'] === undefined ? undefined : uuid(o['discount_approval_id'], '/discount_approval_id');
  if (o['buyer_pan'] !== undefined && (typeof o['buyer_pan'] !== 'string' || o['buyer_pan'].length > 32)) throw bad('/buyer_pan');
  const downtime = parseDowntime(o, now);
  return { draft, fingerprint: fp, payments, trfIds: [...new Set((trf as string[] | undefined) ?? [])], ...(approvalId ? { approvalId } : {}), ...(typeof o['buyer_pan'] === 'string' ? { buyerPan: o['buyer_pan'] } : {}), ...(downtime ? { downtime } : {}) };
}

function createCtx(c: unknown): CreateCtx {
  const x = quoteCtx(c) as CreateCtx;
  if (!x.ports.NotificationPort || typeof x.events?.publish !== 'function' || typeof x.core?.centre !== 'function') throw new LimsError('common.service_unavailable');
  return x;
}

/** Ports type `now()` as an ISO string (RequestContext); the handler ctx carries a Date. Prototype-delegating copy keeps tx/tenant/actor/ports. */
const portCtx = (c: CreateCtx): CreateCtx => Object.assign(Object.create(c), { now: () => c.now().toISOString() });

const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** Whole years/months/days from birth to `today` (both YYYY-MM-DD). */
export function ageParts(birth: string, today: string): { years: number; months: number; days: number } {
  const [by, bm, bd] = birth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let years = ty - by, months = tm - bm, days = td - bd;
  if (days < 0) { months -= 1; days += daysInMonth(tm === 1 ? ty - 1 : ty, tm === 1 ? 12 : tm - 1); }
  if (months < 0) { years -= 1; months += 12; }
  return { years: Math.max(0, years), months, days };
}

/** Step 1: existing patient (RLS: 404 if not visible; anonymised -> 400) or a new one through the F2 path (dedupe, consent, patient_code), same tx. */
async function resolvePatient(c: CreateCtx, ref: unknown, centreId: string): Promise<Record<string, any>> {
  const p = (ref as Record<string, any>);
  if (isObj(p.new_patient)) {
    const created = await createPatient(Object.assign(Object.create(c), { centreId }), p.new_patient);
    return (await getPatientById(c.tx, c.tenantId, (created.body as { id: string }).id))!;
  }
  const row = await getPatientById(c.tx, c.tenantId, p.patient_id);
  if (!row) throw new LimsError('common.not_found');
  if (row['anonymised_at'] != null) throw bad('/patient');
  return row;
}

type SmsState = 'queued' | 'suppressed_no_consent' | 'suppressed_no_contact' | 'suppressed_channel_disabled' | 'not_attempted';

/** A port may carry its own error class (the contracts' LimsError has no HTTP status): re-raise by code as the core LimsError (08 R18: code and detail unchanged). */
// Retry steps 1-9 once in a new tx on billing.counter_busy / 40P01 (03-APP-FLOW.md:97) is NOT done: handler ctx has no tx opener -> CR .orchestra/cr/FD-T06-retry-quote-ext.md
export async function create(hctx: unknown, body: unknown): Promise<Result> {
  return portErrors(() => createInTx(hctx, body));
}

async function portErrors(fn: () => Promise<Result>): Promise<Result> {
  try { return await fn(); } catch (e) {
    const x = e as { code?: unknown; detail?: unknown } | null;
    if (e instanceof LimsError || typeof x?.code !== 'string' || !/^[a-z_]+\.[a-z_]+$/.test(x.code)) throw e;     // app codes only: a pg SQLSTATE ('23505') is not one
    throw new LimsError(x.code, typeof x.detail === 'string' ? x.detail : undefined);
  }
}

// ======================= F12 confirmPreRegisteredOrder =======================
// FD-T12 (review item 1): the F9 path over the STORED pre_registered order (02-TRD §5.1 F12, PRD US-FD-12.2): the stored context (patient, centre, billing mode, referrer, ...) is
// turned into a RegistrationDraft and run through createInTx, which then registers the existing row instead of inserting one (registration_no kept, no new order).
// items_override replaces the stored items. A stored item is kept only when its orderable + priority + price snapshot equal the live priced line; otherwise it is cancelled and re-inserted [CONV].
interface Pre { order: Record<string, any>; items: Record<string, any>[] }
const CONFIRM_KEYS = ['quote_fingerprint', 'payments', 'discounts', 'discount_approval_id', 'items_override'];

export function confirm(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  return portErrors(async () => {
    const c = createCtx(hctx);
    await c.ports.IdentityPort.assertRole(c, { permission: P.registrationCreate });
    const version = expectedVersion(headers);
    const b = strict(body, CONFIRM_KEYS);
    let items: unknown;
    if (b['items_override'] !== undefined) {
      items = strict(b['items_override'], ['items'], '/items_override')['items'];
      if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw bad('/items_override/items');
    }
    const id = isObj(params) ? params['order_id'] : undefined;
    const o = typeof id === 'string' && UUID.test(id) ? await lockOrderById(c.tx, c.tenantId, id) : null;    // row lock: a racing confirm/cancel waits, then sees the moved status
    if (!o) throw new LimsError('common.not_found');
    const scope = (await c.ports.IdentityPort.getActor(c)).centreScope as { all?: boolean; centreIds: readonly string[] } | undefined;
    if (scope && scope.all !== true && !scope.centreIds.includes(o['centre_id'])) throw new LimsError('common.not_found');   // 404, never 403
    if (o['status'] !== 'pre_registered') throw new LimsError('common.immutable_record');
    if (Number(o['version']) !== version) throw new LimsError('common.version_conflict');
    const stored = (await listOrderItemsByOrder(c.tx, c.tenantId, o['id'])).filter((i) => i['status'] === 'active');
    const draftBody = {
      patient: { patient_id: o['patient_id'] }, centre_id: o['centre_id'], visit_type: o['visit_type'], billing_mode: o['billing_mode'], priority: o['priority'], collection_mode: o['collection_mode'],
      ...(o['credit_party_id'] ? { credit_party_id: o['credit_party_id'] } : {}), ...(o['referrer_id'] ? { referrer_id: o['referrer_id'] } : {}),
      items: items ?? stored.map((i) => ({ orderable_id: i['orderable_id'], priority: i['priority'] })),
      ...(b['discounts'] !== undefined ? { discounts: b['discounts'] } : {}), quote_fingerprint: b['quote_fingerprint'], payments: b['payments'],
      ...(b['discount_approval_id'] !== undefined ? { discount_approval_id: b['discount_approval_id'] } : {}),
    };
    return createInTx(c, draftBody, { order: o, items: stored });
  });
}

async function createInTx(hctx: unknown, body: unknown, pre?: Pre): Promise<Result> {
  const c = createCtx(hctx);
  const { IdentityPort: identity, CatalogPort: catalog, BillingCommandPort: billing, NotificationPort: notify } = c.ports;
  await identity.assertRole(c, { permission: P.registrationCreate });
  const r = parseCreate(body, c.now());
  const d = r.draft;
  if (d.billingMode === 'cash') await identity.assertRole(c, { permission: INVOICE_ISSUE, centreId: d.centreId });     // checked before any write

  const actor = await identity.getActor(c);
  const scope = actor.centreScope as { all?: boolean; centreIds: readonly string[] } | undefined;
  if (scope && scope.all !== true && !scope.centreIds.includes(d.centreId)) throw new LimsError('common.not_found');   // 404, not 403: do not confirm the centre exists
  const settings = await getSettings(c.tx, c.tenantId);
  if (r.buyerPan !== undefined) {
    let ok = false;
    try { ok = new RegExp(String(settings?.buyer_pan_pattern ?? '^[0-9]{9}$')).test(r.buyerPan); } catch { ok = false; }     // PAN format UNVERIFIED (setting buyer_pan_pattern)
    if (!ok) throw bad('/buyer_pan');
  }

  // 1. patient
  const patient = await resolvePatient(c, (body as Record<string, unknown>)['patient'], d.centreId);
  const isFirst = pre ? pre.order['is_first_order_of_patient'] === true : !(await patientHasOrder(c.tx, c.tenantId, patient['id']));

  // 1a. TRF drafts (03-APP-FLOW §3 step 5): same tenant+centre, unlinked, uploaded by this user, inside the TTL. Any foreign/stale id refuses the whole call (404) before any counter is touched.
  if (r.trfIds.length > 0) {
    const found = await lockLinkableTrfDrafts(c.tx, c.tenantId, r.trfIds, d.centreId, c.actor.membershipId ?? c.actor.id, loadFrontdeskConfig().trfDraftTtlHours);
    if (found.length !== r.trfIds.length) throw new LimsError('common.not_found');
  }

  // 2. referrer
  if (!d.referrerId && settings?.require_referrer === true) throw new LimsError('frontdesk.referrer_required');
  if (d.referrerId && !(await catalog.getReferrer(c, { referrerId: d.referrerId as never, purpose: 'display' })).isActive) throw bad('/referrer_id');

  // 3. re-quote inside the tx: a changed price list / catalog / discount set is a stale quote (409), before any counter is touched
  const pc = portCtx(c);
  const p = await priceDraft(c, d, settings);
  if (p.q.fingerprint !== r.fingerprint) throw new LimsError('common.version_conflict', 'Prices changed');     // fresh `quote` problem extension (03-APP-FLOW.md:86) missing: LimsError has no extension field -> CR .orchestra/cr/FD-T06-retry-quote-ext.md
  // 3a. credit (net is known only now)
  if (d.billingMode === 'credit') await billing.assertCreditAllowed(pc, { creditPartyId: d.creditPartyId as never, additional: p.q.totals.net });
  // 4. discount authority: above the self limit needs an approved, unexpired, unconsumed approval bound to THIS base fingerprint + patient + centre + discounts (FD-T07, US-FD-07.1/07.5).
  //    The row is locked here (a racing registration waits, then sees it consumed); it is marked consumed once the order exists (step 5), all in this one tx.
  let approval: Record<string, any> | undefined;
  if (p.verdict === 'approval_required') {
    if (!r.approvalId) throw new LimsError('frontdesk.discount_approval_required');
    approval = await lockApprovalForRegistration(c, {
      approvalId: r.approvalId, baseFingerprint: p.q.baseFingerprint, patientId: isObj((body as Record<string, any>)['patient']?.new_patient) ? undefined : patient['id'],
      centreId: d.centreId, discounts: d.discounts.map(toApiDiscount),
    });
  } else if (r.approvalId && !(await lockDiscountApproval(c.tx, c.tenantId, r.approvalId))) {
    throw new LimsError('common.not_found');      // 07-SECURITY §6.1: a named approval that is not this tenant's is 404 even when none is needed (not silently ignored); not consumed
  }

  // 5. order: registration_no counter (per branch) first, invoice counter (inside billing) last: short lock window
  const tenant = (await identity.getTenantSettings(c, { keys: ['numbering', 'timezone', 'branding', 'channels'] })) ?? {};
  const tz = typeof tenant.timezone === 'string' ? tenant.timezone : TZ;
  const today = todayIn(tz, c.now());
  const pattern = tenant.numbering?.registrationNoPattern;
  if (typeof pattern !== 'string') throw new LimsError('common.internal');
  const birth = dateOnly(patient['birth_on']);
  const registeredAt = c.now();
  let branchId: string;
  let orderId: string;
  let order: Record<string, any>;
  if (pre) {          // F12: the existing row becomes registered (registration_no, age snapshot and first-order flag were set at pre-registration)
    branchId = pre.order['branch_id'];
    orderId = pre.order['id'];
    const moved = await confirmOrderRow(c.tx, c.tenantId, orderId, Number(pre.order['version']), { at: registeredAt, catalogRevision: p.resolved.catalogRevision });
    if (!moved) throw new LimsError('common.version_conflict');
    order = moved;
  } else {
    branchId = (await c.core.centre(c, { centreId: d.centreId })).branchId;
    // registrationNoPattern must contain {branch} (03-IC §9.3 / 2844): its value is the branch_code of the centre's branch
    const branchCode = hasToken(pattern, 'branch') ? (await c.core.branch(c, { branchId })).branchCode : undefined;
    const seq = await nextCounterValue(c.tx, c.tenantId, 'registration_no', branchId, c.actor.id);
    const age = birth ? ageParts(birth, today) : undefined;
    orderId = uuidv7();
    order = await insertOrder(c.tx, c.tenantId, {
      id: orderId, branch_id: branchId, centre_id: d.centreId, patient_id: patient['id'], registration_no: formatNumber(pattern, { seq, year: Number(today.slice(0, 4)), ...(branchCode === undefined ? {} : { branch: branchCode }) }),
      status: 'registered', visit_type: d.visitType, billing_mode: d.billingMode, credit_party_id: d.creditPartyId, referrer_id: d.referrerId, priority: d.priority,
      collection_mode: d.collectionMode, source: 'front_desk', age_years: age?.years, age_months: age?.months, age_days: age?.days,
      is_first_order_of_patient: isFirst, catalog_revision: p.resolved.catalogRevision, registered_at: registeredAt,
    });
  }
  // F12: a stored item equal to the live line (orderable, priority, price snapshot) is kept; every other stored active item is cancelled. Unmatched lines are inserted.
  const same = (s: Record<string, any>, l: PricedLineInput) => s['orderable_id'] === l.orderableId && s['priority'] === l.priority && Number(s['unit_price_paisa']) === l.unitPrice.amountPaisa
    && (s['urgent_surcharge_paisa'] == null ? undefined : Number(s['urgent_surcharge_paisa'])) === l.urgentSurcharge?.amountPaisa
    && s['price_list_id'] === l.priceListId && Number(s['price_list_version']) === l.priceListVersion && s['price_source'] === l.priceSource;
  const keep = new Map<number, Record<string, any>>();
  for (const s of pre?.items ?? []) {
    const i = p.priced.findIndex((l, j) => !keep.has(j) && same(s, l));
    if (i >= 0) keep.set(i, s); else await cancelOrderItem(c.tx, c.tenantId, orderId, s['id']);
  }
  const itemRows: any[] = [];
  for (const [i, l] of p.priced.entries()) {
    itemRows.push(keep.get(i) ?? await insertOrderItem(c.tx, c.tenantId, {
      id: uuidv7(), order_id: orderId, centre_id: d.centreId, orderable_id: l.orderableId, orderable_kind: l.orderableKind, code: l.code, name: l.name,
      test_ids: p.meta[i]!.testIds, department_id: p.meta[i]!.departmentId, priority: l.priority, unit_price_paisa: l.unitPrice.amountPaisa,
      urgent_surcharge_paisa: l.urgentSurcharge?.amountPaisa, price_list_id: l.priceListId, price_list_version: l.priceListVersion, price_source: l.priceSource,
      vat_treatment: l.tax.vat, other_tax_code: l.tax.otherTaxCode, added_in_items_version: Number(order['items_version'] ?? 1),
    }));
  }
  const itemOf = new Map(itemRows.map((it) => [it['orderable_id'] as string, it['id'] as string]));
  const membership = c.actor.membershipId ?? c.actor.id;
  const discountRows: any[] = [];
  for (const [i, x] of d.discounts.entries()) {
    discountRows.push(await insertDiscount(c.tx, c.tenantId, {
      id: uuidv7(), order_id: orderId, centre_id: d.centreId, scope: x.scope, order_item_id: x.orderableId ? itemOf.get(x.orderableId) : undefined, kind: x.kind,
      amount_paisa: x.amountPaisa, percent_bp: x.percentBp, computed_paisa: p.computed[i], reason_code: x.reasonCode, reason_text: x.reasonText,
      ...(approval ? { approval_mode: 'approved', approval_id: approval['id'], approved_by_membership_id: approval['decided_by_membership_id'] }
        : { approval_mode: 'within_limit', approved_by_membership_id: membership }),   // within the self limit: self-approved
      applied_by_membership_id: membership, applied_at: registeredAt,
    }));
  }
  if (approval) await markConsumed(c, approval['id'], orderId);
  if (r.trfIds.length > 0) await linkTrfToOrder(c.tx, c.tenantId, r.trfIds, orderId);

  // 6. billing, same tx (the lines are exactly the ones the fingerprint was computed over)
  const nowIso = registeredAt.toISOString();
  const bsDate = formatBs(instantToBs(nowIso as IsoUtc, tz), 'iso');
  const buyer = { name: String(patient['full_name']), ...(r.buyerPan ? { pan: r.buyerPan } : {}), ...(patient['address_text'] ? { address: String(patient['address_text']) } : {}) };
  const refPart = d.referrerId ? { referrerId: d.referrerId as never } : {};
  let invoice: Record<string, unknown> | undefined;
  let creditCharges: Array<Record<string, unknown>> | undefined;
  const ledger: Array<Record<string, unknown>> = [];
  let balance: any;
  if (d.billingMode === 'cash') {
    const inv = await billing.issueOrderInvoice(pc, {
      orderId: orderId as never, patientId: patient['id'], branchId: branchId as never, centreId: d.centreId as never, ...refPart, buyer,
      lines: p.priced, discounts: p.discounts, expectedFingerprint: r.fingerprint, purpose: 'registration',
    });
    invoice = await invoiceDto(c, inv, p, { id: orderId, branch_id: branchId, centre_id: d.centreId, referrer_id: d.referrerId }, buyer);
    for (const [i, pay] of r.payments.entries()) {
      const out = await billing.recordPayment(pc, {
        orderId: orderId as never, invoiceId: inv.invoiceId, methodCode: pay.methodCode, amount: { amountPaisa: pay.amountPaisa, currency: 'NPR' } as never,
        ...(pay.reference ? { reference: pay.reference } : {}), captureKind: 'manual', idempotencyKey: `${orderId}:reg:${i}`, collectedByMembershipId: membership as never,
        issueReceiptNo: false,       // the invoice is the receipt (PRD D-RECEIPT)
      });
      balance = out.balance;
      ledger.push({ id: out.ledgerEntryId, entry_kind: 'payment', capture_kind: 'manual', order_id: orderId, invoice_id: inv.invoiceId, method_code: pay.methodCode,
        amount: { amount_paisa: pay.amountPaisa, currency: 'NPR' }, collected_by: { membership_id: membership, display_name: actor.displayName }, created_at: nowIso, business_date_bs: bsDate });
    }
  } else {
    const out = await billing.recordCreditCharges(pc, {
      orderId: orderId as never, creditPartyId: d.creditPartyId as never, branchId: branchId as never, centreId: d.centreId as never, ...refPart,
      patientDisplayName: String(patient['full_name']), lines: p.priced, discounts: p.discounts, expectedFingerprint: r.fingerprint,
    });
    // [CONV] the port returns ids only: amount = the computed line net at the same index (no fallback: a count mismatch is an internal error),
    // period_month = A.D. month in tenant tz (05-SCHEMA.md:1049, 03-IC:2192), status = column default 'uninvoiced' (05-SCHEMA.md:1050).
    if (out.chargeIds.length !== p.q.lines.length) throw new LimsError('common.internal');
    creditCharges = out.chargeIds.map((id, i) => ({ id, credit_party_id: d.creditPartyId, order_id: orderId, amount: money(p.q.lines[i]!.net), period_month: today.slice(0, 7), status: 'uninvoiced', created_at: nowIso }));
  }
  if (!balance) balance = (await billing.getOrderBillingSummary(pc, { orderId: orderId as never })).balance;

  // 7. SMS: never rolls the registration back; the port decides consent/contact, C4 decides setting + tenant channel
  let sms: SmsState = 'not_attempted';
  if (settings?.registration_sms_enabled === false) sms = 'not_attempted';
  else if (tenant.channels?.smsEnabled !== true) sms = 'suppressed_channel_disabled';
  else if ((await listConsentsByPatient(c.tx, c.tenantId, patient['id']))[0]?.['sms'] !== true) sms = 'suppressed_no_consent';       // §2.3 step 7: only with consent
  else if (!patient['phone_e164']) sms = 'suppressed_no_contact';
  else {
    try {
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(registeredAt);
      sms = (await notify.sendSms(pc, {
        recipient: { kind: 'patient', patientId: patient['id'] }, templateCode: 'frontdesk.registration_confirmation', purpose: 'registration_confirmation',
        params: { lab_name: String(tenant.branding?.displayName ?? ''), registered_time_hhmm: hhmm }, idempotencyKey: `${orderId}:registration_sms`,
        related: { entityType: 'order', entityId: orderId as never },
      })).status;
    } catch (e) {
      c.log?.warn({ code: String((e as { code?: unknown } | null)?.code ?? 'unknown'), order_id: orderId }, 'registration sms not attempted');
    }
  }

  // 8. event (IC §3.1: ids, enums and times only; no names, phones or registration no)
  const source = pre ? { source: pre.order['source'], ...(pre.order['source_ref_id'] ? { source_ref_id: pre.order['source_ref_id'] } : {}) } : { source: 'front_desk' };
  await createFrontdeskEvents(c.events as never).orderCreated(c as never, {
    order_id: orderId, patient_id: patient['id'], branch_id: branchId, centre_id: d.centreId, visit_type: d.visitType, billing_mode: d.billingMode,
    ...(d.creditPartyId ? { credit_party_id: d.creditPartyId } : {}), ...(d.referrerId ? { referrer_id: d.referrerId } : {}), priority: d.priority,
    collection_mode: d.collectionMode, ...source, registered_at: nowIso,
    items: itemRows.map((it, i) => ({ order_item_id: it['id'], orderable_id: it['orderable_id'], orderable_kind: it['orderable_kind'], test_ids: p.meta[i]!.testIds, priority: it['priority'] })),
  }, Number(order['version']));

  // LD-25: back-entry is audited with the paper serial and the original time (the server keeps its own created_at / registered_at).
  // [CR] audit.g_cs_access_actions has no order/registration action: `patient.view` is the nearest existing code (see .orchestra/cr/FD-T06-ld25-gaps.md).
  if (r.downtime) {
    await c.audit.access({ action: 'patient.view', entityType: 'order', entityId: orderId, centreId: d.centreId, outcome: 'allowed',
      detail: { entry_mode: 'downtime_backentry', downtime_ref: r.downtime.downtimeRef, occurred_at: r.downtime.occurredAt, event: 'order_registered' } });
  }

  // 9. response (201); the core idempotency hook stores it
  const bal = balance;
  return { status: 201, body: {
    order: {
      id: orderId, registration_no: order['registration_no'],
      patient: { id: patient['id'], patient_code: patient['patient_code'], full_name: patient['full_name'], sex: patient['sex'], age_at_order: birth ? ageDisplay(birth, today) : 'Unknown' },
      branch_id: branchId, centre_id: d.centreId, visit_type: d.visitType, billing_mode: d.billingMode, ...(d.creditPartyId ? { credit_party_id: d.creditPartyId } : {}),
      ...(d.referrerId ? { referrer_id: d.referrerId } : {}), priority: d.priority, collection_mode: d.collectionMode, ...source, status: 'registered',
      items: itemRows.map((it) => ({ id: it['id'], orderable_id: it['orderable_id'], orderable_kind: it['orderable_kind'], code: it['code'], name: it['name'], priority: it['priority'],
        status: it['status'], unit_price: { amount_paisa: Number(it['unit_price_paisa']), currency: 'NPR' },
        ...(it['urgent_surcharge_paisa'] != null ? { urgent_surcharge: { amount_paisa: Number(it['urgent_surcharge_paisa']), currency: 'NPR' } } : {}), outsourced: it['outsourced'] === true })),
      discounts: d.discounts.map((x) => ({ scope: x.scope, ...(x.orderableId ? { orderable_id: x.orderableId } : {}), kind: x.kind,
        ...(x.amountPaisa !== undefined ? { amount_paisa: x.amountPaisa } : {}), ...(x.percentBp !== undefined ? { percent_bp: x.percentBp } : {}),
        reason_code: x.reasonCode, ...(x.reasonText ? { reason_text: x.reasonText } : {}) })),
      trf_attachments: [], flags: [], requires_credit_note: false, version: Number(order['version']),
    },
    ...(invoice ? { invoice } : {}), ...(creditCharges ? { credit_charges: creditCharges } : {}), ledger_entries: ledger,
    balance: { order_id: bal.orderId, invoiced: money(bal.invoiced), paid: money(bal.paid), credited: money(bal.credited), balance_due: money(bal.balanceDue), balance_version: bal.balanceVersion, as_of: bal.asOf },
    print: { ...(invoice ? { invoice_id: invoice['id'] } : {}), receipt_ledger_entry_ids: ledger.map((e) => e['id']) },
    notifications: { registration_sms: sms }, label_print: { autoprint: settings?.label_autoprint !== false },
  } };
}

// ======================= F8 quoteRegistration (read-only: keep LAST in this file, FD-T05 static test) =======================

export async function quote(hctx: unknown, body: unknown): Promise<Result> {
  const c = quoteCtx(hctx);
  const { BillingCommandPort: billing, IdentityPort: identity } = c.ports;
  await identity.assertRole(c, { permission: P.registrationCreate });
  const d = parseDraft(body);

  const scope = (await identity.getActor(c)).centreScope as { all?: boolean; centreIds: readonly string[] } | undefined;
  if (scope && scope.all !== true && !scope.centreIds.includes(d.centreId)) throw new LimsError('common.not_found');   // 404, not 403: do not confirm the centre exists
  // 07-SECURITY §6.1: another tenant's centre is common.not_found (tenant-bound lookup, as F15). The patient is NOT looked up: a quote is read-only and names no stored row.
  // ponytail: optional only because the FD-T05 quote harness ctx carries no `core`; the app ctx always does (createCtx requires it).
  if (typeof (c as { core?: { centre?: unknown } }).core?.centre === 'function') await (c as unknown as CreateCtx).core.centre(c as never, { centreId: d.centreId });

  const settings = await getSettings(c.tx, c.tenantId);      // missing row = schema defaults: every discount needs approval (05-SCHEMA §3)
  const { resolved, q, limits, verdict } = await priceDraft(c, d, settings);

  // The quote reports the credit state instead of failing (US-FD-04.2); any other port error (e.g. another tenant's party -> not_found) propagates.
  let creditStatus: 'ok' | 'locked' | 'over_limit' | undefined;
  if (d.billingMode === 'credit') {
    try {
      await billing.assertCreditAllowed(c, { creditPartyId: d.creditPartyId as never, additional: q.totals.net });   // J-T01: full Money incl. currency, as register() does; real billing rejects a missing currency
      creditStatus = 'ok';
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;     // by code, not instanceof: a port may carry its own LimsError class
      if (code === 'billing.credit_party_locked') creditStatus = 'locked';
      else if (code === 'billing.credit_limit_exceeded') creditStatus = 'over_limit';
      else throw e;
    }
  }

  const tz = ((await identity.getTenantSettings(c, { keys: ['timezone'] })) ?? {}).timezone;
  return { status: 200, body: {
    lines: q.lines.map(lineDto),
    totals: totalsDto(q.totals),
    discount_evaluation: { within_limit: verdict === 'within_limit', approval_required: verdict === 'approval_required', limit_percent_bp: limits.selfLimitBp, limit_paisa: limits.selfLimitPaisa },
    catalog_revision: resolved.catalogRevision, quote_fingerprint: q.fingerprint, base_fingerprint: q.baseFingerprint,
    ...(creditStatus ? { credit_status: { state: creditStatus } } : {}), fiscal_year_bs: fiscalYearOf(c.now(), tz),
  } };
}
