// BL-T09 test helpers (not a test file): in-memory "print world" with per-transaction undo + row locks, so parallel prints are real races.
// ASSUMED seams (spec fixes behaviour, not signatures; writer: object via a dispute if wrong) — all repo fns take (tx, args), tenantId from ctx only:
//   repo.getInvoice(tx,{tenantId,invoiceId})                 -> billing.invoices row | undefined                (exists: invoices.repo.ts)
//   repo.listInvoiceLines(tx,{tenantId,invoiceId})           -> invoice_lines rows ordered by line_no           (exists: invoiceLines.repo.ts)
//   repo.getCreditNote(tx,{tenantId,creditNoteId})           -> billing.credit_notes row | undefined            (exists: creditNotes.repo.ts)
//   repo.listCreditNoteLines(tx,{tenantId,creditNoteId})     -> billing.credit_note_lines rows by line_no       (NEW, creditNotes.repo.ts)
//   repo.getOrderBalance(tx,{tenantId,orderId})              -> order_balances row | undefined                  (exists: balances.repo.ts)
//   repo.markInvoicePrinted(tx,{tenantId,invoiceId,userId})  -> NEW print_count | undefined; row lock           (exists: invoices.repo.ts)
//   repo.markCreditNotePrinted(tx,{tenantId,creditNoteId,userId}) -> same for credit_notes                      (NEW, creditNotes.repo.ts)
//   repo.insertPrintLog(tx,row)                              -> void; row = snake_case billing.print_log columns (NEW, printLog.repo.ts)
//   repo.insertActivity(tx,row)                              -> void                                            (exists: activity.repo.ts)
// ctx = { tenantId, actor, requestId, tx, now, audit:{access}, ports:{IdentityPort:{assertRole,getTenantSettings,readBrandingAsset}} }.
// Synthetic data only.
import { LimsError } from '../../../../core/errors.js';
import { pgError } from '../../../../core/events/__tests__/helpers.js';

export { TENANT_A, USER, MEMBERSHIP, REQ_ID, pgError } from '../../../../core/events/__tests__/helpers.js';
import { MEMBERSHIP, REQ_ID, TENANT_A, USER } from '../../../../core/events/__tests__/helpers.js';

export const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const IDS = {
  inv: V7('0000000a0001'), inv2: V7('0000000a0002'), invNullCentre: V7('0000000a0003'), invOther: V7('0000000a0009'), cn: V7('0000000c0001'), cn2: V7('0000000c0002'),
  cnOther: V7('0000000c0009'), order: V7('000000050001'), patient: V7('000000040001'), branch: V7('000000010001'), centre: V7('000000020002'),
  logo: V7('0000000b0001'), headerAsset: V7('0000000b0002'), footerAsset: V7('0000000b0003'), unknown: V7('0000000f0f0f'),
};
export const BASE = '2026-11-08T06:00:00.000Z';
export const COPY_MARK = 'Copy of Original / प्रतिलिपि';
export const REASONS = ['first_print', 'reprint', 'printer_fault', 'customer_copy'] as const;
export const BUYER_NAME = 'Synthetic Buyer One', BUYER_PAN = '123456789';
export const OTHER_USER = V7('000000030009');

