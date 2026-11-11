// BL-T16 billing consumers `payments.intent.settled.v1` (X3 safety net) and `homecollection.collection.synced.v1`
// (02-TRD §8 consumer table; PRD US-BL-08.1/.2, US-BL-09.1-.4; 03-IC §3.20/§3.23; 08 A19 D-128 inactive method, D-120 booking_id; 07-SECURITY consumer probes).
// Runs the REAL ledger/gateway services over the BL-T12 in-memory billing world (services/api billing test harness), so ledger rows, review items and events are observable. No DB.
// ASSUMED impl seam (spec fixes behaviour, not signatures; writer: dispute via .orchestra/notes if wrong):
//   services/worker/src/jobs/billing/consumers/index.ts exports
//     createBillingConsumers(deps: { repo, counter, events: createBillingEvents(...) }) -> { onIntentSettled, onCollectionSynced }   (same DI shape as createBillingPort / createLedgerService)
//     onIntentSettled, onCollectionSynced  (production handlers over the real repo; these are what manifest.subscriptions registers)
//   handler(envelope, ctx): the C0 consumer wrapper hands the validated envelope (payload under `.payload`) and a JobContext; ctx.tx is the one transaction, ctx.actor the billing system actor
//   (type 'system', no membership). Tenant comes from ctx.tenantId only. Handlers never open their own transaction. Inbox/dedupe-by-event is the wrapper's job (core consumer.test.ts); the
//   handlers are ALSO idempotent on their own keys (client_mutation_id / (gateway, gateway_txn_ref)), proven here by re-delivering the same facts under a NEW event_id.
//   Home collection: ledger idempotency_key = payments[].client_mutation_id, collected_by = phlebotomist_membership_id, captured_at_device = captured_at_device, method = payment_method_code
//   (03-IC §3.23 field name; the TRD prose says method_code), reference_text = payments[].reference. Review item amount_paisa: inactive method = the payment amount (TRD §8), exceeds-due = the excess
//   over the due (same convention as the gateway path in BillingPort.impl). Gateway: recordGatewayPayment semantics with allowExceedsDue = true (money is already taken), method_code = gateway.
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { IDS, V7 } from '../../../../../api/src/modules/billing/service/__tests__/t11.helpers.js';
import { makeBillingPortWorld } from '../../../../../api/src/modules/billing/__tests__/contract/billingPort.harness.js';
import { createBillingEvents } from '../../../../../api/src/modules/billing/events/publish.js';
import { TENANT_A } from '../../../../../api/src/modules/billing/service/__tests__/t06.helpers.js';

const SYS = V7('0000000a0016');
const PHLEB = V7('000000030a01'), PHLEB2 = V7('000000030a02');
const VISIT = V7('000000130001'), BOOKING = V7('000000160001'), INTENT = V7('000000150001');
const CM = (n: number) => V7(`0000001300${String(n).padStart(2, '0')}`);       // client_mutation_id
const EV = (n: number) => V7(`0000001e00${String(n).padStart(2, '0')}`);       // event_id
const OTHER_TENANT = '0190a000-0000-7000-8000-0000000000ff';
const money = (amount_paisa: number) => ({ amount_paisa, currency: 'NPR' });
const NOW = '2026-11-08T06:00:00.000Z';

const envelope = (type: string, payload: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  event_id: EV(1), event_type: type, tenant_id: TENANT_A, occurred_at: NOW, actor: { type: 'system', id: V7('0000000a0099') }, idempotency_key: `${type}:k`,
  producer: type.startsWith('payments') ? 'payments' : 'homecollection', aggregate: { type: type.startsWith('payments') ? 'payment_intent' : 'home_visit', id: VISIT, seq: 1 },
  request_id: V7('0000000000f1'), payload, ...over,
});
const pay = (n: number, amount: number, over: Record<string, unknown> = {}) => ({ client_mutation_id: CM(n), payment_method_code: 'cash', amount: money(amount), captured_at_device: '2026-11-08T05:30:00.000Z', ...over });
const synced = (payments: unknown[], over: Record<string, unknown> = {}, evOver: Record<string, unknown> = {}) =>
  envelope('homecollection.collection.synced.v1', { visit_id: VISIT, order_id: IDS.order, phlebotomist_membership_id: PHLEB, synced_at: NOW, collections: [], payments, ...over }, evOver);
