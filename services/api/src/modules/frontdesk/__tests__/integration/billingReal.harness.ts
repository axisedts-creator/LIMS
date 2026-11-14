// J-T01 harness: the FD-T06 registration harness (../registration/helpers.ts: real PG17 tx under RLS, real core events, fake Catalog/Notification/Identity)
// with ONE port swapped: BillingCommandPort = the REAL BL-T07 implementation (createBillingCommandPort over the real billing repo, real fiscal counter, real
// core event publisher). Nothing about billing is faked: invoice numbers come from billing.fiscal_counters, rows land in billing.*, events in core.event_log.
// Stand-ins that are NOT billing: FrontdeskPort (C6 side, "fake until FD-T11" in 06-IMPLEMENTATION-PLAN §dependency table) is a tx-local read of frontdesk.orders,
// because real billing asks it whether the order the registration just inserted exists (BillingCommandPort.impl.ts assertOrder); Identity/Catalog/Notification stay fakes.
// Ctx shape: same ASSUMED shape as ../registration/helpers.ts (+ ctx.ports.FrontdeskPort).
import { LimsError } from '../../../../core/errors.js';
import { createEvents } from '../../../../core/events/publish.js';
import { createBillingCommandPort } from '../../../billing/ports/BillingCommandPort.impl.js';
import { createBillingEvents } from '../../../billing/events/publish.js';
import { createCounterService } from '../../../billing/service/counter.service.js';
import { handlers } from '../../handlers/index.js';
import { appTx, rejection, req, seed, uid, superTx, ownerRows, TENANT_A, TENANT_B, CENTRE, BRANCH } from '../patients/helpers.js';
import { ctxFor, ensureTaskRegistry, rworld, type RegOpts, type RegReply, type RWorld } from '../registration/helpers.js';
import { seedLimits } from '../quote/helpers.js';

export { appTx, ownerRows, superTx, uid, TENANT_A, TENANT_B, CENTRE, BRANCH };

/** The port exactly as the billing manifest wires it in production (billing/ports/BillingCommandPort.impl.ts `real()`), but built here so a test can wrap it. */
export function realBilling() {
  return createBillingCommandPort({ counter: createCounterService() as never, events: createBillingEvents(createEvents({ producer: 'billing' }) as never) });
}

/** C6's getOrderSummary as far as billing uses it: tenant-scoped, sees rows inserted earlier in the SAME tx, common.not_found otherwise. */
export const frontdeskPort = {
  async getOrderSummary(c: { tx: { query(t: string, v?: unknown[]): Promise<{ rows: any[] }> }; tenantId: string }, i: { orderId: string }) {
    const r = (await c.tx.query('SELECT id, billing_mode FROM frontdesk.orders WHERE tenant_id = $1 AND id = $2', [c.tenantId, i.orderId])).rows;
    if (r.length === 0) throw new LimsError('common.not_found');
    return { orderId: r[0].id as string, billingMode: r[0].billing_mode as string };
  },
};

export interface RealWorld extends RWorld { realPort: ReturnType<typeof realBilling>; issued: Array<{ invoiceNo: string; invoiceId: string; orderId: string }>; creditOrders: string[] }
/** Catalog/Notification world of the FD harness, with billing replaced by the real port. `issued` records every invoice number real billing allocated, rolled back or not. */
export function realWorld(o: Parameters<typeof rworld>[0] = {}): RealWorld {
  const w = rworld(o) as RealWorld;
  const real = realBilling();
  w.realPort = real;
  w.issued = [];
  w.creditOrders = [];
  w.billing = { ...real,
    issueOrderInvoice: async (c: any, i: any) => {
      const out = await real.issueOrderInvoice(c, i);
      w.issued.push({ invoiceNo: out.invoiceNo, invoiceId: out.invoiceId, orderId: i.orderId });
      return out;
    },
    recordCreditCharges: async (c: any, i: any) => {
      const out = await real.recordCreditCharges(c, i);
      w.creditOrders.push(i.orderId);
      return out;
    } } as never;
  return w;
}

let seeded = false;
/** billing.cs_payment_methods is per tenant and not in db/seeds: the cash method both synthetic tenants register with. Superuser, idempotent. */
export async function ensureBillingSeed(): Promise<void> {
  if (seeded) return;
  for (const t of [TENANT_A, TENANT_B]) {
    await seed('billing.cs_payment_methods', { tenant_id: t, code: 'cash', display: 'Cash', is_cash: true, requires_reference: false, sort_order: 1, id: uid() });
  }
  // Real billing queues job billing.cbms_sync inside the invoice tx (cbms.repo.ts enqueueCbmsSync -> app.enqueue_job); app.enqueue_job rejects identifiers absent from
  // core.g_task_registry. The deploy step registry-sync.ts fills it (02-TRD:790); same precedent as ensureTaskRegistry (ruling FD-T06 #1). Superuser, idempotent.
  await superTx(async (tx) => { await tx.query(
    `INSERT INTO core.g_task_registry (identifier,module,kind,scope,max_attempts) VALUES ('billing.cbms_sync','billing','task','per_tenant',25) ON CONFLICT DO NOTHING`); });
  seeded = true;
}

