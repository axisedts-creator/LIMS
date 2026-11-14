// PG-T08 test harness: the REAL payments port (ports/PaymentProviderPort.impl.ts) over the in-memory DB fake (helpers/merchantDb.ts), scripted gateways,
// tx-aware ledger / event / job spies. Returns the shared ContractHarness shape (packages/fakes/src/harness.ts) plus extras for the PG-T08 integration tests.
// There is no payments migration in the repo yet (C0 DDL pending), so the fake is the integration seam, exactly like PG-T17. Synthetic data only.
//
// SEAM THE WRITER MUST FOLLOW (tester contract; the TRD fixes algorithms and port signatures, not these wiring types; dispute via .orchestra/notes if wrong):
//   ports/PaymentProviderPort.impl.ts  exports  createPaymentProviderPort(deps: PaymentsDeps)  ->  { createIntent, verify, getIntent, cancelIntent, refund }
//     (the module-level `paymentProviderPort` constant used by index.ts may keep existing; refund stays the PG-T01 stub until PG-T14)
//   service/intent.service.ts   exports  createIntentService(deps)  -> { createIntent(ctx, input), getIntent(ctx, input), cancelIntent(ctx, input) }
//   service/outcome.service.ts  exports  createOutcomeService(deps) -> { verify(ctx, input), applyCheck(ctx, intentId, mode) }   (mode: 'verify' | 'reconciliation' — no min interval)
//   PaymentsDeps = {
//     config: PaymentsConfig; kek: Kek;
//     adapters: { esewa: { buildAction, check }, khalti: { initiate, buildAction, check } }   // exactly the PG-T06 / PG-T07 adapter methods
//     events: { publish(ctx, type, { aggregate: {type, id, seq}, idempotencyKey, payload }): Promise<unknown> }   // core/events createEvents(...).publish shape
//     jobs:   { enqueue(ctx, task: string, payload: Record<string, unknown>, opts: { key: string; runAt?: Date }): Promise<void> }
//     log?:   { error(event: string, fields: Record<string, unknown>): void }               // alerts, ids only
//     newId?: () => string;                                                                  // uuidv7
//   }
//   Per call the services use ONLY: ctx.tx.query (dialect documented in merchantDb.ts), ctx.now() (ISO string), ctx.tenantId, ctx.actor,
//   ctx.ports.BillingPort / ctx.ports.FrontdeskPort (getOrderSummary only). No wall clock, no module-level state, no other ctx field.
import { randomBytes } from 'node:crypto';
import { createEventSpy } from '../../../../../../../packages/fakes/src/event-spy';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import type { ContractHarness } from '../../../../../../../packages/fakes/src/harness';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { uuidv7 } from '../../../../../../../packages/shared-ts/src/uuidv7/index';
import { loadPaymentsConfig } from '../../config.js';
import { createEsewaAdapter } from '../../gateways/esewa.adapter.js';
import { encryptSecret, type Kek } from '../../service/credentials.js';
import * as portModule from '../../ports/PaymentProviderPort.impl.js';
import testEnv from '../test-env';
import { makeMerchantDb, type MerchantDb } from './merchantDb';

export const SECRET = { esewa: 'synthetic-esewa-secret', khalti: 'synthetic-khalti-secret' } as const;
export const PRODUCT_CODE = 'EPAYTEST';
export const KHALTI_WEBSITE = 'https://lims.test';
export const MERCHANT_ID = (tenant: 'A' | 'B', gateway: 'esewa' | 'khalti') => `01900000-0000-7000-8000-00000000${tenant === 'A' ? 'a' : 'b'}${gateway === 'esewa' ? '1' : '2'}00`;
export const BRANCH = '01900000-0000-7000-8000-0000000b0001', CENTRE = '01900000-0000-7000-8000-0000000ce001';
export const kek: Kek = { activeId: 'kek-t1', keys: new Map([['kek-t1', randomBytes(32)]]) };

