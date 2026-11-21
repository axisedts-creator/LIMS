// T0B-PRINTCFG-1 done_when (4) PLAIN BILL at the service (printInvoice / printCreditNote, LD-316): style full | plain_bw, stored on the print record.
// Same fake world as print.service.test.ts (t09.helpers). PINNED: input key `style` (contract: PrintInvoiceRequest.style, printCreditNote optional body); result.style always present;
// print_log row carries `style`; plain_bw: the document is built WITHOUT branding images (branding.images = [], IdentityPort.readBrandingAsset is never called) and without receipt_footer_note.
// Reprint inheritance (an old bill keeps its style unless the caller chooses another) needs the real print_log: see printcfg.live.test.ts.
import { describe, expect, it } from 'vitest';
import { createInvoiceService } from '../invoice.service.js';
import { cancelledInvoice, creditNoteRow, IDS, makePrintWorld, type PrintWorld } from './t09.helpers.js';

const svcOf = (w: PrintWorld) => createInvoiceService({ repo: w.repo as never, counter: { allocate: async () => { throw new Error('print must never allocate'); } } as never, events: {} as never }) as any;
const setup = (opts: Parameters<typeof makePrintWorld>[0] = {}) => { const w = makePrintWorld(opts); return { w, svc: svcOf(w) }; };
const printInv = (w: PrintWorld, svc: any, over: Record<string, unknown> = {}) => w.inTx((ctx) => svc.print(ctx, { invoiceId: IDS.inv, ...over }));
const printCn = (w: PrintWorld, svc: any, over: Record<string, unknown> = {}) => w.inTx((ctx) => svc.printCreditNote(ctx, { creditNoteId: IDS.cn, ...over }));
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code; } return undefined; };

describe('printInvoice style', () => {
  it('default style is full: result.style full, print_log style full, branding images as before', async () => {
    const { w, svc } = setup();
    const r = await printInv(w, svc);
    expect(r.style).toBe('full');
    expect(w.s.printLog[0]).toMatchObject({ style: 'full' });
    expect(r.document.branding.images.length).toBe(3);
  });
  it('plain_bw: result.style plain_bw and stored on the print record', async () => {
    const { w, svc } = setup();
    const r = await printInv(w, svc, { style: 'plain_bw' });
    expect(r.style).toBe('plain_bw');
    expect(w.s.printLog).toHaveLength(1);
    expect(w.s.printLog[0]).toMatchObject({ style: 'plain_bw', print_no: 1 });
  });
  it('plain_bw: no logo, no letterhead images, no footer note in the document; no branding asset is even read', async () => {
    const { w, svc } = setup();
    const r = await printInv(w, svc, { style: 'plain_bw' });
    expect(r.document.branding.images).toEqual([]);
    expect('receipt_footer_note' in r.document.branding).toBe(false);
    expect(w.s.brandingReads).toEqual([]);
  });
  it('plain_bw keeps the lines a tax bill needs in the document: lab name, address, seller, bill number, date, items, totals, payment block', async () => {
    const { w, svc } = setup();
    const { document: d } = await printInv(w, svc, { style: 'plain_bw' });
    expect(d.branding).toMatchObject({ legal_name: 'Synthetic Lab Pvt Ltd', address_lines: ['Synthetic Road 2', 'Kathmandu'] });
    expect(d).toMatchObject({ invoice_no: '083/84-000001', invoice_date_bs: '2083-07-22', seller: { name: 'Synthetic Lab Pvt Ltd' } });
    expect(d.lines.length).toBeGreaterThan(0); expect(d.totals.net).toBeDefined(); expect(d.payment_block.paid).toBeDefined(); expect(d.payment_block.balance_due).toBeDefined();
  });
  it('an unknown style is common.validation_failed and nothing is written', async () => {
    const { w, svc } = setup();
    for (const style of ['sepia', 'PLAIN_BW', '', 5, null]) expect(await code(printInv(w, svc, { style })), String(style)).toBe('common.validation_failed');
    expect(w.writes()).toEqual([]); expect(w.s.printLog).toHaveLength(0);
  });
  it('a second print with the other style is a normal copy: print_no 2, copy mark, its own style on its own row', async () => {
    const { w, svc } = setup();
    await printInv(w, svc, { style: 'full' });
    const r = await printInv(w, svc, { style: 'plain_bw', reasonCode: 'customer_copy' });
    expect(r.print_no).toBe(2); expect(r.style).toBe('plain_bw'); expect(r.copy_mark).toBeTruthy();
    expect(w.s.printLog.map((p) => p.style)).toEqual(['full', 'plain_bw']);
  });
});

describe('printCreditNote style', () => {
  const withCn = () => setup({ invoices: [cancelledInvoice()], creditNotes: [creditNoteRow()] });
  it('default full; plain_bw stored on the record, no branding images read', async () => {
    const a = withCn(); const r1 = await printCn(a.w, a.svc);
    expect(r1.style).toBe('full'); expect(a.w.s.printLog[0]).toMatchObject({ style: 'full', document_kind: 'credit_note' });
    const b = withCn(); const r2 = await printCn(b.w, b.svc, { style: 'plain_bw' });
    expect(r2.style).toBe('plain_bw'); expect(b.w.s.printLog[0]).toMatchObject({ style: 'plain_bw', document_kind: 'credit_note' });
    expect(r2.document.branding.images).toEqual([]); expect(b.w.s.brandingReads).toEqual([]);
  });
  it('an unknown style is refused with nothing written', async () => {
    const { w, svc } = withCn();
    expect(await code(printCn(w, svc, { style: 'x' }))).toBe('common.validation_failed'); expect(w.writes()).toEqual([]);
  });
});