const settled = (over: Record<string, unknown> = {}, evOver: Record<string, unknown> = {}) =>
  envelope('payments.intent.settled.v1', { intent_id: INTENT, order_id: IDS.order, gateway: 'khalti', gateway_txn_ref: 'SYNpidx0000000000000001', amount: money(225000), verified_at: NOW, verification_method: 'khalti_lookup', ...over }, evOver);

async function setup(o: { invoiced?: number; paid?: number; hasInvoice?: boolean } = {}) {
  const w = makeBillingPortWorld();
  w.seedOrder({ orderId: IDS.order, tenantId: TENANT_A, invoicedPaisa: o.invoiced ?? 225000, paidPaisa: o.paid ?? 0, creditedPaisa: 0, hasInvoice: o.hasInvoice ?? true, balanceVersion: 1 });
  const mod: any = await import('../consumers/index.js');
  const consumers = mod.createBillingConsumers({ repo: w.repo, counter: w.counter, events: createBillingEvents(w.events as never) });
  const ctx = (tenantId: string = TENANT_A): any => {
    const base: any = w.ctx({ tenantId, actor: { type: 'system', id: SYS }, ports: w.fakePorts });
    const c: any = { ...base, tenantId, actor: { type: 'system', id: SYS }, now: () => NOW, isNewer: () => true, attempt: 1, maxAttempts: 10, jobId: '1', log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } };
    c.db = { tx: async (fn: any) => fn(c) };
    return c;
  };
  const run = (h: 'onIntentSettled' | 'onCollectionSynced', env: unknown, tenantId?: string) => w.tx(() => consumers[h](env, ctx(tenantId)));
  const rows = () => w.ledgerRowsOf(TENANT_A, IDS.order).filter((e: any) => !e.__seed);
  const items = (): any[] => (w.s as any).reviewItems.filter((i: any) => i.tenant_id === TENANT_A);
  const balEvents = () => w.events_of('billing.balance.changed.v1');
  return { w, run, rows, items, balEvents, consumers };
}
const rejected = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } return undefined; };

describe('manifest wiring (02-TRD §7.2: subscriptions live in the billing manifest)', () => {
  it('billing subscribes to both events with the consumers/index.ts handlers and the manifest still validates', async () => {
    const m: any = (await import('../index.js')).manifest; const c: any = await import('../consumers/index.js');
    expect(m.subscriptions['payments.intent.settled.v1']).toBe(c.onIntentSettled);
    expect(m.subscriptions['homecollection.collection.synced.v1']).toBe(c.onCollectionSynced);
    expect(() => validateManifests([m])).not.toThrow();
    expect(typeof m.tasks['billing.credit_days_check']).toBe('function');     // earlier tasks untouched
  });
});

