// BL-T12 real-implementation harness for packages/fakes/contract-tests/BillingPort.contract.ts (not a test file).
// Returns the C0 ContractHarness shape (+ the suite's __ledgerRows / __reviewItems hooks) over the REAL createBillingPort({ repo, events }) with the BL-T11 refund world
// (in-memory repo seams, real core event publisher) plus ctx.ports fakes for IdentityPort (releaseRequiresPayment per tenant) and FrontdeskPort (order existence, billingMode).
// ASSUMED impl seam (writer: dispute via .orchestra/notes if wrong):
//   ports/BillingPort.impl.ts exports createBillingPort(deps: { repo?, events: BillingEvents }) -> BillingPortV1  (+ billingPort, the production singleton the manifest registers)
//   Every method runs in ctx.tx, no transaction of its own; the first thing each method does is the actor-type guard (user | system, else auth.forbidden), before any repo call.
// ASSUMED repo seams added by BL-T12 (all (tx, args), tenantId in args; rows snake_case like node-pg; bigint columns as strings; writer: dispute if wrong):
//   repo.findGatewayPayment(tx,{tenantId,gateway,gatewayTxnRef})       -> ledger row (capture_kind 'gateway', entry_kind 'payment') | undefined   (unique index ledger_entries__tenant_id_gateway_txn__p_uq)
//   repo.getPaymentIntentRef(tx,{tenantId,intentId})                   -> {intent_id,order_id,gateway,amount_paisa:string} | undefined            (billing.payment_intent_refs)
//   repo.sumGatewayByIntent(tx,{tenantId,intentId})                    -> {payments_paisa:string, refunds_paisa:string}  (gateway payments of the intent; earlier gateway refunds as a positive sum)
//   repo.insertFinanceReviewItem(tx,{id,tenantId,centreId,orderId,kind,ledgerEntryId,amountPaisa,userId}) -> row (snake_case billing.finance_review_items; status 'open', version 1)
//   repo.insertReleaseOverride(tx,{id,tenantId,orderId,centreId,reasonCode,reasonText,expiresAt,membershipId,userId}) -> row (snake_case billing.release_overrides incl. id, created_at)
//   plus the existing seams (lockOrderBalance, readOrderTotals, getOrderBalance, upsertOrderBalance, findActiveOverride, findLedgerByIdempotencyKey, insertLedgerEntry, insertActivity, findInvoiceForPayment).
// The fixture rows are the shared suite's: { settings, orders:[{orderId,tenantId,invoicedPaisa,paidPaisa,creditedPaisa,hasInvoice,balanceVersion,creditPartyId?,overrideId?}], intents:[{intentId,tenantId,orderId,amountPaisa}] };
// seeding an order again replaces it (the suite re-seeds settings + orders in case 3). The harness copies LimsError.detail to .safeDetail like harness.ts.
// Synthetic data only.
import { makeCtxFor, type ContractHarness } from '../../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../../core/errors.js';
import { pgError } from '../../../../core/events/__tests__/helpers.js';
import { createBillingEvents } from '../../events/publish.js';
import { BASE, IDS, makeRefundWorld, V7 } from '../../service/__tests__/t11.helpers.js';

export interface OrderFixture { orderId: string; tenantId: string; invoicedPaisa: number; paidPaisa: number; creditedPaisa: number; hasInvoice: boolean; balanceVersion: number;
  creditPartyId?: string; overrideId?: string; overrideExpiresAt?: string | null }

