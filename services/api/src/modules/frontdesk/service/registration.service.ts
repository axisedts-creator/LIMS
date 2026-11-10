// Registration F8 quoteRegistration (02-TRD §5.1 F8; 03-APP-FLOW §2.2; PRD US-FD-05.1-2, US-FD-06.1-3, US-FD-14.1 quote half; 07-SECURITY REQ-SEC-046).
// Read-only: prices come from CatalogPort, taxes/totals/fingerprints from BillingCommandPort.computeQuote (08 R18: C4 owns no tax table). No write, no event, no log.
// Ctx shape is ASSUMED as in patient.service (+ ports.CatalogPort, ports.BillingCommandPort). Unknown request keys are ignored (never trusted, never echoed).
import type { BillingCommandPortV1, ComputedLine, DiscountInput, PricedLineInput } from '../../../../../../contracts/ports/BillingCommandPort.js';
import type { CatalogPortV1 } from '../../../../../../contracts/ports/CatalogPort.js';
import { fiscalYearBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { LimsError } from '../../../core/errors.js';
import { evaluateLimit, resolveDiscounts, type Discount } from '../domain/discount.js';
import { getSettings } from '../repository/settings.repo.js';
import { FRONTDESK_PERMISSIONS as P } from '../permissions.js';
import { bad, isObj, patientCtx, type PatientCtx, type Result } from './patient.service.js';

type QuoteCtx = PatientCtx & { readonly ports: { readonly CatalogPort: CatalogPortV1; readonly BillingCommandPort: BillingCommandPortV1 } };
type Priority = 'routine' | 'urgent';
interface Draft {
  centreId: string; billingMode: 'cash' | 'credit'; creditPartyId?: string; referrerId?: string;
  items: Array<{ orderableId: string; priority: Priority }>;
  discounts: Array<{ scope: 'bill' | 'line'; orderableId?: string; kind: 'amount' | 'percent'; amountPaisa?: number; percentBp?: number }>;
}

const UUID = /^[0-9a-f-]{36}$/;
const uuid = (v: unknown, path: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(path); return v; };
const oneOf = <T extends string>(v: unknown, set: readonly T[], path: string): T => { if (!set.includes(v as T)) throw bad(path); return v as T; };
const int = (v: unknown): v is number => Number.isSafeInteger(v);

function quoteCtx(c: unknown): QuoteCtx {
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
  oneOf(b.visit_type, ['opd', 'ipd'], '/visit_type');
  const billingMode = oneOf(b.billing_mode, ['cash', 'credit'], '/billing_mode');
  const creditPartyId = b.credit_party_id === undefined ? undefined : uuid(b.credit_party_id, '/credit_party_id');
  if (billingMode === 'credit' && !creditPartyId) throw bad('/credit_party_id');           // US-FD-04.3
  const referrerId = b.referrer_id === undefined ? undefined : uuid(b.referrer_id, '/referrer_id');
  const dflt: Priority = b.priority === undefined ? 'routine' : oneOf(b.priority, ['routine', 'urgent'], '/priority');
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
  const discounts = raw.map((d: unknown, i): Draft['discounts'][number] => {
    const at = `/discounts/${i}`;
    if (!isObj(d)) throw bad(at);
    const scope = oneOf(d.scope, ['bill', 'line'], `${at}/scope`);
    const kind = oneOf(d.kind, ['amount', 'percent'], `${at}/kind`);
    if (typeof d.reason_code !== 'string' || d.reason_code.length < 1 || d.reason_code.length > 64) throw bad(`${at}/reason_code`);     // US-FD-06.2
    const orderableId = scope === 'line' ? uuid(d.orderable_id, `${at}/orderable_id`) : undefined;
    if (orderableId && !seen.has(orderableId)) throw bad(`${at}/orderable_id`);
    if (kind === 'percent') {
      if (!int(d.percent_bp) || d.percent_bp < 1 || d.percent_bp > 10000) throw bad(`${at}/percent_bp`);
      return { scope, kind, percentBp: d.percent_bp, ...(orderableId ? { orderableId } : {}) };
    }
    if (!int(d.amount_paisa) || d.amount_paisa < 1) throw bad(`${at}/amount_paisa`);
    return { scope, kind, amountPaisa: d.amount_paisa, ...(orderableId ? { orderableId } : {}) };
  });
  return { centreId, billingMode, ...(creditPartyId ? { creditPartyId } : {}), ...(referrerId ? { referrerId } : {}), items, discounts };
}

const money = (m: { amountPaisa: number; currency: string }) => ({ amount_paisa: m.amountPaisa, currency: m.currency });
const lineDto = (l: ComputedLine) => ({
  line_ref: l.lineRef, orderable_id: l.orderableId, orderable_kind: l.orderableKind, code: l.code, name: l.name, priority: l.priority, kind: l.lineKind,
  unit_price: money(l.gross), discount: money(l.discount), taxable: money(l.taxable), exempt: money(l.exempt), vat: money(l.vat), other_tax: money(l.otherTax),
  ...(l.otherTaxCode ? { other_tax_code: l.otherTaxCode } : {}), net: money(l.net),
  price_source: l.priceSource, price_list_id: l.priceListId, price_list_version: l.priceListVersion,
});

/** Tenant-local A.D. date of `now` -> B.S. fiscal year "YYYY/YY" (FY starts Shrawan 1, 04 L16). */
function fiscalYearOf(now: Date, tz: unknown): string {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: typeof tz === 'string' ? tz : 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return fiscalYearBs(date as IsoDate).long;
}

const lineRefOf = (orderableId: string, priority: Priority): string => `${orderableId}:${priority}`;

export async function quote(hctx: unknown, body: unknown): Promise<Result> {
  const c = quoteCtx(hctx);
  const { CatalogPort: catalog, BillingCommandPort: billing, IdentityPort: identity } = c.ports;
  await identity.assertRole(c, { permission: P.registrationCreate });
  const d = parseDraft(body);

  const scope = (await identity.getActor(c)).centreScope as { all?: boolean; centreIds: readonly string[] } | undefined;
  if (scope && scope.all !== true && !scope.centreIds.includes(d.centreId)) throw new LimsError('common.not_found');   // 404, not 403: do not confirm the centre exists

  const at = c.now().toISOString();
  const settings = await getSettings(c.tx, c.tenantId);      // missing row = schema defaults: every discount needs approval (05-SCHEMA §3)
  const limits = {
    selfLimitBp: Number(settings?.discount_self_limit_bp ?? 0), selfLimitPaisa: Number(settings?.discount_self_limit_paisa ?? 0),
    absoluteMaxBp: Number(settings?.discount_absolute_max_bp ?? 10000),
  };

  // Catalog: expansion + revision, panel names, one price per orderable (precedence is C3's: credit_party > referrer > centre > tenant_default).
  const resolved = await catalog.resolveOrderables(c, { orderableIds: d.items.map((i) => i.orderableId), asOf: at as never });
  const context = { centreId: d.centreId, ...(d.referrerId ? { referrerId: d.referrerId } : {}), ...(d.billingMode === 'credit' ? { creditPartyId: d.creditPartyId } : {}) };
  const priced = await Promise.all(d.items.map(async (it) => {
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
    return line;
  }));

  // US-FD-06.3: reject a discount larger than what it applies to before billing sees it (exact paisa, bigint inside the domain helper).
  const rows = priced.flatMap((l) => [{ id: l.lineRef, grossPaisa: l.unitPrice.amountPaisa },
    ...(l.urgentSurcharge ? [{ id: `${l.lineRef}#surcharge`, grossPaisa: l.urgentSurcharge.amountPaisa }] : [])]);
  const byOrderable = new Map(priced.map((l) => [l.orderableId as string, l.lineRef]));
  const domainDiscounts: Discount[] = d.discounts.map((x) => ({
    scope: x.scope, ...(x.orderableId ? { lineId: byOrderable.get(x.orderableId)! } : {}),
    ...(x.kind === 'percent' ? { kind: 'percent' as const, percentBp: x.percentBp! } : { kind: 'amount' as const, amountPaisa: x.amountPaisa! }),
  }));
  resolveDiscounts(rows, domainDiscounts);

  const discounts: DiscountInput[] = d.discounts.map((x) => ({
    scope: x.scope, ...(x.orderableId ? { lineRef: byOrderable.get(x.orderableId)! } : {}), kind: x.kind,
    ...(x.kind === 'percent' ? { percentBp: x.percentBp! } : { amountPaisa: x.amountPaisa! }),
  }));
  const q = await billing.computeQuote(c, { lines: priced, discounts });

  // US-FD-06.1: the evaluation uses the TOTAL discount; over the absolute maximum nothing can be approved (422).
  const verdict = evaluateLimit({ grossPaisa: q.totals.gross.amountPaisa, discountPaisa: q.totals.discount.amountPaisa, ...limits });
  if (verdict === 'exceeds_limit') throw new LimsError('frontdesk.discount_exceeds_limit');

  // The quote reports the credit state instead of failing (US-FD-04.2); any other port error (e.g. another tenant's party -> not_found) propagates.
  let creditStatus: 'ok' | 'locked' | 'over_limit' | undefined;
  if (d.billingMode === 'credit') {
    try {
      await billing.assertCreditAllowed(c, { creditPartyId: d.creditPartyId as never, additional: { amountPaisa: q.totals.net.amountPaisa } as never });
      creditStatus = 'ok';
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;     // by code, not instanceof: a port may carry its own LimsError class
      if (code === 'billing.credit_party_locked') creditStatus = 'locked';
      else if (code === 'billing.credit_limit_exceeded') creditStatus = 'over_limit';
      else throw e;
    }
  }

  const tz = ((await identity.getTenantSettings(c, { keys: ['timezone'] })) ?? {}).timezone;
  const t = q.totals;
  return { status: 200, body: {
    lines: q.lines.map(lineDto),
    totals: { gross: money(t.gross), discount: money(t.discount), exempt: money(t.exempt), taxable: money(t.taxable), vat: money(t.vat), other_tax: money(t.otherTax), net: money(t.net) },
    discount_evaluation: { within_limit: verdict === 'within_limit', approval_required: verdict === 'approval_required', limit_percent_bp: limits.selfLimitBp, limit_paisa: limits.selfLimitPaisa },
    catalog_revision: resolved.catalogRevision, quote_fingerprint: q.fingerprint, base_fingerprint: q.baseFingerprint,
    ...(creditStatus ? { credit_status: { state: creditStatus } } : {}), fiscal_year_bs: fiscalYearOf(c.now(), tz),
  } };
}