describe('homecollection.collection.synced.v1 -> ledger (US-BL-09.1)', () => {
  it('1 cash payment: one home_collection ledger row, key = client_mutation_id, collector = phlebotomist, captured_at_device kept, balance event, no review item', async () => {
    const t = await setup();
    await t.run('onCollectionSynced', synced([pay(1, 100000)]));
    const [r, ...rest] = t.rows();
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ entry_kind: 'payment', capture_kind: 'home_collection', method_code: 'cash', amount_paisa: 100000, idempotency_key: CM(1), collected_by_membership_id: PHLEB,
      captured_at_device: '2026-11-08T05:30:00.000Z', order_id: IDS.order, tenant_id: TENANT_A, cash_session_id: null, created_by: SYS });
    expect(t.items()).toEqual([]);
    expect(t.balEvents()).toHaveLength(1);
  });
  it('payments[].reference is stored as reference_text', async () => {
    const t = await setup();
    await t.run('onCollectionSynced', synced([pay(1, 100000, { reference: 'SYN-REF-77' })]));
    expect(t.rows()[0].reference_text).toBe('SYN-REF-77');
  });
  it('several payments in one event: one row each, keys distinct; a collections-only event (payments []) writes nothing and does not throw', async () => {
    const t = await setup({ invoiced: 400000 });
    await t.run('onCollectionSynced', synced([pay(1, 100000), pay(2, 50000)]));
    expect(t.rows().map((r: any) => [r.idempotency_key, r.amount_paisa]).sort()).toEqual([[CM(1), 100000], [CM(2), 50000]]);
    const t2 = await setup();
    await expect(t2.run('onCollectionSynced', synced([], { collections: [{ client_mutation_id: CM(9), specimen_id: V7('000000090001'), barcode_verified: true, collected_at_device: NOW }] }))).resolves.toBeUndefined();
    expect(t2.rows()).toEqual([]); expect(t2.balEvents()).toHaveLength(0); expect(t2.items()).toEqual([]);
  });
  it('duplicate delivery adds nothing: the same payment re-sent under a NEW event_id (and a batch overlapping an earlier one) is recorded once, one balance event per new row', async () => {
    const t = await setup({ invoiced: 400000 });
    await t.run('onCollectionSynced', synced([pay(1, 100000)]));
    const ev = t.balEvents().length;
    await expect(t.run('onCollectionSynced', synced([pay(1, 100000)], {}, { event_id: EV(2) }))).resolves.toBeUndefined();
    expect(t.rows()).toHaveLength(1); expect(t.balEvents()).toHaveLength(ev);
    await t.run('onCollectionSynced', synced([pay(1, 100000), pay(2, 50000)], {}, { event_id: EV(3) }));
    expect(t.rows().map((r: any) => r.idempotency_key).sort()).toEqual([CM(1), CM(2)]);
  });
  it('a throwing second payment rolls the whole event back (no half-recorded batch); the retry then records both', async () => {
    const t = await setup({ invoiced: 400000 });
    const orig = t.w.repo.insertLedgerEntry; let n = 0;
    t.w.repo.insertLedgerEntry = async (tx: unknown, e: any) => { if (++n === 2) throw new Error('boom'); return orig(tx, e); };
    expect(await rejected(t.run('onCollectionSynced', synced([pay(1, 100000), pay(2, 50000)])))).toBeInstanceOf(Error);
    expect(t.rows()).toEqual([]); expect(t.balEvents()).toHaveLength(0);
    t.w.repo.insertLedgerEntry = orig;
    await t.run('onCollectionSynced', synced([pay(1, 100000), pay(2, 50000)]));
    expect(t.rows()).toHaveLength(2);
  });
});

describe('over the due (US-BL-09.2)', () => {
  it('recorded in full (money is physically collected) + one open finance review item home_payment_exceeds_due on that entry; never throws', async () => {
    const t = await setup({ invoiced: 225000 });
    await expect(t.run('onCollectionSynced', synced([pay(1, 300000)]))).resolves.toBeUndefined();
    const [r] = t.rows(); expect(t.rows()).toHaveLength(1); expect(r.amount_paisa).toBe(300000);
    expect(t.items()).toHaveLength(1);
    expect(t.items()[0]).toMatchObject({ kind: 'home_payment_exceeds_due', ledger_entry_id: r.id, order_id: IDS.order, centre_id: IDS.centre, status: 'open', amount_paisa: '75000', tenant_id: TENANT_A });
  });
  it('exactly the due raises no item; duplicate delivery of an over-due payment keeps ONE item', async () => {
    const t = await setup({ invoiced: 225000 });
    await t.run('onCollectionSynced', synced([pay(1, 225000)]));
    expect(t.items()).toEqual([]);
    const t2 = await setup({ invoiced: 225000 });
    await t2.run('onCollectionSynced', synced([pay(1, 300000)]));
    await t2.run('onCollectionSynced', synced([pay(1, 300000)], {}, { event_id: EV(2) }));
    expect(t2.rows()).toHaveLength(1); expect(t2.items()).toHaveLength(1);
  });
});