export const invoiceRow = (over: Record<string, unknown> = {}) => ({
  id: IDS.inv, tenant_id: TENANT_A, branch_id: IDS.branch, centre_id: IDS.centre, series: 'INV', fiscal_year_bs: '2083/84', invoice_seq: 1, invoice_no: '083/84-000001',
  invoice_kind: 'tax_invoice', purpose: 'registration', order_id: IDS.order, patient_id: IDS.patient, credit_party_id: null, is_periodic_credit_bill: false, referrer_id: null,
  buyer_name: BUYER_NAME, buyer_pan: BUYER_PAN, buyer_address: 'Synthetic Street 1', seller_name: 'Synthetic Lab Pvt Ltd', seller_pan: '999999999', seller_address: 'Synthetic Road 2',
  issued_at: '2026-11-08T05:00:00.000Z', invoice_date_bs: '2083-07-22', gross_paisa: '100000', discount_paisa: '0', exempt_paisa: '0', taxable_paisa: '100000', vat_paisa: '13000',
  other_tax_paisa: '0', net_paisa: '113000', credited_total_paisa: '0', status: 'issued', is_active: true, print_count: 0, last_printed_at: null, cbms_state: 'pending', cbms_cancel_state: null,
  cancelled_at: null, cancel_reason_code: null, cancel_reason_text: null, credit_note_id: null, version: 1, ...over,
});
export const cancelledInvoice = (over: Record<string, unknown> = {}) => invoiceRow({
  status: 'cancelled', is_active: false, cancelled_at: '2026-11-08T05:30:00.000Z', cancel_reason_code: 'billing_error', cancel_reason_text: null, credit_note_id: IDS.cn, cbms_cancel_state: 'pending', ...over,
});
export const creditNoteRow = (over: Record<string, unknown> = {}) => ({
  id: IDS.cn, tenant_id: TENANT_A, branch_id: IDS.branch, centre_id: IDS.centre, series: 'CN', fiscal_year_bs: '2083/84', credit_note_seq: 1, credit_note_no: 'CN-083/84-000001',
  kind: 'cancellation', invoice_id: IDS.inv, invoice_no: '083/84-000001', invoice_fiscal_year_bs: '2083/84', order_id: IDS.order, credit_party_id: null, buyer_name: BUYER_NAME, buyer_pan: BUYER_PAN,
  issued_at: '2026-11-08T05:30:00.000Z', credit_note_date_bs: '2083-07-22', reason_code: 'billing_error', reason_text: null, gross_paisa: '100000', discount_paisa: '0', exempt_paisa: '0',
  taxable_paisa: '100000', vat_paisa: '13000', other_tax_paisa: '0', net_paisa: '113000', is_active: true, print_count: 0, last_printed_at: null, cbms_state: 'pending', version: 1, ...over,
});
const lineRow = (n: number, invoiceId: string) => ({
  id: V7(`0000000e00${String(n).padStart(2, '0')}`), tenant_id: TENANT_A, invoice_id: invoiceId, line_no: n, line_kind: 'orderable', orderable_id: V7('000000070001'), code: 'CBC', name: 'Complete blood count',
  quantity: 1, unit_price_paisa: '100000', gross_paisa: '100000', discount_paisa: '0', exempt_paisa: '0', taxable_paisa: '100000', vat_treatment: 'taxable', vat_rate_bp: 1300, vat_paisa: '13000',
  other_tax_paisa: '0', net_paisa: '113000',
});
const cnLineRow = (n: number, creditNoteId: string) => ({ ...lineRow(n, creditNoteId), invoice_id: undefined, credit_note_id: creditNoteId, invoice_line_id: V7('0000000e0001') });

const tick = () => new Promise<void>((r) => setImmediate(r));

export interface PrintWorldOpts {
  invoices?: Record<string, unknown>[]; creditNotes?: Record<string, unknown>[];
  branding?: Record<string, unknown>; balance?: Record<string, unknown> | null;
}
interface FakeTx { readonly id: number; readonly undo: Array<() => void>; readonly locks: string[]; closed: boolean }

