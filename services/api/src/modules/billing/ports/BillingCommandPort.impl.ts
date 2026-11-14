// BillingCommandPort implementation (02-TRD §6.3, 03-IC §4.15; PRD US-FD-03.1–.7, US-FD-04.1–.4). Composes computeQuote + the invoice and ledger services.
// Every method runs in the caller's transaction (ctx.tx): no transaction of its own, so a later throw rolls back all of it, counter bump included.
// Tenant and actor come from ctx only. Order existence goes through ctx.ports.FrontdeskPort.getOrderSummary (tenant-scoped, common.not_found otherwise);
// the credit party through ctx.ports.CatalogPort.getCreditParty({ purpose: 'billing' }). Ordering rule: any check that can refuse runs before any write.
import type { BillingCommandPortV1, ComputedLine, QuoteResult, Totals } from '../../../../../../contracts/ports/BillingCommandPort.js';
import type { OrderBalance } from '../../../../../../contracts/ports/BillingPort.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { createEvents } from '../../../core/events/publish.js';
import { toPaisa } from '../domain/money/paisa.js';
import { createBillingEvents, type BillingEvents } from '../events/publish.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import type { BalanceCtx } from '../service/balance.service.js';
import { createCounterService } from '../service/counter.service.js';
import { createInvoiceService } from '../service/invoice.service.js';
import { iso, isRec, UUID } from '../service/invoiceRead.service.js';
import { createLedgerService } from '../service/ledger.service.js';
import { DEFAULT_TZ, localDate } from '../service/ledgerDto.js';
import { computeQuote } from '../service/quote.service.js';

type Ctx = BalanceCtx & { readonly ports?: Record<string, any> };
interface Counter { allocate(tx: never, input: any): Promise<{ lastNo: number; allocatedAt: string }> }

const CONTROL = /[\u0000-\u001f\u007f]/;
const CAUSES = ['order_cancelled', 'item_removed'] as const;
const invalid = (...paths: string[]): LimsError => new LimsError('common.validation_failed', undefined, paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));
const npr = (amountPaisa: number) => ({ amountPaisa, currency: 'NPR' as const });
const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const code = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 64 && !CONTROL.test(v);

function uuidList(v: unknown, path: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 500 || !v.every(uuid)) throw invalid(path);
  return v as string[];
}
function session(ctx: Ctx): { tenantId: string; actorId: string; tx: never } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tenantId: ctx.tenantId, actorId: ctx.actor.id, tx: ctx.tx as never };
}
function port<T>(ctx: Ctx, name: string): T {
  const p = ctx.ports?.[name];
  if (!p) throw new LimsError('common.internal');
  return p as T;
}
/** The order must exist for this tenant (C6 answers common.not_found otherwise): the first call of every order-scoped method. */
async function assertOrder(ctx: Ctx, orderId: unknown): Promise<string> {
  if (!uuid(orderId)) throw invalid('/orderId');
  await port<{ getOrderSummary(c: Ctx, i: { orderId: string }): Promise<unknown> }>(ctx, 'FrontdeskPort').getOrderSummary(ctx, { orderId });
  return orderId;
}