describe('payment method inactive for the tenant (US-BL-09.3, 08 A19 D-128)', () => {
  it('inactive method: no throw (never dead-lettered), payment recorded WITH that method, one item home_payment_method_inactive (ledger_entry_id = the entry, amount = its amount) in the same transaction', async () => {
    const t = await setup();
    await expect(t.run('onCollectionSynced', synced([pay(1, 100000, { payment_method_code: 'old_cheque' })]))).resolves.toBeUndefined();
    const [r] = t.rows(); expect(t.rows()).toHaveLength(1);
    expect(r).toMatchObject({ method_code: 'old_cheque', capture_kind: 'home_collection', amount_paisa: 100000, idempotency_key: CM(1) });
    expect(t.items()).toHaveLength(1);
    expect(t.items()[0]).toMatchObject({ kind: 'home_payment_method_inactive', ledger_entry_id: r.id, amount_paisa: '100000', order_id: IDS.order, status: 'open' });
    expect(t.balEvents()).toHaveLength(1);
  });
  it('a code unknown to both tables gets the same treatment (a collected payment is never dropped)', async () => {
    const t = await setup();
    await expect(t.run('onCollectionSynced', synced([pay(1, 100000, { payment_method_code: 'no_such_method' })]))).resolves.toBeUndefined();
    expect(t.rows()).toHaveLength(1); expect(t.rows()[0].method_code).toBe('no_such_method');
    expect(t.items().map((i: any) => i.kind)).toEqual(['home_payment_method_inactive']);
  });
  it('over the due AND inactive: one item of each kind, both pointing at the one entry', async () => {
    const t = await setup({ invoiced: 225000 });
    await t.run('onCollectionSynced', synced([pay(1, 300000, { payment_method_code: 'old_cheque' })]));
    expect(t.rows()).toHaveLength(1);
    expect(t.items().map((i: any) => i.kind).sort()).toEqual(['home_payment_exceeds_due', 'home_payment_method_inactive']);
    expect(new Set(t.items().map((i: any) => i.ledger_entry_id))).toEqual(new Set([t.rows()[0].id]));
  });
  it('an active method raises no inactive item; a duplicate delivery of an inactive-method payment keeps ONE item', async () => {
    const t = await setup();
    await t.run('onCollectionSynced', synced([pay(1, 100000)]));
    expect(t.items()).toEqual([]);
    const t2 = await setup();
    await t2.run('onCollectionSynced', synced([pay(1, 100000, { payment_method_code: 'old_cheque' })]));
    await t2.run('onCollectionSynced', synced([pay(1, 100000, { payment_method_code: 'old_cheque' })], {}, { event_id: EV(2) }));
    expect(t2.rows()).toHaveLength(1); expect(t2.items()).toHaveLength(1);
  });
  it('the item and the ledger row commit or roll back together: a failing item insert leaves no ledger row, no event; the retry then writes both', async () => {
    const t = await setup();
    const orig = t.w.repo.insertFinanceReviewItem; let fail = true;
    t.w.repo.insertFinanceReviewItem = async (tx: unknown, a: any) => { if (fail) throw new Error('boom'); return orig(tx, a); };
    expect(await rejected(t.run('onCollectionSynced', synced([pay(1, 100000, { payment_method_code: 'old_cheque' })])))).toBeInstanceOf(Error);
    expect(t.rows()).toEqual([]); expect(t.items()).toEqual([]); expect(t.balEvents()).toHaveLength(0);
    fail = false;
    await t.run('onCollectionSynced', synced([pay(1, 100000, { payment_method_code: 'old_cheque' })]));
    expect(t.rows()).toHaveLength(1); expect(t.items()).toHaveLength(1);
  });
});

