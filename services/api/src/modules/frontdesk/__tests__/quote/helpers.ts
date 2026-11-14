// FD-T05 harness (Quote F8 quoteRegistration). The handler is driven with a request-shaped object + a HandlerContext over a REAL PG17 tx (lims_api, RLS on),
// same convention as ../patients/helpers.ts. CatalogPort and BillingCommandPort are the REAL fakes from packages/fakes (no hand-rolled price logic).
// ASSUMED ctx.ports keys (spec names no frontdesk ctx): IdentityPort{assertRole,getActor,getTenantSettings}, CatalogPort, BillingCommandPort (02-TRD §6.4 names).
// ASSUMED: ctx.now() returns a Date (as FD-T04); the handler passes `at` to CatalogPort.priceFor as an ISO string (PriceQuery.at: IsoUtc).
// Discount limits live in frontdesk.settings (05-SCHEMA §3): tenant A = 10 % / paisa 0 (percent only) / absolute max 50 %; tenant B = 10 % / NPR 50.00 / max 50 %.
import { access } from '../../../../core/audit/access.js';
import { createFakeBillingCommandPort } from '../../../../../../../packages/fakes/src/BillingCommandPort.fake';
import { createFakeCatalogPort } from '../../../../../../../packages/fakes/src/CatalogPort.fake';
import { idFor } from '../../../../../../../packages/fakes/src/base';
import { handlers } from '../../handlers/index.js';
import { CENTRE, NOW, SYS_ACTOR, TENANT_A, TENANT_B, appTx, makeIdentity, rejection, req, schemaErrors, seed, superTx, uid, CONSENT_VERSION } from '../patients/helpers.js';

export { CENTRE, NOW, TENANT_A, TENANT_B, schemaErrors, uid, rejection, req };
export const T = 60_000;
export const ID = (n: number): string => idFor(1, n);

/** Orderables. Global (tenantId null) rows come from the fake defaults; X_* are added per tenant in `world`. */
export const O = {
  cbc: ID(100), glu: ID(101), ure: ID(102), cul: ID(103), bxr: ID(104), lft: ID(107), anaemia: ID(300),
  taxMissing: ID(110), tenantBOnly: ID(111),
} as const;
export const DEPT = { haem: ID(1), bio: ID(2) } as const;
export const REFERRER = ID(900);
export const CP = { ok: ID(910), locked: ID(911), over: ID(912), noCredit: ID(913), tenantB: ID(914) } as const;
export const PRICE_LIST = { a: { td: ID(1000), centre: ID(1001), referrer: ID(1002), credit: ID(1003) }, b: { td: ID(1010) } } as const;
const PERMISSION = 'frontdesk.registration.create';

const analyte = (n: number, code: string) => ({ id: ID(n), code, name: `${code} analyte`, resultType: 'numeric', reportable: true, sortOrder: 1 });
const testRow = (id: string, tenantId: string, code: string, an: number) => ({ id, tenantId, code, name: `${code} synthetic test`, departmentId: DEPT.bio, departmentCode: 'BIO',
  specimenTypeCodes: ['blood'], containerCode: 'edta', workflowType: 'standard', analytes: [analyte(an, code)], isActive: true, revision: 1 });