export function createBillingCommandPort(deps: { repo?: BillingRepo; counter: Counter; events: BillingEvents }): BillingCommandPortV1 {
  const repo = deps.repo ?? billingRepo;
  const invoices = createInvoiceService({ repo, counter: deps.counter as never, events: deps.events });
  const ledger = createLedgerService({ repo, counter: deps.counter as never, events: deps.events });

  /** Locked account, C3 inactive or allowsCredit = false -> credit_party_locked; account limit vs. open exposure + additional -> credit_limit_exceeded. */
  async function checkCredit(ctx: Ctx, party: { allowsCredit: boolean; isActive: boolean }, creditPartyId: string, additional: number): Promise<void> {
    const { tenantId, tx } = session(ctx);
    if (!party.allowsCredit || !party.isActive) throw new LimsError('billing.credit_party_locked');
    const account = await repo.getCreditAccount(tx, { tenantId, creditPartyId });
    if (account?.['is_locked'] === true) throw new LimsError('billing.credit_party_locked');
    const limit = account?.['credit_limit_paisa'];
    if (limit === null || limit === undefined) return;                                   // no limit set: nothing to compare
    const open = toPaisa(await repo.sumOpenCreditExposure(tx, { tenantId, creditPartyId }));
    if (open + additional > toPaisa(limit)) throw new LimsError('billing.credit_limit_exceeded');
  }
  const getParty = (ctx: Ctx, creditPartyId: string) =>
    port<{ getCreditParty(c: Ctx, i: { creditPartyId: string; purpose: 'billing' }): Promise<any> }>(ctx, 'CatalogPort').getCreditParty(ctx, { creditPartyId, purpose: 'billing' });

  async function assertCreditAllowed(ctx: Ctx, input: { creditPartyId: string; additional: { amountPaisa: number; currency: string } }): Promise<void> {
    session(ctx);
    if (!isRec(input) || !uuid(input.creditPartyId)) throw invalid('/creditPartyId');
    const add = input.additional;
    if (!isRec(add) || add['currency'] !== 'NPR' || !Number.isSafeInteger(add['amountPaisa']) || add['amountPaisa'] < 0) throw invalid('/additional');
    await checkCredit(ctx, await getParty(ctx, input.creditPartyId), input.creditPartyId, add['amountPaisa']);
  }

  async function recordCreditCharges(ctx: Ctx, input: any) {
    const { tenantId, actorId, tx } = session(ctx);
    if (!isRec(input)) throw invalid('/');
    const bad = ['creditPartyId', 'branchId', 'centreId'].filter((k) => !uuid(input[k]));
    if (input['referrerId'] !== undefined && !uuid(input['referrerId'])) bad.push('referrerId');
    const name = input['patientDisplayName'];
    if (typeof name !== 'string' || name.trim() === '' || name.length > 200 || CONTROL.test(name)) bad.push('patientDisplayName');
    if (!Array.isArray(input['lines']) || input['lines'].length === 0 || input['lines'].length > 200) bad.push('lines');
    if (!Array.isArray(input['discounts'])) bad.push('discounts');
    if (typeof input['expectedFingerprint'] !== 'string') bad.push('expectedFingerprint');
    if (!uuid(input['orderId'])) bad.push('orderId');
    if (bad.length) throw invalid(...bad.map((k) => `/${k}`));
    const orderId = await assertOrder(ctx, input['orderId']);

    // the fingerprint is recomputed, never trusted (catalog.tax_config_missing propagates)
    const quote = await computeQuote(ctx as never, { lines: input['lines'], discounts: input['discounts'] });
    if (quote.fingerprint !== input['expectedFingerprint']) throw new LimsError('common.version_conflict');

    const party = await getParty(ctx, input['creditPartyId']);
    // snapshot first: it also locks the account row, so concurrent batches of one party check the limit one after the other
    await repo.upsertCreditAccount(tx, { tenantId, creditPartyId: input['creditPartyId'], partyCode: party.code, partyName: party.name,
      ...(typeof party.pan === 'string' ? { pan: party.pan } : {}), ...(typeof party.billingAddressText === 'string' ? { address: party.billingAddressText } : {}), userId: actorId });
    await checkCredit(ctx, party, input['creditPartyId'], quote.totals.net.amountPaisa);

    const idp = ctx.ports?.['IdentityPort'];
    const tenant = idp ? await idp.getTenantSettings(ctx, { keys: ['timezone'] }) : undefined;
    const chargedAt = ctx.now();
    const periodMonth = localDate(chargedAt, typeof tenant?.timezone === 'string' ? tenant.timezone : DEFAULT_TZ).slice(0, 8) + '01';  // first day of the A.D. month, tenant tz
    const rows = quote.lines.map((l: ComputedLine) => ({
      id: uuidv7(), tenant_id: tenantId, credit_party_id: input['creditPartyId'], order_id: orderId, order_item_id: l.orderItemId ?? null, branch_id: input['branchId'],
      centre_id: input['centreId'], referrer_id: input['referrerId'] ?? null, patient_display_name: name.trim(), line_kind: l.lineKind, orderable_id: l.orderableId,
      code: l.code, name: l.name, department_id: l.departmentId ?? null, unit_price_paisa: l.gross.amountPaisa, gross_paisa: l.gross.amountPaisa,
      discount_paisa: l.discount.amountPaisa, vat_treatment: l.tax.vat, other_tax_code: l.tax.otherTaxCode ?? null, charged_at: chargedAt, period_month: periodMonth,
      status: 'uninvoiced', created_by: actorId, updated_by: actorId,
    }));
    await repo.insertCreditCharges(tx, rows);
    return { chargeIds: rows.map((r) => r.id), totals: quote.totals as Totals };
  }

  async function voidCreditCharges(ctx: Ctx, input: any) {
    const { tenantId, actorId, tx } = session(ctx);
    if (!isRec(input)) throw invalid('/');
    const items = uuidList(input['orderItemIds'], '/orderItemIds');
    if (!code(input['reasonCode'])) throw invalid('/reasonCode');
    const orderId = await assertOrder(ctx, input['orderId']);
    const scope = items && new Set(items);
    const charges = (await repo.listCreditChargesByOrder(tx, { tenantId, orderId, lock: true }))
      .filter((c) => !scope || (typeof c['order_item_id'] === 'string' && scope.has(c['order_item_id'])));
    const voided = await repo.voidCreditChargesByIds(tx, { tenantId, ids: charges.filter((c) => c['status'] === 'uninvoiced').map((c) => String(c['id'])), reasonCode: input['reasonCode'], userId: actorId });
    return { voided, alreadyInvoiced: charges.filter((c) => c['status'] === 'invoiced').map((c) => String(c['id'])) };
  }

  async function raiseCreditNoteRequirement(ctx: Ctx, input: any) {
    const { tenantId, actorId, tx } = session(ctx);
    if (!isRec(input)) throw invalid('/');
    const items = uuidList(input['orderItemIds'], '/orderItemIds');
    if (!CAUSES.includes(input['cause'])) throw invalid('/cause');
    if (!code(input['reasonCode'])) throw invalid('/reasonCode');
    const orderId = await assertOrder(ctx, input['orderId']);
    const scope = items && new Set(items);
    const inScope = (itemId: unknown) => !scope || (typeof itemId === 'string' && scope.has(itemId));

    const tasks: Array<{ invoice_id: string; centre_id: unknown; invoice_line_ids: string[] }> = [];
    // (a) the order's own issued invoices: whole order = every issued invoice; item scope = only invoices that carry one of the items
    const lines = await repo.listInvoiceLinesByOrder(tx, { tenantId, orderId });
    for (const inv of await repo.listInvoicesByOrder(tx, { tenantId, orderId })) {
      if (inv['status'] !== 'issued') continue;                                          // a cancelled invoice needs no credit note
      const invoiceId = String(inv['id']);
      const ids = lines.filter((l) => l.invoice_id === invoiceId && inScope(l.order_item_id)).map((l) => l.id);
      if (scope && ids.length === 0) continue;
      tasks.push({ invoice_id: invoiceId, centre_id: inv['centre_id'] ?? null, invoice_line_ids: ids });
    }
    // (b) charges already on a periodic credit bill: one task per periodic invoice, with the charges' invoice lines
    const byInvoice = new Map<string, { centre_id: unknown; ids: string[] }>();
    for (const c of await repo.listCreditChargesByOrder(tx, { tenantId, orderId })) {
      if (c['status'] !== 'invoiced' || typeof c['invoice_id'] !== 'string' || !inScope(c['order_item_id'])) continue;
      const g: { centre_id: unknown; ids: string[] } = byInvoice.get(c['invoice_id']) ?? { centre_id: c['centre_id'] ?? null, ids: [] };
      if (typeof c['invoice_line_id'] === 'string') g.ids.push(c['invoice_line_id']);
      byInvoice.set(c['invoice_id'], g);
    }
    for (const [invoice_id, g] of byInvoice) tasks.push({ invoice_id, centre_id: g.centre_id, invoice_line_ids: g.ids });

    const taskIds: string[] = [];
    for (const t of tasks) {
      const id = uuidv7();
      await repo.insertCreditNoteTask(tx, { id, tenant_id: tenantId, ...t, order_id: orderId, cause: input['cause'], reason_code: input['reasonCode'], required: true, status: 'open', created_by: actorId });
      taskIds.push(id);
    }
    return { required: taskIds.length > 0, taskIds };
  }

  async function getOrderBillingSummary(ctx: Ctx, input: any) {
    const { tenantId, tx } = session(ctx);
    const orderId = await assertOrder(ctx, isRec(input) ? input['orderId'] : undefined);
    const invs = await repo.listInvoicesByOrder(tx, { tenantId, orderId });
    const charges = await repo.listCreditChargesByOrder(tx, { tenantId, orderId });
    const totals = await repo.readOrderTotals(tx, { tenantId, orderId });
    const bal = await repo.getOrderBalance(tx, { tenantId, orderId });
    const invoiced = totals ? toPaisa(totals.invoiced_paisa) : 0, paid = totals ? toPaisa(totals.paid_paisa) : 0, credited = totals ? toPaisa(totals.credited_paisa) : 0;
    const balance: OrderBalance = { orderId, invoiced: npr(invoiced), paid: npr(paid), credited: npr(credited), balanceDue: npr(invoiced - credited - paid),
      balanceVersion: bal ? Number(bal['balance_version']) : 0, asOf: (bal?.['updated_at'] ? iso(bal['updated_at']) : ctx.now()) as OrderBalance['asOf'] };
    return {
      invoiceIds: invs.map((i) => String(i['id'])), hasIssuedInvoice: invs.some((i) => i['status'] === 'issued'),
      creditChargeIds: charges.filter((c) => c['status'] !== 'voided').map((c) => String(c['id'])), balance,
    };
  }

  return {
    async computeQuote(ctx, input): Promise<QuoteResult> { return computeQuote(ctx, input); },
    assertCreditAllowed: assertCreditAllowed as BillingCommandPortV1['assertCreditAllowed'],
    async issueOrderInvoice(ctx, input) {
      await assertOrder(ctx as Ctx, (input as any)?.orderId);
      return invoices.issue(ctx as never, input);
    },
    recordCreditCharges: recordCreditCharges as BillingCommandPortV1['recordCreditCharges'],
    voidCreditCharges: voidCreditCharges as BillingCommandPortV1['voidCreditCharges'],
    async recordPayment(ctx, input) {
      await assertOrder(ctx as Ctx, (input as any)?.orderId);
      const { entry: _entry, ...result } = await ledger.recordPayment(ctx as never, input);   // `entry` is B8's DTO, not part of the port result
      void _entry;
      return result as Awaited<ReturnType<BillingCommandPortV1['recordPayment']>>;
    },
    raiseCreditNoteRequirement: raiseCreditNoteRequirement as BillingCommandPortV1['raiseCreditNoteRequirement'],
    getOrderBillingSummary: getOrderBillingSummary as BillingCommandPortV1['getOrderBillingSummary'],
  };
}

/** Production wiring for the manifest: real counter + core event publisher, built on first use (no I/O at import time). */
let built: BillingCommandPortV1 | undefined;
const real = (): BillingCommandPortV1 => (built ??= createBillingCommandPort({ counter: createCounterService() as never, events: createBillingEvents(createEvents({ producer: 'billing' }) as never) }));
export const billingCommandPort: BillingCommandPortV1 = {
  computeQuote: (c, i) => real().computeQuote(c, i),
  assertCreditAllowed: (c, i) => real().assertCreditAllowed(c, i),
  issueOrderInvoice: (c, i) => real().issueOrderInvoice(c, i),
  recordCreditCharges: (c, i) => real().recordCreditCharges(c, i),
  voidCreditCharges: (c, i) => real().voidCreditCharges(c, i),
  recordPayment: (c, i) => real().recordPayment(c, i),
  raiseCreditNoteRequirement: (c, i) => real().raiseCreditNoteRequirement(c, i),
  getOrderBillingSummary: (c, i) => real().getOrderBillingSummary(c, i),
};
