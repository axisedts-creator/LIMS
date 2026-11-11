// BL-T08 helper sanity (passes now): the ledger fake enforces the same constraints as 05-SCHEMA so a wrong service cannot pass by relying on a lax fake.
import { describe, expect, it } from 'vitest';
import { IDS, makeLedgerWorld, TENANT_A } from './t08.helpers.js';

const entry = (over: Record<string, unknown> = {}) => ({
  id: '01a1a98a-ac40-7000-8000-000000900001', tenantId: TENANT_A, branchId: IDS.branch, centreId: IDS.centre, orderId: IDS.order, invoiceId: null, entryKind: 'payment', captureKind: 'manual',
  methodCode: 'cash', amountPaisa: 100, fiscalYearBs: '2083/84', businessDate: '2026-11-08', collectedByMembershipId: 'm', userId: 'u', ...over,
});
describe('t08 ledger world', () => {
  it('seeds one invoice of 2,250.00 and derives paid from ledger rows', async () => {
    const w = makeLedgerWorld(); const tx = {} as never;
    expect(await w.repo.readOrderTotals(tx, { tenantId: TENANT_A, orderId: IDS.order })).toMatchObject({ invoiced_paisa: '225000', paid_paisa: '0', issued_invoice_count: 1 });
    await (w.repo as any).insertLedgerEntry(tx, entry());
    expect(await w.repo.readOrderTotals(tx, { tenantId: TENANT_A, orderId: IDS.order })).toMatchObject({ paid_paisa: '100' });
  });
  it('rejects what the DB rejects: card-number reference, non-positive payment, duplicate idempotency key / receipt seq, collector/gateway mismatch', async () => {
    const w = makeLedgerWorld(); const tx = {} as never; const ins = (o: Record<string, unknown>) => (w.repo as any).insertLedgerEntry(tx, entry(o));
    await expect(ins({ referenceText: '4111111111111111' })).rejects.toMatchObject({ code: '23514' });
    await expect(ins({ amountPaisa: 0 })).rejects.toMatchObject({ code: '23514' });
    await expect(ins({ captureKind: 'gateway' })).rejects.toMatchObject({ code: '23514' });
    await ins({ idempotencyKey: 'k', receiptSeq: 1 });
    await expect(ins({ id: '01a1a98a-ac40-7000-8000-000000900002', idempotencyKey: 'k' })).rejects.toMatchObject({ code: '23505' });
    await expect(ins({ id: '01a1a98a-ac40-7000-8000-000000900003', receiptSeq: 1 })).rejects.toMatchObject({ code: '23505' });
  });
  it('one open session per (membership, centre); tx rollback restores ledger and sessions', async () => {
    const w = makeLedgerWorld(); const tx = {} as never; const a = { tenantId: TENANT_A, branchId: IDS.branch, centreId: IDS.centre, membershipId: 'm', openedAt: 't', userId: 'u' };
    await (w.repo as any).insertCashSession(tx, { id: 's1', ...a });
    await expect((w.repo as any).insertCashSession(tx, { id: 's2', ...a })).rejects.toMatchObject({ code: '23505' });
    await expect(w.tx(async () => { await (w.repo as any).insertLedgerEntry(tx, entry()); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(w.ledger()).toHaveLength(0); expect(w.sessions()).toHaveLength(1);
  });
});