export function makeBillingPortWorld() {
  const w: any = makeRefundWorld({ invoiceNet: null });
  const st = w.s as any;
  st.settings = new Map<string, boolean>(); st.intentRefs = [] as any[]; st.overrides = [] as any[]; st.meta = new Map<string, { creditPartyId?: string; hasInvoice: boolean }>(); st.creditedBy = new Map<string, number>();
  const r: any = w.repo;
  const L = (): any[] => (w.s as any).ledger;
  const RV = (): any[] => (w.s as any).reviewItems;
  const k = (tenantId: string, orderId: string) => `${tenantId}|${orderId}`;
  const rec = (name: string, a: any) => { if (typeof a?.tenantId !== 'string') throw new Error(`fake repo: ${name} called without a tenant id`); w.repoCalls.push({ name, args: a }); };
  let seq = 0;
  const nextId = () => V7(`0000${(0xb0000 + ++seq).toString(16).padStart(8, '0')}`);

  // ---- order totals: per-order billing mode, credited, "known order without invoice" ----
  const baseTotals = r.readOrderTotals;
  r.readOrderTotals = async (tx: unknown, a: any) => {
    const meta = st.meta.get(k(a.tenantId, a.orderId));
    const t = await baseTotals(tx, a);
    if (!meta) return t;
    const row = t ?? { invoiced_paisa: '0', paid_paisa: '0', credited_paisa: '0', issued_invoice_count: 0, centre_id: IDS.centre, branch_id: IDS.branch, billing_mode: 'cash' };
    return { ...row, credited_paisa: String(st.creditedBy.get(k(a.tenantId, a.orderId)) ?? 0), billing_mode: meta.creditPartyId ? 'credit' : 'cash' };
  };
  r.findActiveOverride = async (_tx: unknown, a: any) => {
    rec('findActiveOverride', a);
    const rows = st.overrides.filter((o: any) => o.tenant_id === a.tenantId && o.order_id === a.orderId && o.is_active && (o.expires_at == null || Date.parse(o.expires_at) > Date.parse(a.at)));
    rows.sort((x: any, y: any) => (x.created_at < y.created_at ? 1 : -1));
    return rows[0] && structuredClone(rows[0]);
  };

  // ---- BL-T12 seams ----
  w.hideNextGatewayLookup = false;
  r.findGatewayPayment = async (_tx: unknown, a: any) => {
    rec('findGatewayPayment', a);
    if (w.hideNextGatewayLookup) { w.hideNextGatewayLookup = false; return undefined; }   // a concurrent commit this read did not see
    const e = L().find((x) => x.tenant_id === a.tenantId && x.capture_kind === 'gateway' && x.entry_kind === 'payment' && x.gateway === a.gateway && x.gateway_txn_ref === a.gatewayTxnRef);
    return e && structuredClone(e);
  };
  r.getPaymentIntentRef = async (_tx: unknown, a: any) => {
    rec('getPaymentIntentRef', a);
    const i = st.intentRefs.find((x: any) => x.tenant_id === a.tenantId && x.intent_id === a.intentId);
    return i && structuredClone(i);
  };
  r.sumGatewayByIntent = async (_tx: unknown, a: any) => {
    rec('sumGatewayByIntent', a);
    const mine = L().filter((x) => x.tenant_id === a.tenantId && x.capture_kind === 'gateway' && x.intent_id === a.intentId);
    const sum = (kind: string) => mine.filter((x) => x.entry_kind === kind).reduce((t, x) => t + Math.abs(Number(x.amount_paisa)), 0);
    return { payments_paisa: String(sum('payment')), refunds_paisa: String(sum('refund')) };
  };
  r.insertFinanceReviewItem = async (_tx: unknown, a: any) => {
    rec('insertFinanceReviewItem', a);
    if (!['home_payment_exceeds_due', 'gateway_payment_exceeds_due', 'home_payment_method_inactive'].includes(a.kind)) throw pgError('23514', 'violates check constraint "finance_review_items__kind__ck"');
    if (!L().some((x) => x.tenant_id === a.tenantId && x.id === a.ledgerEntryId)) throw pgError('23503', 'violates foreign key "finance_review_items__entry__fk"');
    const row = { id: a.id, tenant_id: a.tenantId, centre_id: a.centreId, order_id: a.orderId, kind: a.kind, ledger_entry_id: a.ledgerEntryId, amount_paisa: String(a.amountPaisa), status: 'open', resolution_code: null,
      note: null, refund_ledger_entry_id: null, resolved_at: null, resolved_by: null, version: 1, is_active: true, created_at: BASE, created_by: a.userId, updated_at: BASE, updated_by: a.userId };
    RV().push(row); return structuredClone(row);
  };
  r.insertReleaseOverride = async (_tx: unknown, a: any) => {
    rec('insertReleaseOverride', a);
    const row = { id: a.id, tenant_id: a.tenantId, order_id: a.orderId, centre_id: a.centreId, reason_code: a.reasonCode, reason_text: a.reasonText ?? null, expires_at: a.expiresAt ?? null,
      membership_id: a.membershipId, is_active: true, created_at: new Date(Date.parse(BASE) + 1000 * (st.overrides.length + 1)).toISOString(), created_by: a.userId };
    st.overrides.push(row); return structuredClone(row);
  };
  // the gateway unique index (05-SCHEMA ledger_entries__tenant_id_gateway_txn__p_uq) on top of the BL-T11 ledger fake (which already models the collector / gateway CHECKs)
  const baseInsert = r.insertLedgerEntry;
  r.insertLedgerEntry = async (tx: unknown, e: any) => {
    if (e.captureKind === 'gateway' && e.entryKind === 'payment' && L().some((x) => x.tenant_id === e.tenantId && x.capture_kind === 'gateway' && x.entry_kind === 'payment' && x.gateway === e.gateway && x.gateway_txn_ref === e.gatewayTxnRef)) {
      throw Object.assign(pgError('23505', 'duplicate key "ledger_entries__tenant_id_gateway_txn__p_uq"'), { constraint: 'ledger_entries__tenant_id_gateway_txn__p_uq' });
    }
    return baseInsert(tx, e);
  };

  const fakePorts = {
    IdentityPort: { async getTenantSettings(c: any, input: { keys: readonly string[] }) { w.idCalls.push(input); return { ...w.tenantSettings, releaseRequiresPayment: st.settings.get(c.tenantId) ?? true }; } },
    FrontdeskPort: {
      async getOrderSummary(c: any, i: { orderId: string }) {
        const m = st.meta.get(k(c.tenantId, i.orderId));
        if (!m) throw new LimsError('common.not_found');
        return { orderId: i.orderId, registrationNo: 'R-0001', patientId: IDS.patient, branchId: IDS.branch, centreId: IDS.centre, visitType: 'opd', billingMode: m.creditPartyId ? 'credit' : 'cash', priority: 'routine', status: 'registered', source: 'front_desk', items: [] };
      },
    },
  };
  /** harness ctx -> the ctx a handler would hand the port: event-db tx, port fakes; staff users get a membership, system / patient / portal actors never do. */
  const enrich = (c: any) => {
    const base: any = w.ctx();
    return { ...c, tx: base.tx, actor: c.actor.type === 'user' ? { ...c.actor, membershipId: c.actor.membershipId ?? c.actor.id } : c.actor, ports: { ...base.ports, ...fakePorts, ...c.ports } };
  };
  const deps = { repo: w.repo, events: createBillingEvents(w.events as never) } as never;

  function seedOrder(o: OrderFixture) {
    const key = k(o.tenantId, o.orderId);
    st.invoices = st.invoices.filter((i: any) => !(i.__seed && i.tenant_id === o.tenantId && i.order_id === o.orderId));
    st.ledger = st.ledger.filter((e: any) => !(e.__seed && e.tenant_id === o.tenantId && e.order_id === o.orderId));
    st.overrides = st.overrides.filter((x: any) => !(x.__seed && x.tenant_id === o.tenantId && x.order_id === o.orderId));
    delete st.balances[key];
    st.meta.set(key, { hasInvoice: o.hasInvoice, ...(o.creditPartyId ? { creditPartyId: o.creditPartyId } : {}) });
    st.creditedBy.set(key, o.creditedPaisa);
    if (o.hasInvoice) st.invoices.push({ __seed: true, id: nextId(), tenant_id: o.tenantId, order_id: o.orderId, net_paisa: o.invoicedPaisa, purpose: 'registration', status: 'issued' });
    if (o.paidPaisa > 0) w.addLedger({ __seed: true, id: nextId(), tenant_id: o.tenantId, order_id: o.orderId, amount_paisa: o.paidPaisa });
    if (o.overrideId) st.overrides.push({ __seed: true, id: o.overrideId, tenant_id: o.tenantId, order_id: o.orderId, centre_id: IDS.centre, reason_code: 'SYN_REASON', reason_text: null, expires_at: o.overrideExpiresAt ?? null,
      membership_id: IDS.patient, is_active: true, created_at: BASE, created_by: IDS.patient });
    st.balances[key] = { tenant_id: o.tenantId, order_id: o.orderId, centre_id: IDS.centre, billing_mode: o.creditPartyId ? 'credit' : 'cash', invoiced_paisa: o.hasInvoice ? o.invoicedPaisa : 0, paid_paisa: o.paidPaisa,
      credited_paisa: o.creditedPaisa, balance_due_paisa: (o.hasInvoice ? o.invoicedPaisa : 0) - o.creditedPaisa - o.paidPaisa, balance_version: o.balanceVersion, release_basis: 'due_outstanding' };
  }
  const invoiceIdOf = (tenantId: string, orderId: string): string | undefined => st.invoices.find((i: any) => i.tenant_id === tenantId && i.order_id === orderId)?.id;
  return Object.assign(w, { deps, enrich, fakePorts, st, seedOrder, invoiceIdOf, ledgerRowsOf: (tenantId: string, orderId: string) => L().filter((e) => e.tenant_id === tenantId && e.order_id === orderId) });
}
export type BillingPortWorld = ReturnType<typeof makeBillingPortWorld>;