/** PG-T13: `forIntent` limits the fault to one intent id; `marker` makes the faulting call first write a test.markers row on ctx.tx (P-44: it must vanish with the savepoint). */
export interface Fault { error?: Error; forIntent?: string; marker?: string }
export interface HarnessExtras {
  db: MerchantDb;
  /** every call the services made to a gateway double */
  /** PG-T13: `script[intentId]` = raw statuses answered by the next checks of that intent, in order ('code:0' = transient); when it is empty the order's gatewayStatus applies */
  gateway: { calls: { gateway: string; op: 'initiate' | 'check'; intentId: string }[]; initiateInputs: any[]; secretsSeen: string[]; initiateFails: boolean | 'generic'; checkDelayMs: number; script: Record<string, string[]> };
  jobs: { task: string; payload: any; key: string; runAt?: Date }[];
  ledger: { calls: any[]; refunds: any[]; fail?: Error };
  alerts: { event: string; fields: Record<string, unknown> }[];
  faults: { events: Fault; ledger: Fault };
  clock: { now: string };
  config: ReturnType<typeof loadPaymentsConfig>;
  /** the real port without the tx/db wrapper: for tests that supply their own ctx.tx */
  deps: any;
  /** PG-T09: the Billing/Frontdesk doubles the wrapped port injects, for tests that build their own ctx (callback handlers).
   *  PG-T11: also the ledger / frontdesk doubles the wrapper injects as ctx.ports, for worker tasks that bring their own ctx */
  ports: { BillingPort: any; FrontdeskPort: any };
  setOrder(o: { id: string; tenantId?: string; dueAmountPaisa: number; gatewayStatus?: string; gatewayAmountPaisa?: number; status?: string }): void;
  disableAccount(gateway: 'esewa' | 'khalti', tenant?: 'A' | 'B'): void;
}
export type PortHarness = ContractHarness & HarnessExtras;