/** db/seeds/010 active memberships (a500 / b500). Real billing opens a cash_session for the cashier: billing.cash_sessions has an FK to core.memberships, so a random uuid is refused. */
export const MEMBERSHIP = { [TENANT_A]: '01a1a98a-ac40-7000-8000-00000000a500', [TENANT_B]: '01a1a98a-ac40-7000-8000-00000000b500' } as Record<string, string>;
/** ctxFor + what real billing needs on top: FrontdeskPort and a real membership as the actor. */
export function realCtx(ctx: any, tenant: string): any {
  ctx.ports = { ...ctx.ports, FrontdeskPort: frontdeskPort };
  ctx.actor = { ...ctx.actor, membershipId: MEMBERSHIP[tenant] };
  return ctx;
}

export interface RealOpts extends RegOpts { tenant?: string }
/** One registration = one request tx under RLS (as ../registration/helpers.ts `register`), real billing. On throw the tx rolls back and in-memory spies drop what it queued. */
export async function registerReal(body: unknown, o: RealOpts & { w: RealWorld }): Promise<RegReply> {
  await seedLimits();
  await ensureTaskRegistry();
  await ensureBillingSeed();
  const tenant = o.tenant ?? TENANT_A;
  const w = o.w;
  const probe: RegReply['probe'] = { logs: [], accessCalls: [], identity: undefined, requestId: o.requestId ?? uid(), ctx: undefined };
  const out = await appTx(tenant, async (tx) => {
    const ctx = ctxFor(tx, tenant, w, o, probe);
    realCtx(ctx, tenant);
    probe.ctx = ctx;
    try { return await (handlers as any).createRegistration(req({ body, headers: o.headers ?? {} }), ctx); }
    catch (e) { w.spy.rollback(tx); w.notif.__rollback(tx); throw e; }
  });
  return { ...out, probe, w };
}
export const registerRealFails = (body: unknown, o: RealOpts & { w: RealWorld }) => rejection(registerReal(body, o));

// ---- owner-side truth (no RLS) ----
const SERIES = 'INV';
/** Current invoice counter of the tenant (series INV, tenant scope = default billing settings). 0 when the row does not exist yet. */
export const invoiceCounter = async (tenant: string): Promise<number> => {
  const r = await ownerRows('billing.fiscal_counters', 'tenant_id = $1 AND series = $2 ORDER BY fiscal_year_bs DESC', [tenant, SERIES]);
  return r.length ? Number(r[0].last_no) : 0;
};
export const invoicesOf = (orderId: string) => ownerRows('billing.invoices', 'order_id = $1', [orderId]);
export const ledgerOf = (orderId: string) => ownerRows('billing.ledger_entries', 'order_id = $1 ORDER BY created_at, id', [orderId]);
export const balanceOf = (orderId: string) => ownerRows('billing.order_balances', 'order_id = $1', [orderId]);
export const chargesOf = (orderId: string) => ownerRows('billing.credit_charges', 'order_id = $1', [orderId]);
/** Every core.event_log row naming the order or its invoice as aggregate. */
export const eventsFor = async (aggregateIds: string[], type?: string) =>
  ownerRows('core.event_log', `aggregate_id = ANY($1::uuid[])${type ? ' AND event_type = $2' : ''} ORDER BY aggregate_seq, created_at`, type ? [aggregateIds, type] : [aggregateIds]);
/** Everything real billing writes for an order: all must be empty after a rollback. */
export async function billingStoredFor(orderId: string) {
  return {
    invoices: (await invoicesOf(orderId)).length,
    ledger: (await ledgerOf(orderId)).length,
    balances: (await balanceOf(orderId)).length,
    charges: (await chargesOf(orderId)).length,
    balanceEvents: (await eventsFor([orderId], 'billing.balance.changed.v1')).length,
  };
}
export const BILLING_NOTHING = { invoices: 0, ledger: 0, balances: 0, charges: 0, balanceEvents: 0 };
export const INVOICE_NO = /^\d{3}\/\d{2}-\d{6}$/;     // PRD US-FD-03.1: `082/83-000001` shape from the tenant pattern '{fy}-{seq:6}'
export const seqOf = (invoiceNo: string): number => Number(invoiceNo.slice(invoiceNo.lastIndexOf('-') + 1));
