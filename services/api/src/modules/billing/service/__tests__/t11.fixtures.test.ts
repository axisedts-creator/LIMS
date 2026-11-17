// BL-T11 helper self-checks (pass today): the fake world models the 05-SCHEMA guards the services must satisfy, so a wrong service fails on them for the right reason.
import { describe, expect, it } from 'vitest';
import { CASHIER, F1, F2, IDS, INVOICE, makeRefundWorld, SESSION, TENANT_A, V7 } from './t11.helpers.js';

const base = (w: any, over: Record<string, unknown> = {}) => ({ id: V7('0000000c1001'), tenantId: TENANT_A, branchId: IDS.branch, centreId: IDS.centre, orderId: IDS.order, invoiceId: INVOICE,
  entryKind: 'reversal', captureKind: 'manual', methodCode: 'cash', amountPaisa: -225000, fiscalYearBs: '2083/84', businessDate: '2026-11-08', collectedByMembershipId: CASHIER, userId: V7('000000030001'),
  reasonCode: 'R', approvedByMembershipId: F1, ...over });
const ins = (w: any, e: any) => w.repo.insertLedgerEntry({}, e);
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return `${e.code}:${e.message}`; } return 'ok'; };

describe('t11 fake world', () => {
  it('seeds a payment, models credited, and reads paid as the signed ledger sum', async () => {
    const w = makeRefundWorld(); w.setCredited(225000); const id = w.seedPayment(1, { collected_by_membership_id: CASHIER });
    const t = await (w.repo as any).readOrderTotals({}, { tenantId: TENANT_A, orderId: IDS.order });
    expect(t).toMatchObject({ invoiced_paisa: '225000', paid_paisa: '225000', credited_paisa: '225000', branch_id: IDS.branch });
    expect(id).toBeDefined();
  });
  it('ledger_reversal_guard: copy fields, amount, single reversal and the cash-session rule are enforced', async () => {
    const w = makeRefundWorld(); w.addSession({ id: SESSION(1), membership_id: CASHIER });
    const id = w.seedPayment(1, { collected_by_membership_id: CASHIER, cash_session_id: SESSION(1) });
    expect(await code(ins(w, base(w, { reversesEntryId: id, cashSessionId: SESSION(1) })))).toBe('ok');
    expect(await code(ins(w, base(w, { id: V7('0000000c1002'), reversesEntryId: id, cashSessionId: SESSION(1) })))).toContain('23505');
    const id2 = w.seedPayment(2, { collected_by_membership_id: CASHIER, cash_session_id: SESSION(1) });
    expect(await code(ins(w, base(w, { id: V7('0000000c1003'), reversesEntryId: id2, cashSessionId: null })))).toContain('reversal_mismatch');           // wrong session
    expect(await code(ins(w, base(w, { id: V7('0000000c1004'), reversesEntryId: id2, cashSessionId: SESSION(1), collectedByMembershipId: F2 })))).toContain('reversal_mismatch'); // collector not copied
    expect(await code(ins(w, base(w, { id: V7('0000000c1005'), reversesEntryId: id2, cashSessionId: SESSION(1), amountPaisa: -1 })))).toContain('reversal_mismatch');
  });
  it('refund CHECKs: negative, reason, approver, request uniqueness; two_person CHECK on the request', async () => {
    const w = makeRefundWorld();
    const refund = (o: Record<string, unknown>) => ins(w, base(w, { entryKind: 'refund', captureKind: 'manual', collectedByMembershipId: F2, approvedByMembershipId: F2, ...o }));
    expect(await code(refund({ id: V7('0000000c2001'), amountPaisa: 5 }))).toContain('23514');
    expect(await code(refund({ id: V7('0000000c2002'), reasonCode: null }))).toContain('23514');
    expect(await code(refund({ id: V7('0000000c2003'), approvedByMembershipId: null }))).toContain('23514');
    expect(await code(refund({ id: V7('0000000c2004'), refundRequestId: V7('0000000e0001') }))).toBe('ok');
    expect(await code(refund({ id: V7('0000000c2005'), refundRequestId: V7('0000000e0001') }))).toContain('23505');
    const q = w.seedRequest(1);
    expect(await code((w.repo as any).decideRefundRequest({}, { tenantId: TENANT_A, refundRequestId: q, expectedVersion: 1, status: 'approved', decidedByMembershipId: F1, decidedAt: 'x', ledgerEntryId: V7('0000000c2004'), userId: 'u' }))).toContain('23514');
  });
});