const withSafeDetail = (e: any) => { if (e && typeof e === 'object' && e.detail !== undefined && e.safeDetail === undefined) e.safeDetail = e.detail; return e; };

/** () => Promise<ContractHarness & { world }> over the real implementation (dynamic import: the harness self-tests pass before the impl exists). */
export function realBillingPortHarness(): () => Promise<ContractHarness & { world: BillingPortWorld; real: any }> {
  return async () => {
    const world = makeBillingPortWorld();
    const mod: any = await import('../../ports/BillingPort.impl.js');
    const real = mod.createBillingPort(world.deps);
    const st = world.st;
    const hooks: Record<string, (c: any, orderId: string) => unknown> = {
      __ledgerRows: (c, orderId) => world.ledgerRowsOf(c.tenantId, orderId).length,
      __reviewItems: (c, orderId) => (world.s as any).reviewItems.filter((i: any) => i.tenant_id === c.tenantId && i.order_id === orderId).map((i: any) => i.kind),
    };
    const impl: any = new Proxy({}, {
      get: (_t, m) => {
        if (typeof m !== 'string' || m === 'then') return undefined;
        if (m in hooks) return hooks[m];
        return async (c: any, i: unknown) => {
          if (typeof real[m] !== 'function') throw new Error(`BillingPort impl lacks ${m}`);
          try { return await real[m](world.enrich(c), i); } catch (e) { throw withSafeDetail(e); }
        };
      },
    });
    return {
      impl, world, real,
      ctxFor: makeCtxFor(),
      events: { ofType: (t: string) => world.db.events.filter((e: any) => e.eventType === t).map((e: any) => e.envelope) } as never,
      async seed(f: any) {
        for (const s of f.settings ?? []) st.settings.set(s.tenantId, s.releaseRequiresPayment);
        for (const o of f.orders ?? []) world.seedOrder(o);
        for (const i of f.intents ?? []) {
          st.intentRefs = st.intentRefs.filter((x: any) => !(x.tenant_id === i.tenantId && x.intent_id === i.intentId));
          st.intentRefs.push({ tenant_id: i.tenantId, intent_id: i.intentId, order_id: i.orderId, gateway: i.gateway ?? 'esewa', amount_paisa: String(i.amountPaisa) });
        }
      },
      rollback() { /* the shared suite never rolls back */ },
    } as never;
  };
}
