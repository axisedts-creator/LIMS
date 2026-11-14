// BL-T06 balance service: order_balances recompute + billing.balance.changed.v1 (02-TRD §6.2 rules 1–6, §6.2 "Balance:", §8.1; PRD US-FD-03.1, US-BL-06.1; 05-SCHEMA order_balances guard).
// done_when: "balance_version strictly increasing; one balance event per balance change".
// Fails now: ../balance.service.js does not exist.
// ASSUMED API (writer: object via a dispute if wrong):
//   balance.service.ts : createBalanceService(deps: { repo, events: ReturnType<typeof createBillingEvents> }) -> { applyChange(ctx, { orderId, cause }) }
//     applyChange re-reads the four amounts (repo.readOrderTotals), compares with the stored row (repo.getOrderBalance):
//       unchanged amounts -> NO write, NO event, returns { changed: false, balanceVersion };
//       changed (or first row: version 1) -> repo.upsertOrderBalance with balanceVersion = old + 1, then ONE billing.balance.changed.v1 in the same tx
//       -> { changed: true, balanceVersion }.  release_eligible/release_basis per TRD §6.2 rules 1–6, policy = IdentityPort.getTenantSettings releaseRequiresPayment.
//   Repo seam: see t06.helpers.ts header (bigint columns arrive as strings; events carry integer paisa numbers).
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createBalanceService } from '../balance.service.js';
import { IDS, makeWorld, money, rejection, TENANT_A, type World } from './t06.helpers.js';

const svcOf = (w: World) => createBalanceService({ repo: w.repo as never, events: createBillingEvents(w.events) as never });
/** Seed `n` issued invoices (net paisa) for the order straight into the world, bypassing issue(). */
const seedInvoice = (w: World, net: number, order = IDS.order) =>
  w.s.invoices.push({ tenant_id: TENANT_A, order_id: order, net_paisa: net, purpose: w.s.invoices.length ? 'supplementary' : 'registration' });
const pay = (w: World, paisa: number, order = IDS.order) => { w.s.paid[`${TENANT_A}|${order}`] = (w.s.paid[`${TENANT_A}|${order}`] ?? 0) + paisa; };
const bal = (w: World) => w.events_of('billing.balance.changed.v1').map((e) => e.envelope);

describe('first balance (invoice issued)', () => {
  it('no row yet -> version 1, one event: cause invoice_issued, integer Money, key <order>:balance:1, due_outstanding (policy on)', async () => {
    const w = makeWorld(); const svc = svcOf(w); const ctx = w.ctx();
    seedInvoice(w, 225000);
    const out = await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'invoice_issued' }));
    expect(out).toMatchObject({ changed: true, balanceVersion: 1 });
    const [e] = bal(w);
    expect(e.payload).toEqual({ order_id: IDS.order, balance_version: 1, invoiced: money(225000), paid: money(0), credited: money(0), balance_due: money(225000),
      cause: 'invoice_issued', release_eligible: false, release_basis: 'due_outstanding' });
    expect(e.idempotency_key).toBe(`${IDS.order}:balance:1`);
    expect(e.aggregate).toEqual({ type: 'order_balance', id: IDS.order, seq: 1 });
    expect(w.s.balances[`${TENANT_A}|${IDS.order}`]).toMatchObject({ balance_version: 1, invoiced_paisa: 225000, balance_due_paisa: 225000, release_basis: 'due_outstanding' });
  });
  it('US-FD-03.1 / PRD 184: net 2,250.00 then cash 1,000.00 -> version 2, balance_due 1,250.00, payment_recorded, still due_outstanding', async () => {
    const w = makeWorld(); const svc = svcOf(w); const ctx = w.ctx();
    seedInvoice(w, 225000);
    await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'invoice_issued' }));
    pay(w, 100000);
    await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'payment_recorded' }));
    expect(bal(w).map((e) => [e.payload.balance_version, e.payload.cause, e.payload.balance_due.amount_paisa, e.payload.release_basis])).toEqual([
      [1, 'invoice_issued', 225000, 'due_outstanding'], [2, 'payment_recorded', 125000, 'due_outstanding']]);
  });
});