export async function makePortHarness(): Promise<PortHarness> {
  if (typeof (portModule as any).createPaymentProviderPort !== 'function') {
    throw new Error('PG-T08 not implemented: ports/PaymentProviderPort.impl.ts must export createPaymentProviderPort(deps) (see helpers/portHarness.ts header)');
  }
  const events = createEventSpy();
  const orders = new Map<string, any>();
  let config = loadPaymentsConfig(testEnv);
  let db = makeMerchantDb();

  const txSpies: { tx: unknown; drop(): void }[] = [];
  const gateway: HarnessExtras['gateway'] = { calls: [], initiateInputs: [], secretsSeen: [], initiateFails: false, checkDelayMs: 0, script: {} };
  const jobs: HarnessExtras['jobs'] = [];
  const jobTx = new Map<object, unknown>();
  const alerts: HarnessExtras['alerts'] = [];
  const faults = { events: {} as Fault, ledger: {} as Fault };
  const ledger: HarnessExtras['ledger'] = { calls: [], refunds: [] };
  const ledgerTx = new Map<object, unknown>();
  const clock = { now: FIXED_NOW as string };

  const intentRow = (id: string) => [...db.intents(TENANTS.A), ...db.intents(TENANTS.B)].find((r) => r.id === id);
  const scripted = (gw: 'esewa' | 'khalti') => async (stored: any, s: any): Promise<any> => {
    const id = stored.id ?? stored.intentId;
    gateway.secretsSeen.push(await s.use((x: string) => x));
    gateway.calls.push({ gateway: gw, op: 'check', intentId: id });
    if (gateway.checkDelayMs) await new Promise((r) => setTimeout(r, gateway.checkDelayMs));
    const row = intentRow(id), order = orders.get(row?.order_id) ?? {};
    const raw: string = gateway.script[id]?.shift() ?? order.gatewayStatus ?? 'PENDING';
    if (raw === 'code:0') return { kind: 'transient', reason: 'service_unavailable' };
    const amountPaisa = order.gatewayAmountPaisa ?? Number(row?.amount_paisa);
    return gw === 'khalti'
      ? { kind: 'answer', statusRaw: raw, amountPaisa, secondaryRef: 'SYN-TXN-REF-1', refundedFlag: raw === 'Refunded' }
      : { kind: 'answer', statusRaw: raw, amountPaisa, secondaryRef: 'SYN-TXN-REF-1' };
  };
  // eSewa: the REAL PG-T06 adapter signs the form (no network); only the status check is scripted.
  const realEsewa = createEsewaAdapter({ formUrl: config.esewaFormUrl, statusUrl: config.esewaStatusUrl, publicBase: config.publicBaseUrl,
    timeouts: { initiateMs: 1200, inrequestMs: 2500, jobMs: 5000 }, allowFractionalRupees: config.esewaAllowFractionalRupees });
  let pidx = 0;
  const adapters = {
    esewa: { buildAction: realEsewa.buildAction, check: scripted('esewa') },
    khalti: {
      async initiate(i: any, s: any) {
        gateway.calls.push({ gateway: 'khalti', op: 'initiate', intentId: i.intentId });
        gateway.initiateInputs.push(structuredClone(i));
        gateway.secretsSeen.push(await s.use((x: string) => x));
        if (gateway.initiateFails === 'generic') throw new Error('socket hang up');
        if (gateway.initiateFails) throw Object.assign(new Error('gateway_not_available'), { code: 'payments.gateway_not_available', name: 'LimsError' });
        const n = ++pidx, url = `https://pay.khalti.test/${n}`;
        return { gatewayTxnRef: `SYN-PIDX-${n}`, action: { kind: 'redirect', url }, expiresAt: new Date(Date.parse(clock.now) + 3600_000).toISOString(), paymentUrl: url };
      },
      buildAction: (i: any) => ({ kind: 'redirect', url: i.paymentUrl }),
      check: scripted('khalti'),
    },
  };

  const deps: any = {
    get config() { return config; }, kek, adapters,
    events: {
      async publish(ctx: any, type: string, input: any) {
        if (faults.events.error) throw faults.events.error;
        await events.publish(ctx.tx, type, { tenantId: ctx.tenantId, idempotencyKey: input.idempotencyKey, aggregate: input.aggregate, payload: input.payload });
        return { eventId: uuidv7(), duplicate: false };
      },
    },
    jobs: { async enqueue(ctx: any, task: string, payload: any, opts: { key: string; runAt?: Date }) {
      const row = { task, payload, key: opts.key, ...(opts.runAt ? { runAt: opts.runAt } : {}) };
      if (!jobs.some((j) => j.key === opts.key && j.task === task)) { jobs.push(row); jobTx.set(row, ctx.tx); }
    } },
    log: { error: (event: string, fields: Record<string, unknown>) => { alerts.push({ event, fields }); } },
    newId: () => uuidv7(),
  };

  const balanceOf = async (_c: any, i: { orderId: string }) => {
    const due = orders.get(i.orderId)?.dueAmountPaisa ?? 0;
    return { orderId: i.orderId, invoiced: { amountPaisa: due, currency: 'NPR' }, paid: { amountPaisa: 0, currency: 'NPR' }, credited: { amountPaisa: 0, currency: 'NPR' },
      balanceDue: { amountPaisa: due, currency: 'NPR' }, balanceVersion: 1, asOf: clock.now };
  };
  const billingFor = () => ({
    getOrderBalance: balanceOf,
    async recordGatewayPayment(c: any, i: any) {
      const lf = faults.ledger;
      if (lf.error && (!lf.forIntent || lf.forIntent === i.intentId)) {
        if (lf.marker) await c.tx.query('INSERT INTO test.markers (id, tenant_id, label) VALUES ($1, $2, $3)', [uuidv7(), c.tenantId, lf.marker]);
        throw lf.error;
      }
      const duplicate = ledger.calls.some((x) => x.gateway === i.gateway && x.gatewayTxnRef === i.gatewayTxnRef);
      const row = structuredClone(i); ledger.calls.push(row); ledgerTx.set(row, c.tx);
      return { ledgerEntryId: `01900000-0000-7000-8000-0000000c80${String(ledger.calls.length).padStart(2, '0')}`, duplicate, balance: await balanceOf(c, i) };
    },
    async recordGatewayRefund(c: any, i: any) { ledger.refunds.push(i); return { ledgerEntryId: '01900000-0000-7000-8000-0000000cc000', duplicate: false, balance: await balanceOf(c, i) }; },
  });
  const frontdesk = {
    async getOrderSummary(_c: any, i: { orderId: string }) {
      const o = orders.get(i.orderId);
      if (!o) throw Object.assign(new Error('not found'), { code: 'common.not_found' });
      return { orderId: i.orderId, branchId: BRANCH, centreId: CENTRE, status: o.status ?? 'registered', items: [], version: 1 };
    },
  };
  const defaultBilling = billingFor();

  const port = () => (portModule as any).createPaymentProviderPort(deps);
  let impl = port();

  const dropFor = (tx: unknown) => {
    events.rollback(tx);
    for (let i = jobs.length - 1; i >= 0; i--) if (jobTx.get(jobs[i]!) === tx) jobs.splice(i, 1);
    for (let i = ledger.calls.length - 1; i >= 0; i--) if (ledgerTx.get(ledger.calls[i]) === tx) ledger.calls.splice(i, 1);
  };
  const run = (method: string) => async (ctx: any, input: unknown) => {
    let txRef: unknown;
    try {
      return await db.run(async (dctx) => {
        txRef = dctx.tx;
        const c = { ...ctx, tx: dctx.tx, ports: { FrontdeskPort: frontdesk, BillingPort: defaultBilling, ...ctx.ports } };
        return impl[method](c, input);
      }, { tenantId: ctx.tenantId, now: () => new Date(ctx.now()) });
    } catch (e) { if (txRef !== undefined) dropFor(txRef); throw e; }
  };
  const wrapped = Object.fromEntries(['createIntent', 'verify', 'getIntent', 'cancelIntent', 'refund'].map((m) => [m, run(m)]));

  const seedAccounts = (): void => {
    for (const [key, tenantId] of Object.entries(TENANTS) as ['A' | 'B', string][]) {
      for (const gw of ['esewa', 'khalti'] as const) {
        const id = MERCHANT_ID(key, gw);
        const s = encryptSecret(kek, SECRET[gw], { tenantId, gateway: gw, environment: config.gatewayEnv, merchantAccountId: id });
        db.put('payments.merchant_accounts', { id, tenant_id: tenantId, gateway: gw, environment: config.gatewayEnv, is_enabled: true,
          esewa_product_code: gw === 'esewa' ? PRODUCT_CODE : null, khalti_website_url: gw === 'khalti' ? KHALTI_WEBSITE : null,
          secret_ciphertext: s.ciphertext, secret_nonce: s.nonce, secret_auth_tag: s.authTag, secret_kek_id: s.kekId, secret_fingerprint: s.fingerprint,
          created_by: tenantId, updated_by: tenantId });
      }
    }
  };
  seedAccounts();

  const h: PortHarness = {
    impl: wrapped, events, ctxFor: makeCtxFor(), db, gateway, jobs, ledger, alerts, faults, clock, config, deps, ports: { BillingPort: defaultBilling, FrontdeskPort: frontdesk },
    async seed(f: any) {
      db = makeMerchantDb(); seedAccounts();
      orders.clear(); events.clear(); jobs.length = 0; ledger.calls.length = 0; ledger.refunds.length = 0; alerts.length = 0; gateway.calls.length = 0; gateway.initiateInputs.length = 0; gateway.secretsSeen.length = 0; gateway.initiateFails = false; gateway.script = {};
      faults.events = {}; faults.ledger = {}; txSpies.length = 0;
      if (f.returnUrlHosts) {
        config = loadPaymentsConfig({ ...testEnv, LIMS_PAYMENTS_RETURN_URL_ALLOWLIST: [...f.returnUrlHosts.map((x: string) => `https://${x}/`), 'https://api.lims.test/v1/payments/result'].join(',') });
        impl = port();
      }
      for (const o of f.orders ?? []) orders.set(o.id, o);
      for (const i of f.intents ?? []) {
        const open = ['created', 'initiated', 'pending'].includes(i.status);
        db.put('payments.intents', {
          id: i.id, tenant_id: i.tenantId, order_id: i.orderId, branch_id: BRANCH, centre_id: CENTRE, gateway: i.gateway, environment: config.gatewayEnv,
          merchant_account_id: MERCHANT_ID(i.tenantId === TENANTS.B ? 'B' : 'A', i.gateway), status: i.status, amount_paisa: i.amountPaisa, idempotency_key: i.idempotencyKey,
          request_fingerprint: 'a'.repeat(64), return_url: 'https://app.lims.test/pay/done', cancel_url: 'https://app.lims.test/pay/cancel',
          callback_token_sha256: randomBytes(32), gateway_txn_ref: i.gateway === 'esewa' ? i.id : (i.gatewayTxnRef ?? 'SYN-PIDX-0'),
          gateway_payment_url: i.gateway === 'khalti' ? 'https://pay.khalti.test/seeded' : null, expires_at: i.expiresAt ? new Date(i.expiresAt) : null,
          initiated_at: new Date(FIXED_NOW), refunded_paisa: i.refundedPaisa ?? 0, created_actor_type: 'system', created_by: i.tenantId, updated_by: i.tenantId,
          failure_reason: ['failed', 'expired'].includes(i.status) ? 'expired_unpaid' : null, hold_reason: i.status === 'held_for_review' ? 'ambiguous_status' : null,
          ...(open || !['settled', 'refunded', 'partially_refunded'].includes(i.status) ? {} : { settled_at: new Date(FIXED_NOW), ledger_entry_id: '01900000-0000-7000-8000-0000000c8000',
            verified_amount_paisa: i.amountPaisa, verification_method: i.gateway === 'esewa' ? 'esewa_status_check' : 'khalti_lookup' }),
        });
      }
    },
    rollback(tx: unknown) { dropFor(tx); },
    setOrder(o) { orders.set(o.id, o); },
    disableAccount(gw, tenant = 'A') { db.accounts(TENANTS[tenant]).find((a) => a.gateway === gw)!.is_enabled = false; },
  };
  Object.defineProperty(h, 'db', { get: () => db });
  return h;
}
