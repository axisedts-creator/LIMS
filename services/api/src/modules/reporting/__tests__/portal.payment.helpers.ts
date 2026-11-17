// C6-T42 test helpers (not a test file): portal dues payment (08 A11.1; 02-TRD §6.6 PP1/PP2, §9; 01-PRD AC-18.1..18.7). Synthetic data only.
// makePayWorld() = the T20 portal world (portal.helpers.ts; its fake DB now also models reporting.portal_payment_requests incl. CHECKs, guard trigger,
// the partial unique index "one open request per order" and the system-only DELETE) + the two ports a worker task may use:
//   - BillingPort spy      : getOrderBalance(ctx, {orderId}) answers `pay.balance.due` (paisa); recordGatewayPayment is C15's ledger write (the real PaymentProviderPort fake calls it on settle).
//   - PaymentProviderPort  : the REAL C15 fake (packages/fakes) over order ORDER_A; the gateway's answer is chosen with makePayWorld({ gatewayStatus }) and applied by pay.verify(intentId).
// The PORTAL request path keeps the T20 FORBIDDEN proxies (any BillingPort / PaymentProviderPort call throws and is recorded in w.forbiddenCalls); only worker ctx gets the real ports.
import { createFakePaymentProviderPort } from '../../../../../../packages/fakes/src/PaymentProviderPort.fake.js';
import { makePortalWorld, ORDER_A, REPORT_A, TENANT_A, PORTAL_ORIGIN, rejection, type Row } from './portal.helpers.js';

export { PORTAL_ORIGIN, ORDER_A, REPORT_A, TENANT_A, rejection };
export const DUE = 50_000;                                          // NPR 500.00
export const doneUrl = (id: string) => `${PORTAL_ORIGIN}/r/payments/${id}/done`;
export const idem = (n = 1) => `portal-pay-nonce-${String(n).padStart(4, '0')}-abcdefghij`;   // a hidden-form nonce used as Idempotency-Key (>= 16 chars)

export const TASKS = { create: 'reporting.create_portal_payment_intent', refresh: 'reporting.refresh_portal_payment_request', expire: 'reporting.expire_portal_payment_requests', purge: 'reporting.purge_ephemeral' } as const;

export interface PayOpts { gatewayStatus?: string; gateways?: string[]; balanceHint?: number | null; due?: number; withLaunchUrl?: boolean }