describe('optional booking_id and unknown fields (US-BL-09.4, 08 A19 D-120; 02-CV §7.2 known-fields-only)', () => {
  const norm = (t: any) => ({ rows: t.rows().map(({ id, created_at, ...r }: any) => r), items: t.items().map(({ id, ledger_entry_id, created_at, ...r }: any) => r), events: t.balEvents().length });
  it('with booking_id the result is identical to without it, and the id never reaches a repo call or a row', async () => {
    const a = await setup({ invoiced: 225000 }), b = await setup({ invoiced: 225000 });
    const ps = () => [pay(1, 300000, { payment_method_code: 'old_cheque' })];
    await a.run('onCollectionSynced', synced(ps()));
    await b.run('onCollectionSynced', synced(ps(), { booking_id: BOOKING }));
    expect(norm(b)).toEqual(norm(a));
    expect(JSON.stringify(b.w.repoCalls)).not.toContain(BOOKING);
    expect(JSON.stringify(b.rows())).not.toContain(BOOKING);
  });
  it('unknown payload fields (top level and inside payments[]) are tolerated and ignored', async () => {
    const t = await setup();
    await expect(t.run('onCollectionSynced', synced([pay(1, 100000, { future_field: 'x-SYN-1' })], { future_top: 'x-SYN-2', booking_id: BOOKING }))).resolves.toBeUndefined();
    expect(t.rows()).toHaveLength(1);
    expect(JSON.stringify(t.w.repoCalls)).not.toMatch(/x-SYN-[12]/);
  });
});

describe('payments.intent.settled.v1 safety net (US-BL-08.1/.2; 02-TRD §8; 03-IC §3.20)', () => {
  it('US-BL-08.2: the port was never called -> the consumer records one gateway row (collector NULL, no cash session, no receipt, method = gateway) and emits the balance event', async () => {
    const t = await setup();
    await t.run('onIntentSettled', settled());
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0]).toMatchObject({ entry_kind: 'payment', capture_kind: 'gateway', method_code: 'khalti', amount_paisa: 225000, gateway: 'khalti', gateway_txn_ref: 'SYNpidx0000000000000001',
      intent_id: INTENT, collected_by_membership_id: null, cash_session_id: null, order_id: IDS.order, tenant_id: TENANT_A, created_by: SYS });
    expect(t.rows()[0].receipt_no ?? null).toBeNull();
    expect(t.balEvents()).toHaveLength(1); expect(t.items()).toEqual([]);
  });
  it('US-BL-08.1: the ledger row already exists (C15 called recordGatewayPayment in its transaction) -> the consumer does nothing else: no row, no event, no item, no insert attempt', async () => {
    const t = await setup();
    const port = (await import('../../../../../api/src/modules/billing/ports/BillingPort.impl.js') as any).createBillingPort(t.w.deps);
    await t.w.tx(() => port.recordGatewayPayment(t.w.enrich({ ...t.w.ctx(), tenantId: TENANT_A, actor: { type: 'system', id: V7('0000000a0015') } }),
      { intentId: INTENT, orderId: IDS.order, gateway: 'khalti', gatewayTxnRef: 'SYNpidx0000000000000001', amount: { amountPaisa: 225000, currency: 'NPR' }, verifiedAt: NOW }));
    const rows = t.rows().length, ev = t.balEvents().length, calls = t.w.repoCalls.length;
    await expect(t.run('onIntentSettled', settled())).resolves.toBeUndefined();
    expect(t.rows()).toHaveLength(rows); expect(rows).toBe(1); expect(t.balEvents()).toHaveLength(ev); expect(t.items()).toEqual([]);
    const after = t.w.repoCalls.slice(calls);
    expect(after.some((c: any) => c.name === 'findGatewayPayment' && c.args.gateway === 'khalti' && c.args.gatewayTxnRef === 'SYNpidx0000000000000001' && c.args.tenantId === TENANT_A)).toBe(true);
    expect(after.some((c: any) => c.name === 'insertLedgerEntry' || c.name === 'insertFinanceReviewItem')).toBe(false);
  });
  it('idempotent: the same settlement delivered twice (also under a new event_id) leaves one row and one balance event', async () => {
    const t = await setup();
    await t.run('onIntentSettled', settled()); const ev = t.balEvents().length;
    await expect(t.run('onIntentSettled', settled({}, { event_id: EV(2) }))).resolves.toBeUndefined();
    expect(t.rows()).toHaveLength(1); expect(t.balEvents()).toHaveLength(ev);
  });
  it('overpayment: the full amount is recorded and one open review item gateway_payment_exceeds_due is raised (the money is already taken); never throws', async () => {
    const t = await setup({ invoiced: 200000 });
    await expect(t.run('onIntentSettled', settled({ amount: money(225000) }))).resolves.toBeUndefined();
    expect(t.rows()).toHaveLength(1); expect(t.rows()[0].amount_paisa).toBe(225000);
    expect(t.items()).toHaveLength(1);
    expect(t.items()[0]).toMatchObject({ kind: 'gateway_payment_exceeds_due', ledger_entry_id: t.rows()[0].id, order_id: IDS.order, status: 'open', amount_paisa: '25000' });
    await t.run('onIntentSettled', settled({ amount: money(225000) }, { event_id: EV(2) }));
    expect(t.items()).toHaveLength(1);
  });
  it('optional invoice_id is linked when present; optional ledger_entry_id and unknown fields are ignored (the payload never names the ledger row)', async () => {
    const t = await setup(); const inv = t.w.invoiceIdOf(TENANT_A, IDS.order);
    const FAKE_LEDGER = V7('000000ffffff');
    await t.run('onIntentSettled', settled({ invoice_id: inv, ledger_entry_id: FAKE_LEDGER, future_field: 'x-SYN-3' }));
    expect(t.rows()[0].invoice_id).toBe(inv); expect(t.rows()[0].id).not.toBe(FAKE_LEDGER);
    const t2 = await setup();
    await t2.run('onIntentSettled', settled());
    expect(t2.rows()[0].invoice_id ?? null).toBeNull();
    expect(JSON.stringify(t.w.repoCalls)).not.toContain('x-SYN-3');
  });
});

