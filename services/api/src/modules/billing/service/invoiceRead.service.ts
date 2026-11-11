// B1 listInvoices, B2 getInvoice, B7 getOrderBilling, B37 listInvoicePrints (02-TRD §5; contracts/openapi/billing.yaml InvoiceSummaryPage / InvoiceDetail /
// OrderBillingDto / InvoicePrintPage). Read-only. Tenant and actor come from ctx only; every user value is validated first and then only ever a bound parameter.
// Money is integer paisa (never a rounded bigint); optional DTO keys are omitted rather than null; buyer PAN/address appear only in B2 (permission billing.invoice.read).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { moneyOf, toPaisa } from '../domain/money/paisa.js';
import * as cbmsRepo from '../repository/cbms.repo.js';
import * as creditNotesRepo from '../repository/creditNotes.repo.js';
import * as creditNoteTasksRepo from '../repository/creditNoteTasks.repo.js';
import * as balancesRepo from '../repository/balances.repo.js';
import * as invoiceLinesRepo from '../repository/invoiceLines.repo.js';
import * as invoicesRepo from '../repository/invoices.repo.js';
import * as overridesRepo from '../repository/overrides.repo.js';
import * as printLogRepo from '../repository/printLog.repo.js';
import { decideRelease, releasePolicyEnforced, type BalanceCtx } from './balance.service.js';

const repo = { ...cbmsRepo, ...creditNotesRepo, ...creditNoteTasksRepo, ...balancesRepo, ...invoiceLinesRepo, ...invoicesRepo, ...overridesRepo, ...printLogRepo };
export type InvoiceReadRepo = typeof repo;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UTC_INSTANT =/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const FY = /^[0-9]{4}\/[0-9]{2}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
/** [CONV] No source for the printer's/canceller's name exists in C4 (print_log and invoices hold only user ids; IdentityPort has no id->name call for these): a fixed label, never the raw id. */
export const STAFF_DISPLAY = 'Staff user';

export const isRec = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const bad = (path: string): LimsError => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
export const iso = (v: unknown): string => {
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new LimsError('common.internal');
  return d.toISOString();
};
export const present = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
export const uuid = (v: unknown, path: string): string => { if (typeof v !== 'string' || !UUID.test(v)) throw bad(path); return v; };

function scope(ctx: BalanceCtx): { tx: never; tenantId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as never, tenantId: ctx.tenantId };
}
export function limitOf(raw: unknown): number {
  if (raw === undefined) return 50;
  const n = typeof raw === 'string' && /^[0-9]{1,3}$/.test(raw) ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 200) throw bad('/limit');
  return n;
}

// ---- opaque keyset cursors: base64url(JSON [sort, value, id]) ----
export const encodeCursor = (sort: string, value: string | number, id: string): string => Buffer.from(JSON.stringify([sort, value, id]), 'utf8').toString('base64url');
export function decodeCursor(raw: unknown, sort: string, kind: 'time' | 'int' | 'int-or-key'): { value: string | number; id: string } {
  const invalidCursor = (): LimsError => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || !CURSOR.test(raw)) throw invalidCursor();
  let v: unknown;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw invalidCursor(); }
  if (!Array.isArray(v) || v.length !== 3 || v[0] !== sort || typeof v[2] !== 'string' || !UUID.test(v[2])) throw invalidCursor();
  const ok = kind === 'int-or-key' ? typeof v[1] === 'string' && v[1].length <= 32
    : kind === 'time' ? typeof v[1] === 'string' && UTC_INSTANT.test(v[1]) : Number.isSafeInteger(v[1]) && (v[1] as number) >= 0 && (v[1] as number) <= 2147483647;
  if (!ok) throw invalidCursor();
  return { value: v[1] as string | number, id: v[2] };
}