export interface WorldOpts {
  /** extra price lists, in C3 precedence order credit_party > referrer > centre > tenant_default (03-IC §4.2) */
  centreList?: boolean; referrerList?: boolean; creditList?: boolean;
  catalogRevision?: number;
  /** a later published version of tenant A's default list: CBC at this price, effective before NOW */
  cbcPriceV2?: number;
}
export function world(o: WorldOpts = {}) {
  const td = (t: string, id: string, extraCbc?: number) => ({ id, tenantId: t, code: 'TD', isActive: true, scope: 'tenant_default',
    versions: extraCbc === undefined ? [{ version: 1, status: 'published', effectiveFrom: '2026-01-01T00:00:00.000Z' }]
      : [{ version: 1, status: 'superseded', effectiveFrom: '2026-01-01T00:00:00.000Z' }, { version: 2, status: 'published', effectiveFrom: '2026-11-09T00:00:00.000Z' }],
    prices: [{ orderableId: O.cbc, unitPricePaisa: extraCbc ?? 50000, urgentSurchargePaisa: 10000 }, { orderableId: O.glu, unitPricePaisa: 20000 },
      { orderableId: O.ure, unitPricePaisa: 15000 }, { orderableId: O.anaemia, unitPricePaisa: 65000 }, { orderableId: O.taxMissing, unitPricePaisa: 10000 },
      ...(t === TENANT_B ? [{ orderableId: O.tenantBOnly, unitPricePaisa: 7000 }] : [])] });
  const one = (id: string, scope: string, scopeRefId: string | undefined, cbc: number) => ({ id, tenantId: TENANT_A, code: scope.toUpperCase(), isActive: true, scope, ...(scopeRefId ? { scopeRefId } : {}),
    versions: [{ version: 1, status: 'published', effectiveFrom: '2026-01-01T00:00:00.000Z' }], prices: [{ orderableId: O.cbc, unitPricePaisa: cbc }] });
  const priceLists: any[] = [td(TENANT_A, PRICE_LIST.a.td, o.cbcPriceV2), td(TENANT_B, PRICE_LIST.b.td)];
  if (o.centreList) priceLists.push(one(PRICE_LIST.a.centre, 'centre', CENTRE.a, 48000));
  if (o.referrerList) priceLists.push(one(PRICE_LIST.a.referrer, 'referrer', REFERRER, 45000));
  if (o.creditList) priceLists.push(one(PRICE_LIST.a.credit, 'explicit', undefined, 40000));
  const catalog = createFakeCatalogPort({ seed: 1, fixtures: {
    catalogRevision: o.catalogRevision ?? 1,
    tests: [testRow(O.taxMissing, TENANT_A, 'TCM', 610), testRow(O.tenantBOnly, TENANT_B, 'TBX', 611)] as any,
    priceLists,
    // F9 getReferrer is required (03-APP-FLOW §2.3): the fake's default id(900) belongs to the FAKE tenant, so seed one for the DB tenant A (ruling FD-T06 #2)
    referrers: [{ id: REFERRER, tenantId: TENANT_A, code: 'DR900', displayName: 'Dr. Synthetic Referrer', isVerified: true, isActive: true }] as any,
    taxRules: [{ id: ID(812), tenantId: null, orderableId: O.glu, vat: 'taxable' }, { id: ID(813), tenantId: null, orderableId: O.ure, vat: 'exempt', otherTaxCode: 'SC' },
      { id: ID(814), tenantId: null, orderableId: O.taxMissing, vat: 'exempt', otherTaxCode: 'NO_RATE_CONFIGURED' }] as any,
    taxRates: [{ id: ID(821), tenantId: null, taxCode: 'SC', kind: 'other', ratePercentBasisPoints: 200, effectiveFrom: null }] as any,
    creditParties: [{ id: CP.ok, tenantId: TENANT_A, code: 'CPOK', name: 'Synthetic Corp', kind: 'company', allowsCredit: true, isActive: true, priceListId: PRICE_LIST.a.credit }] as any,
  } });
  const billing = createFakeBillingCommandPort({ seed: 1, fixtures: { creditParties: [
    { id: CP.ok, tenantId: TENANT_A, allowsCredit: true, isActive: true, isLocked: false, creditLimitPaisa: 1_000_000, outstandingPaisa: 0 },
    { id: CP.locked, tenantId: TENANT_A, allowsCredit: true, isActive: true, isLocked: true, creditLimitPaisa: 1_000_000, outstandingPaisa: 0 },
    { id: CP.over, tenantId: TENANT_A, allowsCredit: true, isActive: true, isLocked: false, creditLimitPaisa: 1000, outstandingPaisa: 0 },
    { id: CP.noCredit, tenantId: TENANT_A, allowsCredit: false, isActive: true, isLocked: false, creditLimitPaisa: null, outstandingPaisa: 0 },
    { id: CP.tenantB, tenantId: TENANT_B, allowsCredit: true, isActive: true, isLocked: false, creditLimitPaisa: 1_000_000, outstandingPaisa: 0 },
  ] } });
  const results: any[] = [];
  const spied = { ...billing, computeQuote: async (c: unknown, i: unknown) => { const r = await (billing as any).computeQuote(c, i); results.push(r); return r; } };
  return { catalog, billing: spied, billingFake: billing, results };
}
export type World = ReturnType<typeof world>;