describe('tenant isolation and authority (07-SECURITY consumer probes; A19 forged tenant_id)', () => {
  it('home collection: the tenant comes from ctx only — every repo call carries ctx.tenantId, and an envelope naming another tenant writes nothing', async () => {
    const t = await setup();
    await t.run('onCollectionSynced', synced([pay(1, 100000)]));
    for (const c of t.w.repoCalls) expect(c.args.tenantId ?? c.args.tenant_id, c.name).toBe(TENANT_A);
    const f = await setup(); const mark = f.w.repoCalls.length;
    await rejected(f.run('onCollectionSynced', synced([pay(1, 100000)], {}, { tenant_id: OTHER_TENANT })));
    expect(f.rows()).toEqual([]); expect(f.items()).toEqual([]); expect(f.balEvents()).toHaveLength(0);
    expect(f.w.repoCalls.slice(mark).some((c: any) => c.name === 'insertLedgerEntry')).toBe(false);
  });
  it('gateway: same two guarantees', async () => {
    const t = await setup();
    await t.run('onIntentSettled', settled());
    for (const c of t.w.repoCalls) expect(c.args.tenantId ?? c.args.tenant_id, c.name).toBe(TENANT_A);
    const f = await setup();
    await rejected(f.run('onIntentSettled', settled({}, { tenant_id: OTHER_TENANT })));
    expect(f.rows()).toEqual([]); expect(f.balEvents()).toHaveLength(0);
  });
  it('an order that exists only in another tenant is not touched: the payment is not attributed across tenants', async () => {
    const t = await setup(); const mark = t.w.repoCalls.length;
    await rejected(t.run('onCollectionSynced', synced([pay(1, 100000)], { order_id: V7('000000050fff') })));
    expect(t.rows()).toEqual([]); expect(t.items()).toEqual([]);
    expect(t.w.repoCalls.slice(mark).every((c: any) => (c.args.tenantId ?? c.args.tenant_id) === TENANT_A)).toBe(true);
  });
});