export function makePayWorld(opts: PayOpts = {}) {
  const w = makePortalWorld();
  const due = opts.due ?? DUE;
  let seq = 0;                                                       // one call order across BillingPort and PaymentProviderPort (getOrderBalance must precede createIntent)
  const balance = { due, calls: [] as Array<{ n: number; actor: string | undefined; orderId: unknown }>, ledger: [] as any[], failNext: undefined as undefined | Error };
  const billing: any = {
    async getOrderBalance(ctx: any, input: any) {
      balance.calls.push({ n: ++seq, actor: ctx.actor?.type, orderId: input?.orderId });
      if (balance.failNext) { const e = balance.failNext; balance.failNext = undefined; throw e; }
      return { orderId: input.orderId, invoiced: { amountPaisa: DUE, currency: 'NPR' }, paid: { amountPaisa: 0, currency: 'NPR' }, credited: { amountPaisa: 0, currency: 'NPR' },
        balanceDue: { amountPaisa: balance.due, currency: 'NPR' }, balanceVersion: 1, asOf: w.now() };
    },
    async recordGatewayPayment(_ctx: any, input: any) { balance.ledger.push(input); return { ledgerEntryId: w.db.newId() }; },
  };
  const fake: any = createFakePaymentProviderPort({
    seed: 7, events: undefined as any,
    fixtures: { orders: [{ id: ORDER_A, tenantId: TENANT_A, dueAmountPaisa: due, gatewayStatus: opts.gatewayStatus ?? 'PENDING' }], returnUrlHosts: ['portal.lims.invalid'] },
  });
  // The wrapper records every call and adds `launchUrl` to eSewa's form_post as the real C15 does (CR-C15-001); withLaunchUrl:false = a form_post without it.
  const providerCalls: Array<{ n: number; method: string; actor: string | undefined; input: any }> = [];
  const launch = (a: any, id: string) => (opts.withLaunchUrl === false || !a || a.kind !== 'form_post' ? a : { ...a, launchUrl: `https://launch.gateway.invalid/pay/${id}` });
  const provider: any = {
    async createIntent(ctx: any, input: any) { providerCalls.push({ n: ++seq, method: 'createIntent', actor: ctx.actor?.type, input }); const o = await fake.createIntent(ctx, input); return { ...o, action: launch(o.action, o.intentId) }; },
    async getIntent(ctx: any, input: any) { providerCalls.push({ n: ++seq, method: 'getIntent', actor: ctx.actor?.type, input }); const o = await fake.getIntent(ctx, input); return o.action ? { ...o, action: launch(o.action, o.intentId) } : o; },
    async verify(ctx: any, input: any) { providerCalls.push({ n: ++seq, method: 'verify', actor: ctx.actor?.type, input }); return fake.verify(ctx, input); },
    async cancelIntent(ctx: any, input: any) { providerCalls.push({ n: ++seq, method: 'cancelIntent', actor: ctx.actor?.type, input }); return fake.cancelIntent(ctx, input); },
    async refund(ctx: any, input: any) { providerCalls.push({ n: ++seq, method: 'refund', actor: ctx.actor?.type, input }); return fake.refund(ctx, input); },
  };
  const callsOf = (method: string) => providerCalls.filter((c) => c.method === method);

  /** Worker ports: the real fake + billing spy; everything else as in the portal world. */
  const workerPorts = () => ({ ...w.ports, BillingPort: billing, PaymentProviderPort: provider });
  /** Worker task ctx (system actor, JobContext shape) with the payment ports. */
  const taskCtx = (over: Row = {}) => w.jobCtx({ ports: workerPorts(), ...over });
  const providerCtx = () => taskCtx();   // what C15 itself would use to verify / settle: system actor + BillingPort (ledger spy)

  const gateways = (list: string[]) => { w.db.store['settings']!.find((s) => s['tenant_id'] === TENANT_A)!['portal_payment_gateways'] = list; };
  gateways(opts.gateways ?? ['esewa', 'khalti']);
  const hint = (paisa: number | null) => { w.db.store['reports']!.find((r) => r['id'] === REPORT_A)!['billing_balance_due_paisa'] = paisa; };
  hint(opts.balanceHint === undefined ? due : opts.balanceHint);

  /** A patient link + live session for REPORT_A (purpose 'report' unless overridden). */
  function patient(over: Row = {}) { const l = w.mkLink(over); const s = w.mkSession(l.row); return { link: l, session: s, cred: s.cred, linkId: l.row['id'] as string }; }

  const pp1 = (cred: string, body: any = { gateway: 'esewa' }, key: string | undefined = idem()) =>
    w.run('createPortalPaymentRequest', cred, { body, headers: key === undefined ? {} : { 'idempotency-key': key } });
  const pp2 = (cred: string, id: string) => w.run('getPortalPaymentRequest', cred, { params: { portal_payment_request_id: id } });

  const reqs = (filter: (r: Row) => boolean = () => true) => w.db.store['portal_payment_requests']!.filter(filter);
  const byId = (id: string) => reqs((r) => r['id'] === id)[0]!;
  const jobs = (identifier: string) => w.db.jobsOf(identifier);
  /** Run a worker task (taken from the worker manifest by the caller: this helper never imports the worker) like the queue: one tx, rolled back when it throws. */
  const runTask = (task: (p: any, c: any) => Promise<void>, id: string, over: Row = {}) => w.runTask(task, { tenant_id: TENANT_A, portal_payment_request_id: id }, { ports: workerPorts(), ...over });

  /** C15 side: verify the intent at the gateway (settles + writes the ledger through BillingPort.recordGatewayPayment when the gateway says paid). Not recorded in providerCalls. */
  const verify = (intentId: string) => fake.verify(providerCtx(), { intentId });

  /** Insert a request row directly (any state) for tests that start mid-lifecycle. */
  function seedRequest(linkId: string, over: Row = {}): Row {
    const created = w.now();
    return w.db.insert('portal_payment_requests', { tenant_id: TENANT_A, link_id: linkId, report_id: REPORT_A, order_id: ORDER_A, gateway: 'esewa', status: 'queued',
      expires_at: new Date(Date.parse(created) + 90 * 86400_000).toISOString(), created_at: created, created_by: linkId, updated_at: created, updated_by: linkId, ...over });
  }
  /** A `ready` request backed by a real fake-C15 intent (so getIntent / verify work). */
  async function seedReady(linkId: string, gateway: 'esewa' | 'khalti' = 'esewa'): Promise<Row> {
    const row = seedRequest(linkId, { gateway });
    const out = await provider.createIntent(providerCtx(), { orderId: ORDER_A, gateway, idempotencyKey: `rpt_${row['id']}`, returnUrl: doneUrl(row['id']), cancelUrl: doneUrl(row['id']) });
    Object.assign(row, { status: 'ready', intent_id: out.intentId, amount_paisa: out.amount.amountPaisa, intent_expires_at: out.expiresAt, last_checked_at: w.now(),
      action_json: { url: out.action.kind === 'form_post' ? out.action.launchUrl : out.action.url } });
    return row;
  }

  return { w, balance, billing, provider, providerCalls, callsOf, workerPorts, taskCtx, providerCtx, gateways, hint, patient, pp1, pp2, reqs, byId, jobs, runTask, verify, seedRequest, seedReady };
}
export type PayWorld = ReturnType<typeof makePayWorld>;
