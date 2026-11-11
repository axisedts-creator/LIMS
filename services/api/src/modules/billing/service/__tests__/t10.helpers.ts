// BL-T10 test helpers (not a test file). Builds on t06.helpers.ts (real core event publisher, in-memory billing world) and adds credit notes,
// credit note lines, credit_note_tasks, a PER-SERIES fiscal counter (INV and CN are separate gapless series) and DB-rule models:
//   billing.invoices_lifecycle_guard (05-SCHEMA §3): status issued->cancelled only, cancellation columns NULL->value once, credited_total never decreases,
//       cbms_cancel_state NULL->not_required|pending only on the cancelling update, credited_total_paisa BETWEEN 0 AND net_paisa, version bump on write.
//   billing.credit_notes: unique (tenant, invoice) WHERE kind='cancellation'; seq strictly increasing and issued_at non-decreasing (chronology guard); net > 0.
//   billing.credit_note_lines: net > 0, gross-discount = exempt+taxable, net = exempt+taxable+vat+other_tax (credit_note_lines__amounts__ck).
// ASSUMED repo seams (spec fixes behaviour, not signatures; writer: object via a dispute if wrong). All take (tx, args) and carry tenantId from ctx only:
//   invoices.repo       getInvoiceForUpdate(tx,{tenantId,invoiceId})  -> invoice row | undefined          (SELECT … FOR UPDATE; tenant filter)
//                       markInvoiceCancelled(tx,{tenantId,invoiceId,cancelledAt,cancelledBy,reasonCode,reasonText,creditNoteId,creditedTotalPaisa,cbmsCancelState,userId}) -> row
//                       addInvoiceCredit(tx,{tenantId,invoiceId,creditedTotalPaisa,userId}) -> row        (only credited_total_paisa / version / updated_*)
//   invoiceLines.repo   listInvoiceLines(tx,{tenantId,invoiceId})     -> invoice_lines rows ordered by line_no
//   creditNotes.repo    insertCreditNote(tx,row) -> row ; insertCreditNoteLines(tx,rows[]) -> void ; listCreditNoteLinesByInvoice(tx,{tenantId,invoiceId}) -> credit_note_lines rows
//   creditNoteTasks.repo getCreditNoteTask(tx,{tenantId,taskId}) (exists) ; listOpenCreditNoteTasks(tx,{tenantId,invoiceId}) -> open task rows
//                       resolveCreditNoteTasks(tx,{tenantId,taskIds,creditNoteId,userId,resolvedAt}) -> resolved rows (only status='open' rows change)
//   plus everything makeWorld's repo already has (insertActivity, enqueueCbmsSync, getOrderBalance, upsertOrderBalance, readOrderTotals (overridden here: credited = Σ credit notes)).
// ASSUMED service seam: createInvoiceService({repo,counter,events}) -> { issue, cancel, credit }
//   cancel(ctx,{invoiceId,reasonCode,reasonText?})                                  -> { creditNoteId, creditNoteNo }   (B4; also returns whatever the handler needs)
//   credit(ctx,{invoiceId,lines:[{invoiceLineId,amountPaisa?}],reasonCode,reasonText?,resolvesTaskIds?}) -> { creditNoteId, creditNoteNo }   (B5)
//   events: createBillingEvents(...).invoiceCancelled(ctx,payload) key `<invoice_id>:cancelled`, aggregate {invoice, invoice_id, seq = invoice.version after the cancel}.
// Synthetic data only.
import { pgError } from '../../../../core/events/__tests__/helpers.js';
import { BASE, IDS, makeWorld, TENANT_A, USER, type WorldOpts } from './t06.helpers.js';

export { BASE, IDS, TENANT_A, USER };
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
export const CN_PATTERN = 'CN-{fy}-{seq:6}';
/** Credit-note numbering for BASE (BS FY 2083/84, short 083/84). */
export const cnNo = (n: number) => `CN-083/84-${String(n).padStart(6, '0')}`;
export const INVOICE_MUTABLE = new Set(['status', 'is_active', 'cancelled_at', 'cancelled_by', 'cancel_reason_code', 'cancel_reason_text', 'credit_note_id',
  'credited_total_paisa', 'print_count', 'last_printed_at', 'cbms_state', 'cbms_attempts', 'cbms_last_attempt_at', 'cbms_synced_at', 'cbms_external_ref',
  'cbms_cancel_state', 'cbms_cancel_attempts', 'cbms_cancel_last_attempt_at', 'cbms_cancel_synced_at', 'cbms_cancel_external_ref', 'updated_at', 'updated_by', 'version']);
export const COMPONENTS = ['gross_paisa', 'discount_paisa', 'exempt_paisa', 'taxable_paisa', 'vat_paisa', 'other_tax_paisa', 'net_paisa'] as const;
export const TASK_IDS = { t1: V7('000000900001'), t2: V7('000000900002'), t3: V7('000000900003'), tB: V7('000000900009') };