describe('one balance event per change; balance_version strictly increasing', () => {
  it('unchanged amounts -> no write, no event, same version (version moves only when invoiced/paid/credited moves)', async () => {
    const w = makeWorld(); const svc = svcOf(w); const ctx = w.ctx();
    seedInvoice(w, 113000);
    await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'invoice_issued' }));
    const writes = w.repoCalls.filter((c) => c.name === 'upsertOrderBalance').length;
    const out = await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'payment_recorded' }));
    expect(out).toMatchObject({ changed: false, balanceVersion: 1 });
    expect(bal(w)).toHaveLength(1);
    expect(w.repoCalls.filter((c) => c.name === 'upsertOrderBalance')).toHaveLength(writes);
  });
  it('invoice + 3 payments + a reversal -> versions 1..5, 5 events, 5 distinct keys, each seq equals its version', async () => {
    const w = makeWorld(); const svc = svcOf(w); const ctx = w.ctx();
    seedInvoice(w, 300000);
    await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'invoice_issued' }));
    for (const p of [100000, 100000, 50000]) { pay(w, p); await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'payment_recorded' })); }
    pay(w, -50000); await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'payment_reversed' }));
    const evs = bal(w);
    expect(evs.map((e) => e.payload.balance_version)).toEqual([1, 2, 3, 4, 5]);
    expect(evs.map((e) => e.aggregate.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(evs.map((e) => e.idempotency_key)).size).toBe(5);
    expect(evs.at(-1)!.payload).toMatchObject({ paid: money(200000), balance_due: money(100000), cause: 'payment_reversed' });
  });
  it('a supplementary invoice on the same order bumps the version once (invoiced grows) and emits one event', async () => {
    const w = makeWorld(); const svc = svcOf(w); const ctx = w.ctx();
    seedInvoice(w, 100000); await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'invoice_issued' }));
    seedInvoice(w, 50000); await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'invoice_issued' }));
    expect(bal(w).map((e) => [e.payload.balance_version, e.payload.invoiced.amount_paisa])).toEqual([[1, 100000], [2, 150000]]);
  });
  it('two orders keep independent version counters', async () => {
    const w = makeWorld(); const svc = svcOf(w); const ctx = w.ctx();
    seedInvoice(w, 100000, IDS.order); seedInvoice(w, 200000, IDS.order2);
    await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'invoice_issued' }));
    await w.tx(() => svc.applyChange(ctx, { orderId: IDS.order2, cause: 'invoice_issued' }));
    expect(bal(w).map((e) => [e.payload.order_id, e.payload.balance_version])).toEqual([[IDS.order, 1], [IDS.order2, 1]]);
  });
});

describe('release eligibility in the event (02-TRD §6.2 rules 1–6)', () => {
  const basis = async (setup: (w: World) => void, tenant: Record<string, unknown> = {}) => {
    const w = makeWorld({ tenantSettings: tenant }); const svc = svcOf(w); setup(w);
    await w.tx(() => svc.applyChange(w.ctx(), { orderId: IDS.order, cause: 'invoice_issued' }));
    return bal(w)[0].payload;
  };
  it('releaseRequiresPayment=false -> eligible, policy_not_enforced (rule 1)', async () => {
    expect(await basis((w) => seedInvoice(w, 100000), { releaseRequiresPayment: false })).toMatchObject({ release_eligible: true, release_basis: 'policy_not_enforced' });
  });
  it('paid in full -> eligible, paid_in_full (rule 5)', async () => {
    expect(await basis((w) => { seedInvoice(w, 100000); pay(w, 100000); })).toMatchObject({ release_eligible: true, release_basis: 'paid_in_full' });
  });
  it('invoice net 0 and nothing paid -> eligible, zero_balance (rule 5)', async () => {
    expect(await basis((w) => seedInvoice(w, 0))).toMatchObject({ release_eligible: true, release_basis: 'zero_balance' });
  });
  it('active release override -> eligible, override (rule 3)', async () => {
    expect(await basis((w) => { seedInvoice(w, 100000); w.s.override = { id: IDS.item1 }; })).toMatchObject({ release_eligible: true, release_basis: 'override' });
  });
  it('balance still due and no override -> not eligible, due_outstanding (rule 6)', async () => {
    expect(await basis((w) => { seedInvoice(w, 100000); pay(w, 1); })).toMatchObject({ release_eligible: false, release_basis: 'due_outstanding' });
  });
});