// ---- row -> DTO ----
export const totalsOf = (r: Record<string, any>) => ({
  gross: moneyOf(toPaisa(r['gross_paisa'])), discount: moneyOf(toPaisa(r['discount_paisa'])), exempt: moneyOf(toPaisa(r['exempt_paisa'])),
  taxable: moneyOf(toPaisa(r['taxable_paisa'])), vat: moneyOf(toPaisa(r['vat_paisa'])), other_tax: moneyOf(toPaisa(r['other_tax_paisa'])), net: moneyOf(toPaisa(r['net_paisa'])),
});
const summaryOf = (r: Record<string, any>) => present({
  id: r['id'], invoice_no: r['invoice_no'], invoice_seq: r['invoice_seq'], fiscal_year_bs: r['fiscal_year_bs'], invoice_kind: r['invoice_kind'], status: r['status'],
  issued_at: iso(r['issued_at']), invoice_date_bs: r['invoice_date_bs'], centre_id: r['centre_id'], order_id: r['order_id'], credit_party_id: r['credit_party_id'],
  buyer_name: r['buyer_name'], net: moneyOf(toPaisa(r['net_paisa'])), cbms_state: r['cbms_state'],
});
export const lineOf = (r: Record<string, any>, credited: string | undefined) => present({
  id: r['id'], line_no: r['line_no'], line_kind: r['line_kind'], orderable_id: r['orderable_id'], code: r['code'], name: r['name'], department_id: r['department_id'], hs_code: r['hs_code'],
  quantity: r['quantity'], unit_price: moneyOf(toPaisa(r['unit_price_paisa'])), gross: moneyOf(toPaisa(r['gross_paisa'])), discount: moneyOf(toPaisa(r['discount_paisa'])),
  exempt: moneyOf(toPaisa(r['exempt_paisa'])), taxable: moneyOf(toPaisa(r['taxable_paisa'])), vat: moneyOf(toPaisa(r['vat_paisa'])), other_tax: moneyOf(toPaisa(r['other_tax_paisa'])),
  other_tax_code: r['other_tax_code'], net: moneyOf(toPaisa(r['net_paisa'])), credited: moneyOf(toPaisa(credited ?? 0)),
});