interface X { creditNotes: any[]; cnLines: any[]; tasks: any[]; counters: Record<string, number> }

export function makeT10World(opts: WorldOpts = {}) {
  const w = makeWorld({
    ...opts,
    tenantSettings: { numbering: { invoiceNoPattern: '{fy}-{seq:6}', creditNoteNoPattern: CN_PATTERN }, ...(opts.tenantSettings ?? {}) },
  });
  Object.assign(w.s, { creditNotes: [], cnLines: [], tasks: [], counters: {} } satisfies X); // part of the state, so a rolled-back tx restores them
  const x = (): X => w.s as unknown as X;
  const calls = w.repoCalls;
  const rec = (name: string, a: any) => {
    if (typeof a?.tenantId !== 'string' && typeof a?.tenant_id !== 'string') throw new Error(`fake repo: ${name} called without a tenant id`);
    calls.push({ name, args: a });
  };
  const own = <T extends { tenant_id: string }>(rows: T[], tenantId: string) => rows.filter((r) => r.tenant_id === tenantId);

  // keep makeWorld's insertInvoice, but give the row its DB defaults (version, credited_total_paisa, cbms_cancel_*)
  const baseInsert = w.repo.insertInvoice;
  w.repo.insertInvoice = async (tx: unknown, row: any) => {
    const out = await baseInsert(tx, row);
    const stored = w.s.invoices[w.s.invoices.length - 1];
    Object.assign(stored, { version: 1, credited_total_paisa: 0, cancelled_at: null, cancelled_by: null, cancel_reason_code: null, cancel_reason_text: null, credit_note_id: null,
      cbms_cancel_state: null, ...stored });
    return out;
  };
  const baseTotals = w.repo.readOrderTotals;
  w.repo.readOrderTotals = async (tx: unknown, a: any) => {
    const t = await baseTotals(tx, a);
    const credited = own(x().creditNotes, a.tenantId).filter((c) => c.order_id === a.orderId).reduce((s, c) => s + Number(c.net_paisa), 0);
    if (!t) return credited > 0 ? { invoiced_paisa: '0', paid_paisa: '0', credited_paisa: String(credited), issued_invoice_count: 0, centre_id: IDS.centre, billing_mode: 'cash' } : t;
    return { ...t, credited_paisa: String(credited) };
  };

  const find = (tenantId: string, invoiceId: string) => w.s.invoices.find((i) => i.tenant_id === tenantId && i.id === invoiceId);
  Object.assign(w.repo, {
    async getInvoiceForUpdate(_tx: unknown, a: any) { rec('getInvoiceForUpdate', a); const i = find(a.tenantId, a.invoiceId); return i ? structuredClone(i) : undefined; },
    async listInvoiceLines(_tx: unknown, a: any) {
      rec('listInvoiceLines', a);
      return structuredClone(own(w.s.lines, a.tenantId).filter((l) => l.invoice_id === a.invoiceId).sort((p, q) => p.line_no - q.line_no));
    },
    async listCreditNoteLinesByInvoice(_tx: unknown, a: any) {
      rec('listCreditNoteLinesByInvoice', a);
      const noteIds = new Set(own(x().creditNotes, a.tenantId).filter((c) => c.invoice_id === a.invoiceId).map((c) => c.id));
      return structuredClone(own(x().cnLines, a.tenantId).filter((l) => noteIds.has(l.credit_note_id)));
    },
    async insertCreditNote(_tx: unknown, row: any) {
      rec('insertCreditNote', row);
      const mine = own(x().creditNotes, row.tenant_id);
      if (row.kind === 'cancellation' && mine.some((c) => c.invoice_id === row.invoice_id && c.kind === 'cancellation')) {
        throw Object.assign(pgError('23505', 'duplicate key value violates unique constraint "credit_notes__tenant_id_invoice_cancellation__p_uq"'), { constraint: 'credit_notes__tenant_id_invoice_cancellation__p_uq' });
      }
      if (row.series !== 'CN' || !(Number(row.net_paisa) > 0)) throw pgError('23514', 'credit_notes check violation');
      if (mine.some((c) => c.fiscal_year_bs === row.fiscal_year_bs && (c.credit_note_seq >= row.credit_note_seq || c.issued_at > row.issued_at))) {
        throw Object.assign(pgError('P0001', 'chronology_violation'), { detail: 'billing.credit_notes' });
      }
      const stored = { version: 1, is_active: true, print_count: 0, ...structuredClone(row) };
      x().creditNotes.push(stored); return structuredClone(stored);
    },
    async insertCreditNoteLines(_tx: unknown, rows: any[]) {
      rec('insertCreditNoteLines', { tenantId: rows[0]?.tenant_id ?? 'x' });
      for (const r of rows) {
        const ok = Number(r.net_paisa) > 0 && Number(r.gross_paisa) - Number(r.discount_paisa) === Number(r.exempt_paisa) + Number(r.taxable_paisa)
          && Number(r.net_paisa) === Number(r.exempt_paisa) + Number(r.taxable_paisa) + Number(r.vat_paisa) + Number(r.other_tax_paisa);
        if (!ok) throw pgError('23514', 'credit_note_lines__amounts__ck');
      }
      x().cnLines.push(...structuredClone(rows));
    },
    async markInvoiceCancelled(_tx: unknown, a: any) {
      rec('markInvoiceCancelled', a);
      const i = find(a.tenantId, a.invoiceId);
      if (!i) return undefined;
      const bad = () => Object.assign(pgError('P0001', 'immutable_row'), { detail: 'billing.invoices' });
      if (i.status !== 'issued') throw bad();
      if (!['not_required', 'pending'].includes(a.cbmsCancelState)) throw bad();
      if (!(Number(a.creditedTotalPaisa) >= Number(i.credited_total_paisa) && Number(a.creditedTotalPaisa) <= Number(i.net_paisa))) throw pgError('23514', 'invoices__credited__ck');
      Object.assign(i, { status: 'cancelled', is_active: false, cancelled_at: a.cancelledAt, cancelled_by: a.cancelledBy, cancel_reason_code: a.reasonCode, cancel_reason_text: a.reasonText ?? null,
        credit_note_id: a.creditNoteId, credited_total_paisa: Number(a.creditedTotalPaisa), cbms_cancel_state: a.cbmsCancelState, updated_by: a.userId, version: Number(i.version) + 1 });
      return structuredClone(i);
    },
    async addInvoiceCredit(_tx: unknown, a: any) {
      rec('addInvoiceCredit', a);
      const i = find(a.tenantId, a.invoiceId);
      if (!i) return undefined;
      if (i.status !== 'issued' || Number(a.creditedTotalPaisa) < Number(i.credited_total_paisa)) throw Object.assign(pgError('P0001', 'immutable_row'), { detail: 'billing.invoices' });
      if (Number(a.creditedTotalPaisa) > Number(i.net_paisa)) throw pgError('23514', 'invoices__credited__ck');
      Object.assign(i, { credited_total_paisa: Number(a.creditedTotalPaisa), updated_by: a.userId, version: Number(i.version) + 1 });
      return structuredClone(i);
    },
    async getCreditNoteTask(_tx: unknown, a: any) { rec('getCreditNoteTask', a); const t = own(x().tasks, a.tenantId).find((r) => r.id === a.taskId); return t ? structuredClone(t) : undefined; },
    async listOpenCreditNoteTasks(_tx: unknown, a: any) {
      rec('listOpenCreditNoteTasks', a);
      return structuredClone(own(x().tasks, a.tenantId).filter((t) => t.invoice_id === a.invoiceId && t.status === 'open'));
    },
    async resolveCreditNoteTasks(_tx: unknown, a: any) {
      rec('resolveCreditNoteTasks', a);
      const out: any[] = [];
      for (const t of own(x().tasks, a.tenantId)) {
        if (a.taskIds.includes(t.id) && t.status === 'open') {
          Object.assign(t, { status: 'resolved', resolved_by_credit_note_id: a.creditNoteId, resolved_by: a.userId, resolved_at: a.resolvedAt, updated_by: a.userId, version: Number(t.version) + 1 });
          out.push(structuredClone(t));
        }
      }
      return out;
    },
  });

  // ONE gapless counter per series (INV, CN, RC) inside the transactional state: a rollback gives the number back.
  const cnCalls: any[] = [];
  const counter = {
    failCn: undefined as undefined | (() => Error),
    async allocate(_tx: unknown, input: any) {
      cnCalls.push({ ...input, atRepoCall: calls.length });
      if (input.series === 'CN' && counter.failCn) throw counter.failCn();
      w.clockMs += 1000;
      x().counters[input.series] = (x().counters[input.series] ?? 0) + 1;
      return { lastNo: x().counters[input.series]!, allocatedAt: new Date(w.clockMs).toISOString() };
    },
  };
  return Object.assign(w, { counter, allCounterCalls: cnCalls, x, own, cnCalls: () => cnCalls.filter((c) => c.series === 'CN') });
}
export type T10World = ReturnType<typeof makeT10World>;

/** An open credit_note_required task row (05-SCHEMA credit_note_tasks). */
export function seedTask(w: T10World, over: Record<string, unknown> & { invoice_id: string; invoice_line_ids: string[] }) {
  const row = {
    id: TASK_IDS.t1, tenant_id: TENANT_A, centre_id: IDS.centre, order_id: IDS.order, cause: 'item_removed', reason_code: 'patient_request', status: 'open',
    resolved_by_credit_note_id: null, resolved_at: null, resolved_by: null, version: 1, is_active: true, created_by: USER, updated_by: USER, ...over,
  };
  w.x().tasks.push(row);
  return row;
}