export function makePrintWorld(opts: PrintWorldOpts = {}) {
  const s = {
    invoices: new Map<string, any>(), creditNotes: new Map<string, any>(), printLog: [] as any[], activity: [] as any[], access: [] as any[],
    assertRoleCalls: [] as any[], brandingReads: [] as any[], settingsCalls: [] as any[],
    balance: (opts.balance === null ? undefined : { tenant_id: TENANT_A, order_id: IDS.order, invoiced_paisa: '113000', paid_paisa: '50000', credited_paisa: '0', balance_due_paisa: '63000', balance_version: 2, ...(opts.balance ?? {}) }) as any,
  };
  for (const r of opts.invoices ?? [invoiceRow()]) s.invoices.set(String(r['id']), structuredClone(r));
  for (const r of opts.creditNotes ?? []) s.creditNotes.set(String(r['id']), structuredClone(r));
  const calls: Array<{ name: string; tenantId: unknown }> = [];
  const lockHolders = new Map<string, FakeTx>();
  const waiters = new Map<string, Array<() => void>>();
  let txSeq = 0;

  async function lock(tx: FakeTx, key: string): Promise<void> {
    while (lockHolders.has(key) && lockHolders.get(key) !== tx) await new Promise<void>((r) => waiters.set(key, [...(waiters.get(key) ?? []), r]));
    if (lockHolders.get(key) !== tx) { lockHolders.set(key, tx); tx.locks.push(key); }
  }
  const release = (tx: FakeTx) => {
    for (const key of tx.locks) { lockHolders.delete(key); const w = waiters.get(key) ?? []; waiters.delete(key); w.forEach((r) => r()); }
  };
  const rec = (name: string, tx: unknown, a: any) => {
    if (typeof a?.tenantId !== 'string' && typeof a?.tenant_id !== 'string') throw new Error(`fake repo: ${name} called without a tenant id`);
    if ((tx as FakeTx)?.closed) throw new Error(`fake repo: ${name} used after its transaction ended`);
    calls.push({ name, tenantId: a.tenantId ?? a.tenant_id });
  };
  const own = (rows: Map<string, any>, tenantId: string, id: string) => { const r = rows.get(id); return r && r.tenant_id === tenantId ? r : undefined; };

  const repo = {
    async getInvoice(tx: unknown, a: any) { rec('getInvoice', tx, a); const r = own(s.invoices, a.tenantId, a.invoiceId); return r ? structuredClone(r) : undefined; },
    async listInvoiceLines(tx: unknown, a: any) { rec('listInvoiceLines', tx, a); return own(s.invoices, a.tenantId, a.invoiceId) ? [lineRow(1, a.invoiceId)] : []; },
    async getCreditNote(tx: unknown, a: any) { rec('getCreditNote', tx, a); const r = own(s.creditNotes, a.tenantId, a.creditNoteId); return r ? structuredClone(r) : undefined; },
    async listCreditNoteLines(tx: unknown, a: any) { rec('listCreditNoteLines', tx, a); return own(s.creditNotes, a.tenantId, a.creditNoteId) ? [cnLineRow(1, a.creditNoteId)] : []; },
    async getOrderBalance(tx: unknown, a: any) { rec('getOrderBalance', tx, a); return s.balance && s.balance.tenant_id === a.tenantId && s.balance.order_id === a.orderId ? structuredClone(s.balance) : undefined; },
    async markInvoicePrinted(tx: FakeTx, a: any) { return mark('markInvoicePrinted', s.invoices, tx, a, a.invoiceId); },
    async markCreditNotePrinted(tx: FakeTx, a: any) { return mark('markCreditNotePrinted', s.creditNotes, tx, a, a.creditNoteId); },
    async insertPrintLog(tx: FakeTx, row: any) {
      rec('insertPrintLog', tx, row);
      if (s.printLog.some((p) => p.tenant_id === row.tenant_id && p.document_kind === row.document_kind && p.document_id === row.document_id && p.print_no === row.print_no)) {
        throw Object.assign(pgError('23505', 'duplicate key value violates unique constraint "print_log__tenant_id_doc_print__uq"'), { constraint: 'print_log__tenant_id_doc_print__uq' });
      }
      if (row.is_copy !== (row.print_no > 1)) throw Object.assign(pgError('23514', 'violates check constraint "print_log__copy__ck"'), { constraint: 'print_log__copy__ck' });
      if (!['invoice', 'credit_note', 'receipt'].includes(row.document_kind)) throw pgError('23514', 'violates check constraint "print_log__kind__ck"');
      if (row.reason_code != null && !(REASONS as readonly string[]).includes(row.reason_code)) throw pgError('23514', 'violates check constraint "print_log__reason__ck"');
      s.printLog.push(structuredClone(row)); tx.undo.push(() => { s.printLog.pop(); });
      if (failOn.insertPrintLog) throw failOn.insertPrintLog();
    },
    async insertActivity(tx: FakeTx, row: any) {
      rec('insertActivity', tx, row);
      s.activity.push(structuredClone(row)); tx.undo.push(() => { s.activity.pop(); });
    },
  };
  /** the real UPDATE ... SET print_count = print_count + 1 ... RETURNING print_count: takes the row lock, then increments the stored value (never a caller-supplied one). */
  async function mark(name: string, rows: Map<string, any>, tx: FakeTx, a: any, id: string): Promise<number | undefined> {
    rec(name, tx, a);
    const row = own(rows, a.tenantId, id);
    if (!row) return undefined;
    await lock(tx, `${name}:${id}`);
    await tick(); // let racing transactions run their reads: a read-modify-write implementation loses here
    const before = row.print_count; const beforeAt = row.last_printed_at;
    row.print_count = before + 1; row.last_printed_at = BASE; row.updated_by = a.userId;
    tx.undo.push(() => { row.print_count = before; row.last_printed_at = beforeAt; });
    return row.print_count;
  }
  const failOn: { insertPrintLog?: () => Error } = {};

  const tenantSettings = {
    timezone: 'Asia/Kathmandu',
    branding: { legalName: 'Synthetic Lab Pvt Ltd', displayName: 'Synthetic Lab', addressLines: ['Synthetic Road 2', 'Kathmandu'], phones: ['01-5550000'], receiptFooterNote: 'Thank you',
      logoAssetId: IDS.logo, letterheadHeaderAssetId: IDS.headerAsset, letterheadFooterAssetId: IDS.footerAsset, ...(opts.branding ?? {}) },
  };
  const w = {
    s, calls, repo, failOn, tenantSettings,
    assertRoleError: undefined as undefined | (() => Error),
    brandingReadError: undefined as undefined | (() => Error),
    accessError: undefined as undefined | (() => Error),
    names: () => calls.map((c) => c.name),
    writes: () => calls.filter((c) => ['markInvoicePrinted', 'markCreditNotePrinted', 'insertPrintLog', 'insertActivity'].includes(c.name)).map((c) => c.name),
    invoice: (id = IDS.inv) => s.invoices.get(id), creditNote: (id = IDS.cn) => s.creditNotes.get(id),
    logFor: (kind: string, id: string) => s.printLog.filter((p) => p.document_kind === kind && p.document_id === id),
    /** One transaction: undo log + row locks. Rejection undoes every write of this tx (the DB rollback). */
    async inTx<T>(fn: (ctx: any) => Promise<T>, over: Record<string, unknown> = {}): Promise<T> {
      const tx: FakeTx = { id: ++txSeq, undo: [], locks: [], closed: false };
      const ctx = {
        tenantId: TENANT_A, actor: { type: 'user', id: USER, membershipId: MEMBERSHIP }, requestId: REQ_ID, tx, now: () => BASE,
        audit: { access: async (e: unknown) => { if (w.accessError) throw w.accessError(); const c = structuredClone(e); s.access.push(c); tx.undo.push(() => { const i = s.access.indexOf(c); if (i >= 0) s.access.splice(i, 1); }); } },
        ports: { IdentityPort: {
          async assertRole(_c: unknown, req: unknown) { s.assertRoleCalls.push(structuredClone(req)); if (w.assertRoleError) throw w.assertRoleError(); },
          async getTenantSettings(_c: unknown, input: unknown) { s.settingsCalls.push(input); return tenantSettings; },
          async readBrandingAsset(_c: unknown, input: { assetId: string }) {
            s.brandingReads.push(input.assetId); if (w.brandingReadError) throw w.brandingReadError();
            const kind = input.assetId === IDS.logo ? 'logo' : input.assetId === IDS.headerAsset ? 'letterhead_header' : 'letterhead_footer';
            return { assetId: input.assetId, kind, mimeType: 'image/png', sha256: 'a'.repeat(64), base64: 'iVBORw0KGgo=' };
          },
        } },
        ...over,
      };
      try { return await fn(ctx); }
      catch (e) { for (const u of tx.undo.reverse()) u(); throw e; }
      finally { tx.closed = true; release(tx); }
    },
  };
  return w;
}
export type PrintWorld = ReturnType<typeof makePrintWorld>;

/** Awaits a rejection and returns it (throws if the promise resolves). */
export const rejects = async (p: Promise<unknown>): Promise<LimsError & { statusCode?: number; errors?: any[]; code: string }> => {
  try { await p; } catch (e) { return e as never; }
  throw new Error('expected rejection');
};