describe('failure, tenancy and bad data', () => {
  it('event publish failure rolls the balance row back with it: no row, no event; retry then yields version 1', async () => {
    const w = makeWorld(); const svc = svcOf(w); const ctx = w.ctx();
    seedInvoice(w, 100000);
    w.db.fail(/INSERT\s+INTO\s+core\.event_log/i);
    await rejection(w.tx(() => svc.applyChange(ctx, { orderId: IDS.order, cause: 'invoice_issued' })));
    expect(w.s.balances).toEqual({}); expect(bal(w)).toHaveLength(0);
  });
  it('every repo read/write is scoped to ctx.tenantId (no tenant taken from input)', async () => {
    const w = makeWorld(); const svc = svcOf(w);
    seedInvoice(w, 100000);
    await w.tx(() => svc.applyChange(w.ctx(), { orderId: IDS.order, cause: 'invoice_issued', tenantId: 'ffffffff-ffff-7fff-8fff-ffffffffffff' } as never));
    expect(w.repoCalls.length).toBeGreaterThan(0);
    expect(w.repoCalls.every((c) => c.args.tenantId === TENANT_A)).toBe(true);
  });
  it('an order with no invoice and no payment -> common.not_found, nothing written, no event', async () => {
    const w = makeWorld(); const svc = svcOf(w);
    const e = await rejection(w.tx(() => svc.applyChange(w.ctx(), { orderId: IDS.order, cause: 'invoice_issued' })));
    expect(e.code).toBe('common.not_found');
    expect(w.repoCalls.some((c) => c.name === 'upsertOrderBalance')).toBe(false); expect(bal(w)).toHaveLength(0);
  });
  it('malformed order id or unknown cause -> common.validation_failed before any repo call', async () => {
    for (const input of [{ orderId: 'not-a-uuid', cause: 'invoice_issued' }, { orderId: IDS.order, cause: 'refund' }, { orderId: undefined, cause: 'invoice_issued' }]) {
      const w = makeWorld(); const svc = svcOf(w);
      expect((await rejection(w.tx(() => svc.applyChange(w.ctx(), input as never)))).code).toBe('common.validation_failed');
      expect(w.repoCalls).toEqual([]);
    }
  });
  it('an amount beyond Number.MAX_SAFE_INTEGER is refused (never a rounded Money), nothing stored', async () => {
    const w = makeWorld(); const svc = svcOf(w);
    seedInvoice(w, 100000); w.s.invoices[0].net_paisa = '9007199254740993';
    await rejection(w.tx(() => svc.applyChange(w.ctx(), { orderId: IDS.order, cause: 'invoice_issued' })));
    expect(bal(w)).toHaveLength(0); expect(w.s.balances).toEqual({});
  });
  it('a DB-guard violation (stale version) propagates and no event leaks', async () => {
    const w = makeWorld(); const svc = svcOf(w);
    seedInvoice(w, 100000);
    await w.tx(() => svc.applyChange(w.ctx(), { orderId: IDS.order, cause: 'invoice_issued' }));
    w.s.balances[`${TENANT_A}|${IDS.order}`].balance_version = 7; // a concurrent writer moved it; amounts differ below
    pay(w, 5000);
    const before = bal(w).length;
    const out = await w.tx(() => svc.applyChange(w.ctx(), { orderId: IDS.order, cause: 'payment_recorded' }));
    expect(out.balanceVersion).toBe(8); // always previous stored version + 1, never a counter kept in memory
    expect(bal(w)).toHaveLength(before + 1);
  });
});