export function createInvoiceReadService(deps: { repo?: InvoiceReadRepo } = {}) {
  const db = deps.repo ?? repo;

  async function listInvoices(ctx: BalanceCtx, rawQuery: unknown) {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(rawQuery) ? rawQuery : {};
    const sort = q['sort'] === undefined ? '-issued_at' : q['sort'];
    if (typeof sort !== 'string' || !Object.hasOwn(invoicesRepo.INVOICE_SORTS, sort)) throw bad('/sort');
    const s = sort as invoicesRepo.InvoiceSort;
    const limit = limitOf(q['limit']);
    const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], s, s.endsWith('issued_at') ? 'time' : 'int');
    const str = (k: string, max: number): string | undefined => {
      const v = q[k]; if (v === undefined) return undefined;
      if (typeof v !== 'string' || v === '' || v.length > max) throw bad(`/${k}`);
      return v;
    };
    const instant = (k: string): string | undefined => { const v = str(k, 40); if (v !== undefined && !UTC_INSTANT.test(v)) throw bad(`/${k}`); return v; };
    const id = (k: string): string | undefined => (q[k] === undefined ? undefined : uuid(q[k], `/${k}`));
    const fy = str('fiscal_year_bs', 9);
    if (fy !== undefined && !FY.test(fy)) throw bad('/fiscal_year_bs');
    const status = str('status', 32); const invoiceNo = str('invoice_no', 64);
    const rows = await db.listInvoices(tx, tenantId, {
      ...(status === undefined ? {} : { status }), ...(id('centre_id') === undefined ? {} : { centreId: id('centre_id')! }),
      ...(instant('issued_at_from') === undefined ? {} : { issuedAtFrom: instant('issued_at_from')! }), ...(instant('issued_at_to') === undefined ? {} : { issuedAtTo: instant('issued_at_to')! }),
      ...(fy === undefined ? {} : { fiscalYearBs: fy }), ...(id('order_id') === undefined ? {} : { orderId: id('order_id')! }),
      ...(id('credit_party_id') === undefined ? {} : { creditPartyId: id('credit_party_id')! }), ...(invoiceNo === undefined ? {} : { invoiceNo }),
      sort: s, ...(after === undefined ? {} : { after }), limit: limit + 1,
    });
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    const page: { limit: number; next_cursor?: string } = { limit };
    // ponytail: the cursor carries issued_at at ms precision (node-pg Date); invoices of one series are >= 1 ms apart, so no row is skipped in practice.
    if (rows.length > limit && last) page.next_cursor = encodeCursor(s, s.endsWith('issued_at') ? iso(last['issued_at']) : Number(last['invoice_seq']), String(last['id']));
    return { data: data.map(summaryOf), page };
  }

  async function getInvoice(ctx: BalanceCtx, input: { invoiceId: unknown }) {
    const invoiceId = uuid(input?.invoiceId, '/invoice_id');
    const { tx, tenantId } = scope(ctx);
    const r = await db.getInvoice(tx, { tenantId, invoiceId });
    if (!r) throw new LimsError('common.not_found'); // unknown id and another tenant's id answer the same
    const lines = await db.listInvoiceLines(tx, { tenantId, invoiceId });
    const credited = await db.sumCreditedByLine(tx, { tenantId, invoiceLineIds: lines.map((l) => String(l['id'])) });
    const subs = await db.listInvoiceCbmsSubmissions(tx, { tenantId, invoiceId });
    let cancellation;
    if (r['status'] === 'cancelled' && r['cancelled_at']) {
      const cn = r['credit_note_id'] ? await db.getCreditNote(tx, { tenantId, creditNoteId: String(r['credit_note_id']) }) : undefined;
      cancellation = present({
        cancelled_at: iso(r['cancelled_at']), cancelled_by_display: STAFF_DISPLAY, reason_code: r['cancel_reason_code'], reason_text: r['cancel_reason_text'],
        credit_note_id: r['credit_note_id'], credit_note_no: typeof cn?.['credit_note_no'] === 'string' ? cn['credit_note_no'] : '',
      });
    }
    return present({
      id: r['id'], invoice_no: r['invoice_no'], invoice_seq: r['invoice_seq'], series: r['series'], fiscal_year_bs: r['fiscal_year_bs'], invoice_kind: r['invoice_kind'],
      status: r['status'], is_active: r['is_active'], issued_at: iso(r['issued_at']), invoice_date_bs: r['invoice_date_bs'], branch_id: r['branch_id'], centre_id: r['centre_id'],
      order_id: r['order_id'], credit_party_id: r['credit_party_id'], is_periodic_credit_bill: r['is_periodic_credit_bill'], referrer_id: r['referrer_id'],
      buyer: present({ name: r['buyer_name'], pan: r['buyer_pan'], address: r['buyer_address'] }),
      seller: present({ name: r['seller_name'], pan: r['seller_pan'], address: r['seller_address'] }),
      lines: lines.map((l) => lineOf(l, credited.get(String(l['id'])))), totals: totalsOf(r), credited_total: moneyOf(toPaisa(r['credited_total_paisa'])), cancellation,
      print_count: r['print_count'], last_printed_at: r['last_printed_at'] ? iso(r['last_printed_at']) : undefined, cbms_state: r['cbms_state'],
      cbms_cancel_state: r['cbms_cancel_state'], version: r['version'],
      cbms_submissions: subs.map((s) => ({ document_kind: s['document_kind'], attempt_no: s['attempt_no'], client_mode: s['client_mode'], outcome: s['outcome'], submitted_at: iso(s['submitted_at']) })),
    });
  }

  async function getOrderBilling(ctx: BalanceCtx, input: { orderId: unknown }) {
    const orderId = uuid(input?.orderId, '/order_id');
    const { tx, tenantId } = scope(ctx);
    const bal = await db.getOrderBalance(tx, { tenantId, orderId });
    const invoices = await db.listInvoicesByOrder(tx, { tenantId, orderId });
    if (!bal && invoices.length === 0) throw new LimsError('common.not_found');
    if (!bal) throw new LimsError('common.internal'); // an invoiced order always has its balance row (written in the issuing transaction)
    const invoiced = toPaisa(bal['invoiced_paisa']); const paid = toPaisa(bal['paid_paisa']); const credited = toPaisa(bal['credited_paisa']);
    const due = invoiced - credited - paid;
    const mode = String(bal['billing_mode']);
    const policyEnforced = await releasePolicyEnforced(ctx);
    const override = policyEnforced && mode !== 'credit' ? await db.findActiveOverride(tx, { tenantId, orderId, at: ctx.now() }) : undefined;
    const verdict = decideRelease({ policyEnforced, billingMode: mode, hasActiveOverride: override !== undefined, issuedInvoiceCount: invoices.length, invoicedPaisa: invoiced, paidPaisa: paid, creditedPaisa: credited });
    return {
      balance: { order_id: orderId, invoiced: moneyOf(invoiced), paid: moneyOf(paid), credited: moneyOf(credited), balance_due: moneyOf(due), balance_version: Number(bal['balance_version']), as_of: iso(bal['updated_at']) },
      eligibility: present({ order_id: orderId, eligible: verdict.eligible, basis: verdict.basis, balance_due: moneyOf(due), override_id: verdict.basis === 'override' ? override?.['id'] : undefined, evaluated_at: ctx.now() }),
      invoices: invoices.map(summaryOf),
      // [CONV] the five lists below are filled by the tasks that create their rows (credit notes BL-T08/09, payments BL-T07, credit charges BL-T13, refunds, finance review): none can exist yet.
      credit_notes: [], ledger_entries: [], credit_charges: [], open_credit_note_tasks: [], open_finance_review_items: [], refund_requests: [],
    };
  }

  async function listInvoicePrints(ctx: BalanceCtx, input: { invoiceId: unknown; query: unknown }) {
    const invoiceId = uuid(input?.invoiceId, '/invoice_id');
    const q = isRec(input.query) ? input.query : {};
    const limit = limitOf(q['limit']);
    const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], 'print_no', 'int');
    const { tx, tenantId } = scope(ctx);
    if (!(await db.getInvoice(tx, { tenantId, invoiceId }))) throw new LimsError('common.not_found');
    const rows = await db.pagePrintLog(tx, { tenantId, documentKind: 'invoice', documentId: invoiceId, ...(after === undefined ? {} : { afterPrintNo: after.value as number }), limit: limit + 1 });
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    const page: { limit: number; next_cursor?: string } = { limit };
    if (rows.length > limit && last) page.next_cursor = encodeCursor('print_no', Number(last['print_no']), String(last['id']));
    return {
      data: data.map((p) => present({ print_no: p['print_no'], is_copy: p['is_copy'], reason_code: p['reason_code'], printed_by_display: STAFF_DISPLAY, printed_at: iso(p['printed_at']) })),
      page,
    };
  }

  /** B35: finance work list. status open (default) | resolved; keyset by (created_at, id). Only the CreditNoteTask fields leave. */
  async function listCreditNoteTasks(ctx: BalanceCtx, rawQuery: unknown) {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(rawQuery) ? rawQuery : {};
    const status = q['status'] === undefined ? 'open' : q['status'];
    if (status !== 'open' && status !== 'resolved') throw bad('/status');
    const limit = limitOf(q['limit']);
    const c = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], 'created_at', 'time');
    const rows = await db.listCreditNoteTasks(tx, { tenantId, status, limit: limit + 1, ...(c === undefined ? {} : { after: { createdAt: String(c.value), id: c.id } }) });
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    const page: { limit: number; next_cursor?: string } = { limit };
    // ponytail: the cursor carries created_at at ms precision (node-pg Date); two tasks inside one ms could skip one at a page edge.
    if (rows.length > limit && last) page.next_cursor = encodeCursor('created_at', iso(last['created_at']), String(last['id']));
    return {
      data: data.map((t) => ({ id: t['id'], order_id: t['order_id'], invoice_id: t['invoice_id'], invoice_line_ids: t['invoice_line_ids'], cause: t['cause'], status: t['status'], created_at: iso(t['created_at']) })),
      page,
    };
  }

  /** CreditNoteDto of one note (B4 / B5 responses; B6 get); the note and its lines are read in the caller's transaction. */
  async function getCreditNote(ctx: BalanceCtx, input: { creditNoteId: unknown }) {
    const creditNoteId = uuid(input?.creditNoteId, '/credit_note_id');
    const { tx, tenantId } = scope(ctx);
    const n = await db.getCreditNote(tx, { tenantId, creditNoteId });
    if (!n) throw new LimsError('common.not_found');
    const lines = (await db.listCreditNoteLinesByInvoice(tx, { tenantId, invoiceId: String(n['invoice_id']) })).filter((l) => l['credit_note_id'] === n['id']);
    return creditNoteDto(n, lines);
  }

  /** B6 listCreditNotes (LD-97): CreditNotePage; keyset (fiscal_year_bs, credit_note_seq, id) = the B26 register order (02-TRD §5.2). Cursor = base64url JSON ['credit_notes', "<fy>|<seq>", id]. */
  async function listCreditNotes(ctx: BalanceCtx, rawQuery: unknown) {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(rawQuery) ? rawQuery : {};
    const limit = limitOf(q['limit']);
    const fy = q['fiscal_year_bs'];
    if (fy !== undefined && (typeof fy !== 'string' || !FY.test(fy))) throw bad('/fiscal_year_bs');
    const invoiceId = q['invoice_id'] === undefined ? undefined : uuid(q['invoice_id'], '/invoice_id');
    let after: { fiscalYearBs: string; seq: number; id: string } | undefined;
    if (q['cursor'] !== undefined) {
      const c = decodeCursor(q['cursor'], 'credit_notes', 'int-or-key');
      const m = /^([0-9]{4}\/[0-9]{2})\|([0-9]{1,9})$/.exec(String(c.value));
      if (!m) throw new LimsError('common.invalid_cursor');
      after = { fiscalYearBs: m[1]!, seq: Number(m[2]), id: c.id };
    }
    const rows = await db.listCreditNotes(tx, { tenantId, limit: limit + 1, ...(invoiceId === undefined ? {} : { invoiceId }), ...(fy === undefined ? {} : { fiscalYearBs: fy }), ...(after === undefined ? {} : { after }) });
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    const page: { limit: number; next_cursor?: string } = { limit };
    if (rows.length > limit && last) page.next_cursor = encodeCursor('credit_notes', `${String(last['fiscal_year_bs'])}|${Number(last['credit_note_seq'])}`, String(last['id']));
    const lines = await db.listCreditNoteLinesByNotes(tx, { tenantId, creditNoteIds: data.map((n) => String(n['id'])) });
    return { data: data.map((n) => creditNoteDto(n, lines.filter((l) => l['credit_note_id'] === n['id']))), page };
  }

  function creditNoteDto(n: Record<string, any>, lines: Record<string, any>[]) {
    return present({
      id: n['id'], credit_note_no: n['credit_note_no'], credit_note_seq: n['credit_note_seq'], kind: n['kind'], invoice_id: n['invoice_id'], invoice_no: n['invoice_no'],
      fiscal_year_bs: n['fiscal_year_bs'], issued_at: iso(n['issued_at']), credit_note_date_bs: n['credit_note_date_bs'], centre_id: n['centre_id'], reason_code: n['reason_code'],
      reason_text: n['reason_text'], lines: lines.map((l) => ({ invoice_line_id: l['invoice_line_id'], amount: moneyOf(toPaisa(l['net_paisa'])) })),
      totals: { exempt: moneyOf(toPaisa(n['exempt_paisa'])), taxable: moneyOf(toPaisa(n['taxable_paisa'])), vat: moneyOf(toPaisa(n['vat_paisa'])),
        other_tax: moneyOf(toPaisa(n['other_tax_paisa'])), net: moneyOf(toPaisa(n['net_paisa'])) },
      print_count: n['print_count'], cbms_state: n['cbms_state'], version: n['version'],
    });
  }

  return { listInvoices, getInvoice, getOrderBilling, listInvoicePrints, listCreditNoteTasks, getCreditNote, listCreditNotes };
}
export type InvoiceReadService = ReturnType<typeof createInvoiceReadService>;
