// BL-T09 fixture self-check (passes now): proves the print world is a faithful race model, so the service tests above can fail for the right reason.
import { describe, expect, it } from 'vitest';
import { IDS, makePrintWorld, pgError, rejects, TENANT_A, TENANT_B, USER } from './t09.helpers.js';

const row = (printNo: number, over: Record<string, unknown> = {}) => ({ id: `id-${printNo}`, tenant_id: TENANT_A, centre_id: IDS.centre, document_kind: 'invoice', document_id: IDS.inv, document_no: 'N', print_no: printNo,
  is_copy: printNo > 1, reason_code: null, printed_at: 'x', created_by: USER, ...over });

describe('print world fixtures', () => {
  it('locked UPDATE ... RETURNING: 4 parallel transactions get 1..4', async () => {
    const w = makePrintWorld();
    const n = await Promise.all([1, 2, 3, 4].map(() => w.inTx((ctx) => w.repo.markInvoicePrinted(ctx.tx, { tenantId: TENANT_A, invoiceId: IDS.inv, userId: USER }))));
    expect([...n].sort()).toEqual([1, 2, 3, 4]);
    expect(w.invoice().print_count).toBe(4);
  });
  it('a read-modify-write implementation loses the race: duplicate print_no -> 23505 on the UNIQUE (fails like the real DB)', async () => {
    const w = makePrintWorld();
    const naive = () => w.inTx(async (ctx) => {
      const inv = await w.repo.getInvoice(ctx.tx, { tenantId: TENANT_A, invoiceId: IDS.inv });
      await new Promise((r) => setImmediate(r));
      await w.repo.insertPrintLog(ctx.tx, row(inv!['print_count'] + 1));
    });
    const res = await Promise.allSettled([naive(), naive()]);
    expect(res.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: '23505' });
  });
  it('rollback undoes the count bump, the log row and the activity row; locks are released', async () => {
    const w = makePrintWorld();
    await rejects(w.inTx(async (ctx) => {
      await w.repo.markInvoicePrinted(ctx.tx, { tenantId: TENANT_A, invoiceId: IDS.inv, userId: USER });
      await w.repo.insertPrintLog(ctx.tx, row(1));
      await ctx.audit.access({ action: 'invoice.print' });
      throw new Error('boom');
    }));
    expect(w.invoice().print_count).toBe(0);
    expect(w.s.printLog).toHaveLength(0);
    expect(w.s.access).toHaveLength(0);
    expect(await w.inTx((ctx) => w.repo.markInvoicePrinted(ctx.tx, { tenantId: TENANT_A, invoiceId: IDS.inv, userId: USER }))).toBe(1);
  });
  it('CHECK is_copy = (print_no > 1) and tenant scoping are enforced; a repo call without a tenant id throws', async () => {
    const w = makePrintWorld();
    await expect(w.inTx((ctx) => w.repo.insertPrintLog(ctx.tx, row(1, { is_copy: true })))).rejects.toMatchObject({ code: '23514' });
    expect(await w.inTx((ctx) => w.repo.getInvoice(ctx.tx, { tenantId: TENANT_B, invoiceId: IDS.inv }))).toBeUndefined();
    expect(await w.inTx((ctx) => w.repo.markInvoicePrinted(ctx.tx, { tenantId: TENANT_B, invoiceId: IDS.inv, userId: USER }))).toBeUndefined();
    await expect(w.inTx((ctx) => w.repo.getInvoice(ctx.tx, { invoiceId: IDS.inv }))).rejects.toThrow(/without a tenant id/);
    expect(pgError('X').code).toBe('X');
  });
});