let limitsSeeded = false;
/** Settings rows + discount limits for both tenants (UPDATE after the idempotent seed, so another suite's earlier seed cannot leave different limits). */
export async function seedLimits(): Promise<void> {
  if (limitsSeeded) return;
  for (const [t, paisa] of [[TENANT_A, 0], [TENANT_B, 5000]] as const) {
    await seed('frontdesk.settings', { tenant_id: t, consent_text_version: CONSENT_VERSION, patient_search_min_chars: 3 });
    await superTx(async (tx) => { await tx.query(
      'UPDATE frontdesk.settings SET discount_self_limit_bp = 1000, discount_self_limit_paisa = $2, discount_absolute_max_bp = 5000 WHERE tenant_id = $1', [t, paisa]); }, t);
  }
  limitsSeeded = true;
}

export const draft = (o: Record<string, unknown> = {}) => ({
  patient: { patient_id: uid() }, centre_id: CENTRE.a, visit_type: 'opd', billing_mode: 'cash',
  items: [{ orderable_id: O.cbc }, { orderable_id: O.glu }], ...o,
});
export const bill = (o: Record<string, unknown>) => ({ scope: 'bill', reason_code: 'staff_family', ...o });
export const line = (orderable_id: string, o: Record<string, unknown>) => ({ scope: 'line', orderable_id, reason_code: 'staff_family', ...o });

export interface QuoteReply { status: number; body: any; probe: { logs: string[]; identity: ReturnType<typeof makeIdentity>; requestId: string }; wrote: boolean; w: World }
export interface CallOpts { grants?: readonly string[]; tenant?: string; w?: World; now?: Date; requestId?: string; centreIds?: readonly string[] }

/** One quote = one committed tx under RLS. `wrote` = the tx was assigned a transaction id, i.e. it performed a write (a read-only quote never does). */
export async function quote(body: unknown, o: CallOpts = {}): Promise<QuoteReply> {
  await seedLimits();
  const tenant = o.tenant ?? TENANT_A;
  const side = tenant === TENANT_B ? 'b' : 'a';
  const w = o.w ?? world();
  const identity = makeIdentity(o.grants ?? [PERMISSION], { centreIds: o.centreIds ?? [CENTRE[side]] });
  const logs: string[] = [];
  const requestId = o.requestId ?? uid();
  const out = await appTx(tenant, async (tx) => {
    const log = (lvl: string) => (obj: object, msg?: string) => { logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = {
      operationId: 'quoteRegistration', clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error') },
      tenantId: tenant, tx, requestId, now: () => o.now ?? NOW, centreId: CENTRE[side],
      actor: { type: 'system', id: SYS_ACTOR, membershipId: uid() },
      ports: { IdentityPort: identity, CatalogPort: w.catalog, BillingCommandPort: w.billing },
    };
    ctx.audit = { access: async (e: any) => { await access(ctx, e); } };
    const reply = await (handlers as any).quoteRegistration(req({ body }), ctx);
    const x = await tx.query('SELECT txid_current_if_assigned() AS x');
    return { ...reply, wrote: x.rows[0].x !== null };
  });
  return { ...out, probe: { logs, identity, requestId }, w };
}
export const quoteFails = (body: unknown, o: CallOpts = {}) => rejection(quote(body, o));
export const fp = (r: QuoteReply) => r.body.quote_fingerprint as string;
export const paisa = (m: { amount_paisa: number }) => m.amount_paisa;
export const orderableLines = (r: QuoteReply) => (r.body.lines as any[]).filter((l) => l.kind === 'orderable');
