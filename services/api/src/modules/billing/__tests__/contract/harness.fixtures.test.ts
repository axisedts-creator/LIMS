// BL-T07 harness self-test: proves the in-memory world is faithful BEFORE the impl exists (passes now). Uses the real BL-T06/T08 services
// (createInvoiceService, createLedgerService) through the harness ctx adapter, so envelope validation by contracts/events/*.schema.json is real.
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { createInvoiceService } from '../../service/invoice.service.js';
import { createLedgerService } from '../../service/ledger.service.js';
import { createBillingEvents } from '../../events/publish.js';
import { issueInput } from '../../service/__tests__/t06.helpers.js';
import { makeContractWorld } from './harness.js';

const ctxFor = makeCtxFor();
const ORDER = '01900000-0000-7000-8000-0000000c4001';

describe('contract harness world', () => {
  it('real invoice service issues through the adapter ctx: FY series from the injected clock, events validated by the real publisher', async () => {
    const w = makeContractWorld();
    (w.st.orders as any[]).push({ id: ORDER, tenantId: ctxFor('A').tenantId });
    const inv = createInvoiceService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events as never) as never });
    const ctx: any = w.enrich(ctxFor('A'));
    const input: any = await issueInput(ctx, { orderId: ORDER });
    const ref: any = await inv.issue(ctx, input);
    expect(ref.invoiceNo).toBe('083/84-000001');
    expect(w.events_of('billing.invoice.issued.v1')).toHaveLength(1);
    expect(w.events_of('billing.balance.changed.v1')).toHaveLength(1);
  });

  it('counter: gapless per series, and an allocation whose clock crossed Shrawan 1 throws counter_busy/fiscal_year_rollover without bumping', async () => {
    const w = makeContractWorld();
    const ctx: any = w.enrich(ctxFor('A'));
    const a: any = await w.counter.allocate(ctx.tx, { tenantId: ctx.tenantId, series: 'INV', fiscalYearBs: '2083/84', actorId: ctx.actor.id });
    const rc: any = await w.counter.allocate(ctx.tx, { tenantId: ctx.tenantId, series: 'RC', fiscalYearBs: '2083/84', actorId: ctx.actor.id });
    expect([a.lastNo, rc.lastNo]).toEqual([1, 1]);
    w.enrich(ctxFor('A', { now: () => '2026-07-16T18:15:01.000Z' as never }));
    const e: any = await w.counter.allocate(ctx.tx, { tenantId: ctx.tenantId, series: 'INV', fiscalYearBs: '2082/83', actorId: ctx.actor.id }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'billing.counter_busy', detail: 'fiscal_year_rollover' });
    w.enrich(ctxFor('A'));
    expect((await w.counter.allocate(ctx.tx, { tenantId: ctx.tenantId, series: 'INV', fiscalYearBs: '2083/84', actorId: ctx.actor.id }) as any).lastNo).toBe(2);
  });

  it('ports are tenant-scoped: foreign order / credit party -> common.not_found', async () => {
    const w = makeContractWorld();
    const A: any = w.enrich(ctxFor('A')), B: any = w.enrich(ctxFor('B'));
    (w.st.orders as any[]).push({ id: ORDER, tenantId: A.tenantId });
    (w.st.parties as any[]).push({ id: 'p1', tenantId: A.tenantId, allowsCredit: true, isActive: true, isLocked: false, creditLimitPaisa: null, outstandingPaisa: 0 });
    await expect(w.fakePorts.FrontdeskPort.getOrderSummary(A, { orderId: ORDER })).resolves.toMatchObject({ orderId: ORDER });
    await expect(w.fakePorts.FrontdeskPort.getOrderSummary(B, { orderId: ORDER })).rejects.toMatchObject({ code: 'common.not_found' });
    await expect(w.fakePorts.CatalogPort.getCreditParty(B, { creditPartyId: 'p1', purpose: 'billing' })).rejects.toMatchObject({ code: 'common.not_found' });
    const p: any = await w.fakePorts.CatalogPort.getCreditParty(A, { creditPartyId: 'p1', purpose: 'billing' });
    expect(p).toMatchObject({ pan: '123456789', billingAddressText: 'Synthetic Street 1' });
  });

  it('real ledger service records a manual payment through the adapter ctx (cashier membership = actor)', async () => {
    const w = makeContractWorld();
    (w.st.invoices as any[]).push({ id: 'i1', tenant_id: ctxFor('A').tenantId, order_id: ORDER, purpose: 'registration', status: 'issued', net_paisa: 100000 });
    const led = createLedgerService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events as never) as never });
    const r: any = await led.recordPayment(w.enrich(ctxFor('A')), { orderId: ORDER, methodCode: 'cash', amount: { amountPaisa: 40000, currency: 'NPR' }, captureKind: 'manual', idempotencyKey: 'k1', issueReceiptNo: false });
    expect(r.duplicate).toBe(false);
  });
});
