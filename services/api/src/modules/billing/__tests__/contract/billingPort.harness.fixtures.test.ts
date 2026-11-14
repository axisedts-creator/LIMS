// BL-T12 self-check of the test fixtures (billingPort.harness.ts): they behave like the DB they stand for, so a failing contract case is the impl's fault, not the fixture's.
// Passes before the implementation exists (needs no ports/BillingPort.impl.ts).
import { describe, expect, it } from 'vitest';
import { makeBillingPortWorld } from './billingPort.harness.js';
import { IDS, V7 } from '../../service/__tests__/t11.helpers.js';

const A = '01900000-0000-7000-8000-00000000000a', B = '01900000-0000-7000-8000-00000000000b';
const O1 = V7('0000000b0001'), O2 = V7('0000000b0002');
const order = (over: object = {}) => ({ orderId: O1, tenantId: A, invoicedPaisa: 100000, paidPaisa: 0, creditedPaisa: 0, hasInvoice: true, balanceVersion: 1, ...over });
const tx = {} as never;

describe('billing port world', () => {
  it('seeded order: totals, balance row and tenant isolation', async () => {
    const w = makeBillingPortWorld();
    w.seedOrder(order({ paidPaisa: 30000 }) as never);
    const t = await (w.repo as any).readOrderTotals(tx, { tenantId: A, orderId: O1 });
    expect(t).toMatchObject({ invoiced_paisa: '100000', paid_paisa: '30000', credited_paisa: '0', issued_invoice_count: 1, billing_mode: 'cash' });
    expect(await (w.repo as any).readOrderTotals(tx, { tenantId: B, orderId: O1 })).toBeUndefined();
    expect((await (w.repo as any).getOrderBalance(tx, { tenantId: A, orderId: O1 })).balance_version).toBe(1);
  });
  it('credit party -> billing_mode credit; no invoice -> known order with issued_invoice_count 0; re-seeding replaces', async () => {
    const w = makeBillingPortWorld();
    w.seedOrder(order({ creditPartyId: V7('0000000b0099') }) as never);
    expect((await (w.repo as any).readOrderTotals(tx, { tenantId: A, orderId: O1 })).billing_mode).toBe('credit');
    w.seedOrder(order({ hasInvoice: false, invoicedPaisa: 0 }) as never);
    expect(await (w.repo as any).readOrderTotals(tx, { tenantId: A, orderId: O1 })).toMatchObject({ issued_invoice_count: 0, invoiced_paisa: '0', billing_mode: 'cash' });
    w.seedOrder(order({ paidPaisa: 100000 }) as never); w.seedOrder(order({ paidPaisa: 100000 }) as never);
    expect(w.ledgerRowsOf(A, O1)).toHaveLength(1);
  });
  it('overrides: active only when unexpired at `at`; newest wins', async () => {
    const w = makeBillingPortWorld();
    const OV = V7('0000000b0a01');
    w.seedOrder(order({ overrideId: OV, overrideExpiresAt: '2026-11-05T00:00:00.000Z' }) as never);
    expect(await (w.repo as any).findActiveOverride(tx, { tenantId: A, orderId: O1, at: '2026-11-06T00:00:00.000Z' })).toBeUndefined();
    expect((await (w.repo as any).findActiveOverride(tx, { tenantId: A, orderId: O1, at: '2026-11-04T00:00:00.000Z' })).id).toBe(OV);
    const second = await (w.repo as any).insertReleaseOverride(tx, { id: V7('0000000b0a02'), tenantId: A, orderId: O1, centreId: IDS.centre, reasonCode: 'SYN', membershipId: IDS.patient, userId: IDS.patient });
    expect((await (w.repo as any).findActiveOverride(tx, { tenantId: A, orderId: O1, at: '2026-11-04T00:00:00.000Z' })).id).toBe(second.id);
  });
  it('ledger fake: gateway row needs no collector (CHECK), duplicate (gateway, txn ref) is 23505, finance review item needs its ledger row', async () => {
    const w = makeBillingPortWorld();
    w.seedOrder(order() as never);
    const row = (over: object = {}) => ({ id: V7('0000000b0b01'), tenantId: A, branchId: IDS.branch, centreId: IDS.centre, orderId: O1, invoiceId: null, entryKind: 'payment', captureKind: 'gateway', methodCode: 'esewa',
      amountPaisa: 40000, fiscalYearBs: '2083/84', businessDate: '2026-11-08', collectedByMembershipId: null, userId: IDS.patient, gateway: 'esewa', gatewayTxnRef: 'T1', intentId: V7('0000000b0c01'), ...over });
    await expect((w.repo as any).insertLedgerEntry(tx, row({ collectedByMembershipId: IDS.patient }))).rejects.toMatchObject({ code: '23514' });
    await (w.repo as any).insertLedgerEntry(tx, row());
    await expect((w.repo as any).insertLedgerEntry(tx, row({ id: V7('0000000b0b02') }))).rejects.toMatchObject({ code: '23505' });
    expect(await (w.repo as any).sumGatewayByIntent(tx, { tenantId: A, intentId: V7('0000000b0c01') })).toEqual({ payments_paisa: '40000', refunds_paisa: '0' });
    await expect((w.repo as any).insertFinanceReviewItem(tx, { id: V7('0000000b0d01'), tenantId: A, centreId: IDS.centre, orderId: O1, kind: 'gateway_payment_exceeds_due', ledgerEntryId: V7('0000000b0bff'), amountPaisa: 1, userId: IDS.patient })).rejects.toMatchObject({ code: '23503' });
    await (w.repo as any).insertFinanceReviewItem(tx, { id: V7('0000000b0d01'), tenantId: A, centreId: IDS.centre, orderId: O1, kind: 'gateway_payment_exceeds_due', ledgerEntryId: V7('0000000b0b01'), amountPaisa: 1, userId: IDS.patient });
    expect((w.s as any).reviewItems).toHaveLength(1);
  });
  it('FrontdeskPort fake: unknown / other-tenant order -> common.not_found; IdentityPort answers releaseRequiresPayment per tenant', async () => {
    const w = makeBillingPortWorld();
    w.seedOrder(order() as never); w.st.settings.set(A, false);
    await expect(w.fakePorts.FrontdeskPort.getOrderSummary({ tenantId: B } as never, { orderId: O1 })).rejects.toMatchObject({ code: 'common.not_found' });
    await expect(w.fakePorts.FrontdeskPort.getOrderSummary({ tenantId: A } as never, { orderId: O2 })).rejects.toMatchObject({ code: 'common.not_found' });
    expect(await w.fakePorts.IdentityPort.getTenantSettings({ tenantId: A }, { keys: ['releaseRequiresPayment'] })).toMatchObject({ releaseRequiresPayment: false });
    expect(await w.fakePorts.IdentityPort.getTenantSettings({ tenantId: B }, { keys: ['releaseRequiresPayment'] })).toMatchObject({ releaseRequiresPayment: true });
  });
});
