// BL-T14 LD-26 (2026-11-07, A33-3 training tenant): tenant setting `trainingMode = true` (provisioning-only, immutable) => C4 never syncs to CBMS and invoice numbers carry the prefix `TRN-`.
// Read ONLY through the C2 settings read port: IdentityPort.getTenantSettings(ctx,{keys:[…,'trainingMode']}) (CR .orchestra/cr/C2.T16.md adds the key; C4 must not read C2 tables).
// The fake port below FILTERS by the requested keys like the real one (identity/ports/IdentityPort.impl.ts), so code that forgets to ask for 'trainingMode' sees `undefined` = not a training tenant.
// Covers: issue (B-issue path), cancel (B4), partial credit (B5), B31 retry. Existing real-duty / not-required behaviour is covered by invoice.issue/cancel/credit tests and is re-checked here as the control.
// Fails now: invoice.service.ts never asks for trainingMode (invoice numbers lack TRN-, CBMS jobs are enqueued). Periodic invoices (B21, credit.service.ts) are NOT covered here (see notes).
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createInvoiceService } from '../invoice.service.js';
const createCbmsService = async (deps: unknown) => ((await import('../cbms.service.js')) as any).createCbmsService(deps);
import { doc, makeCbmsWorld, scriptedClient } from './t14.helpers.js';
import { makeT10World, type T10World } from './t10.helpers.js';
import { issueInput, line } from './t06.helpers.js';

const svcOf = (w: T10World) => createInvoiceService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events) as never }) as any;
const L = [line(), line({ lineRef: 'L2', orderItemId: '01a1a98a-ac40-7000-8000-000000060002', orderableId: '01a1a98a-ac40-7000-8000-000000070002', code: 'LIP', name: 'Lipid profile', unitPrice: { amountPaisa: 50000, currency: 'NPR' }, tax: { vat: 'exempt' } })];
const asked: string[][] = [];
function ctxOf(w: { tenantSettings: Record<string, any>; ctx: (o?: Record<string, unknown>) => never }) {
  return w.ctx({ ports: { IdentityPort: {
    async getTenantSettings(_c: unknown, input: { keys?: readonly string[] }) {
      asked.push([...(input.keys ?? [])]);
      return Object.fromEntries((input.keys ?? Object.keys(w.tenantSettings)).map((k) => [k, w.tenantSettings[k]]));
    },
  } } });
}
const TRAINING = { trainingMode: true };                                   // ird.cbmsRealtimeRequired stays true (world default): the flag must win
async function issue(w: T10World, over: Record<string, unknown> = {}) {
  const ctx = ctxOf(w); const input = await issueInput(ctx, { lines: L, ...over });
  return w.tx(() => svcOf(w).issue(ctx, input as never)) as Promise<{ invoiceId: string; invoiceNo: string }>;
}

describe('LD-26 issue', () => {
  it('training tenant: invoice_no is `TRN-` + the tenant pattern output, cbms_state not_required, NO sync job, the counter still allocates gaplessly', async () => {
    const w = makeT10World({ tenantSettings: TRAINING });
    const a = await issue(w), b = await issue(w, { orderId: '01a1a98a-ac40-7000-8000-000000050002' });
    expect(a.invoiceNo).toBe('TRN-083/84-000001'); expect(b.invoiceNo).toBe('TRN-083/84-000002');
    expect(w.s.invoices.map((i) => [i.invoice_no, i.invoice_seq, i.cbms_state])).toEqual([['TRN-083/84-000001', 1, 'not_required'], ['TRN-083/84-000002', 2, 'not_required']]);
    expect(w.s.cbms).toEqual([]);
    expect(asked.flat()).toContain('trainingMode');                         // read through the settings port
  });
  it('control: trainingMode false or absent => plain number, cbms pending, one job (the flag must not leak into normal tenants)', async () => {
    for (const ts of [{ trainingMode: false }, {}]) {
      const w = makeT10World({ tenantSettings: ts }); const r = await issue(w);
      expect(r.invoiceNo).toBe('083/84-000001'); expect(w.s.invoices[0].cbms_state).toBe('pending'); expect(w.s.cbms).toHaveLength(1);
    }
  });
  it('training tenant with ird.cbmsRealtimeRequired=false: still TRN- and not_required', async () => {
    const w = makeT10World({ tenantSettings: { ...TRAINING, ird: { pan: '999999999', cbmsRealtimeRequired: false } } });
    expect((await issue(w)).invoiceNo).toBe('TRN-083/84-000001'); expect(w.s.cbms).toEqual([]);
  });
});

describe('LD-26 cancel / partial credit: no CBMS documents for a training tenant', () => {
  it('cancel: cbms_cancel_state and the credit note state are not_required, no invoice_cancellation / credit_note job', async () => {
    const w = makeT10World({ tenantSettings: { ...TRAINING, numbering: { invoiceNoPattern: '{fy}-{seq:6}', creditNoteNoPattern: 'CN-{fy}-{seq:6}' } } });
    const inv = await issue(w); const ctx = ctxOf(w);
    await w.tx(() => svcOf(w).cancel(ctx, { invoiceId: inv.invoiceId, reasonCode: 'billing_error' }));
    expect(w.s.invoices[0]).toMatchObject({ status: 'cancelled', cbms_state: 'not_required', cbms_cancel_state: 'not_required' });
    expect(w.x().creditNotes[0].cbms_state).toBe('not_required'); expect(w.s.cbms).toEqual([]);
  });
  it('partial credit: credit note not_required, no job', async () => {
    const w = makeT10World({ tenantSettings: { ...TRAINING, numbering: { invoiceNoPattern: '{fy}-{seq:6}', creditNoteNoPattern: 'CN-{fy}-{seq:6}' } } });
    const inv = await issue(w); const ctx = ctxOf(w);
    const lineId = w.s.lines.find((l) => l.invoice_id === inv.invoiceId && l.code === 'LIP')!.id;
    await w.tx(() => svcOf(w).credit(ctx, { invoiceId: inv.invoiceId, lines: [{ invoiceLineId: lineId }], reasonCode: 'billing_error' }));
    expect(w.x().creditNotes[0].cbms_state).toBe('not_required'); expect(w.s.cbms).toEqual([]);
  });
});

describe('LD-26 B31 retry on a training tenant', () => {
  it('refused: no state change, no job (nothing of a training tenant may ever be queued for CBMS)', async () => {
    const w = makeCbmsWorld({ tenantSettings: TRAINING }); w.put(doc('invoice', { cbms_state: 'failed_permanent' }));
    const svc = await createCbmsService({ repo: w.repo as never, client: scriptedClient(['accepted']) as never }) as any;
    await expect(w.tx(() => svc.retry(ctxOf(w), { documentKind: 'invoice', documentId: w.get('invoice').document_id }))).rejects.toMatchObject({ code: expect.stringMatching(/^(common|billing)\./) });
    expect(w.get('invoice').cbms_state).toBe('failed_permanent'); expect(w.s.cbms).toEqual([]);
  });
  it('control: the same retry on a normal tenant works', async () => {
    const w = makeCbmsWorld(); w.put(doc('invoice', { cbms_state: 'failed_permanent' }));
    const svc = await createCbmsService({ repo: w.repo as never, client: scriptedClient(['accepted']) as never }) as any;
    expect(await w.tx(() => svc.retry(ctxOf(w), { documentKind: 'invoice', documentId: w.get('invoice').document_id }))).toEqual({ cbms_state: 'pending' });
    expect(w.s.cbms).toHaveLength(1);
  });
});
