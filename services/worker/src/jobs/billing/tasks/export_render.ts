// billing.export_render (02-TRD §9/§10; PRD US-BL-12.1, 12.4, 12.5; 07-SECURITY REQ-SEC-024/034/035; 08 R12c, CR-C4-004). Enqueued by B28 in the creating transaction, payload {tenant_id, export_id}.
// Builds the file (XML in-module against urn:lims:billing:export:v1, docs/manual/billing/exports.md; PDF: RenderPort.renderPdf as the billing system actor returns the bytes), stores it with
// ctx.storage.put (ifAbsent) in the private bucket `billing-exports` at {tenant}/{yyyy}/{mm of created_at}/{export_id}.{ext}, then marks the job `ready` (expires_at = now + TTL). No Storage URL is ever created.
// The job context is the tenant's: a payload that names another tenant, or no job, is skipped without a statement. Replays are no-ops (only a `queued` job is rendered).
// Failure contract (as billing.cbms_sync): a retryable failure on a non-final attempt THROWS a sanitised error (queue retry, tx rolled back); on the final attempt, and at once for permanent
// causes (row cap drift, bad stored filter), the job is COMMITTED `failed` with a stable error_code and the task resolves.
// [CONV] generated_at in the file = the job's created_at, so a retry produces identical bytes. [CONV] amounts are integer paisa. [CONV] PDF/XML row cap is checked again here (count may drift after B28).
import { createHash } from 'node:crypto';
import { adToBs, formatBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import writeXlsxFile from 'write-excel-file/node';
import { neutraliseFormula } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const EXPORT_RENDER = 'billing.export_render';
export const EXPORT_BUCKET = 'billing-exports';
const TZ = 'Asia/Kathmandu';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const FY = /^[0-9]{4}\/[0-9]{2}$/;
const PAISA = /^-?[0-9]{1,19}$/;
const CODE = /^[a-z_]+\.[a-z_]+$/;
type Row = Record<string, any>;
type Dto = Record<string, string | number | undefined>;

export interface RenderPort {
  renderPdf(ctx: unknown, input: { templateKey: string; data: Record<string, unknown>; idempotencyKey: string }): Promise<{ contentBase64: string; sha256?: string; byteSize?: number; pageCount?: number }>;
}
/** ponytail: the real RenderPort is CR-C4-004 (not merged); until then a PDF job retries and ends `failed` with reporting.render_unavailable. Wire the port in here when it exists. */
const unavailable: RenderPort = { renderPdf: async () => { throw Object.assign(new Error('reporting.render_unavailable'), { code: 'reporting.render_unavailable' }); } };

/** A cause no retry can fix: the job goes straight to `failed` with `code`. */
class Permanent extends Error { constructor(readonly code: string) { super(code); } }

const int = (key: string, dflt: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`config: ${key} must be a positive integer`);
  return n;
};
const iso = (v: unknown): string => { const d = v instanceof Date ? v : new Date(String(v)); if (Number.isNaN(d.getTime())) throw new Error('bad timestamp'); return d.toISOString(); };
function localDate(v: unknown): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso(v))).map((x) => [x.type, x.value]));
  return `${p['year']}-${p['month']}-${p['day']}`;
}
const bsOf = (ad: string): string => formatBs(adToBs(ad as IsoDate));
const money = (v: unknown): string => { const s = String(v); if (!PAISA.test(s)) throw new Error('bad amount'); return s; };
const text = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
/** 'YYYY-MM-DD' of a `date` column (a string, or the local-midnight Date node-postgres builds). */
function dateText(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${String(v.getFullYear()).padStart(4, '0')}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  throw new Error('bad date');
}

// ---- read: one SELECT per kind, native column names, every statement names tenant_id and binds every value ----
interface Query { sql: string; values: unknown[] }
function queryOf(kind: string, tenantId: string, f: Row, limit: number): Query {
  const v: unknown[] = [tenantId];
  const add = (x: unknown) => { v.push(x); return '$' + v.length; };
  let w = 'tenant_id = $1';
  const flt = (name: string, ok: (x: string) => boolean): string | undefined => {
    const x = f[name];
    if (x === undefined) return undefined;
    if (typeof x !== 'string' || !ok(x)) throw new Permanent('common.validation_failed');
    return x;
  };
  const fy = flt('fiscal_year_bs', (x) => FY.test(x)), from = flt('from', (x) => INSTANT.test(x)), to = flt('to', (x) => INSTANT.test(x));
  const centre = flt('centre_id', (x) => UUID.test(x)), actor = flt('actor_membership_id', (x) => UUID.test(x));
  const range = (col: string) => { if (from !== undefined) w += ' AND ' + col + ' >= ' + add(from) + '::timestamptz'; if (to !== undefined) w += ' AND ' + col + ' <= ' + add(to) + '::timestamptz'; };
  const common = () => { if (fy !== undefined) w += ' AND fiscal_year_bs = ' + add(fy); if (centre !== undefined) w += ' AND centre_id = ' + add(centre); };
  let select: string, order: string;
  switch (kind) {
    case 'sales_register':
      common(); range('issued_at');
      select = 'SELECT id, invoice_seq, invoice_no, issued_at, invoice_date_bs, buyer_name, buyer_pan, exempt_paisa, taxable_paisa, vat_paisa, other_tax_paisa, net_paisa, status FROM billing.invoices';
      order = 'issued_at, id'; break;
    case 'cancelled_invoices':
      common(); range('cancelled_at'); w += " AND status = 'cancelled'";
      select = 'SELECT id, invoice_seq, invoice_no, cancelled_at, buyer_name, buyer_pan, net_paisa, cancel_reason_code, credit_note_id FROM billing.invoices';
      order = 'cancelled_at, id'; break;
    case 'credit_notes':
      common(); range('issued_at');
      select = 'SELECT id, credit_note_seq, credit_note_no, issued_at, credit_note_date_bs, kind, invoice_no, buyer_name, buyer_pan, reason_code, exempt_paisa, taxable_paisa, vat_paisa, other_tax_paisa, net_paisa FROM billing.credit_notes';
      order = 'fiscal_year_bs, credit_note_seq, id'; break;   // 02-TRD §5.2: ordered by credit_note_seq
    case 'audit_trail':
      range('occurred_at'); if (actor !== undefined) w += ' AND actor_membership_id = ' + add(actor);
      select = 'SELECT id, action, document_kind, document_id, document_no, actor_membership_id, occurred_at FROM billing.activity_log';   // `details` is never read
      order = 'occurred_at DESC, id DESC'; break;
    case 'daily_cash':
      if (centre !== undefined) w += ' AND centre_id = ' + add(centre); range('created_at'); w += " AND entry_kind IN ('payment', 'reversal', 'refund')";
      select = 'SELECT id, business_date, method_code, entry_kind, amount_paisa FROM billing.ledger_entries';
      order = 'created_at, id'; break;
    default: throw new Permanent('common.validation_failed');
  }
  return { sql: select + ' WHERE ' + w + ' ORDER BY ' + order + ' LIMIT ' + add(limit), values: v };
}

// ---- row -> flat DTO (same fields as the B24-B27 register rows) ----
const ROW_NAME: Record<string, string> = { sales_register: 'SalesRow', cancelled_invoices: 'CancelledRow', credit_notes: 'CreditNoteRow', audit_trail: 'ActivityRow', daily_cash: 'CashRow' };
/** [xml element, dto key] in schema order; absent values are left out. */
const FIELDS: Record<string, Array<[string, string]>> = {
  SalesRow: [['Sn', 'sn'], ['InvoiceDateBs', 'invoice_date_bs'], ['InvoiceDateAd', 'invoice_date_ad'], ['InvoiceNo', 'invoice_no'], ['BuyerName', 'buyer_name'], ['BuyerPan', 'buyer_pan'],
    ['Total', 'total'], ['Exempt', 'exempt'], ['Taxable', 'taxable'], ['Vat', 'vat'], ['OtherTax', 'other_tax'], ['Status', 'status']],
  CancelledRow: [['Sn', 'sn'], ['CancelledDateBs', 'cancelled_date_bs'], ['CancelledDateAd', 'cancelled_date_ad'], ['InvoiceNo', 'invoice_no'], ['CreditNoteNo', 'credit_note_no'],
    ['BuyerName', 'buyer_name'], ['BuyerPan', 'buyer_pan'], ['Total', 'total'], ['ReasonCode', 'reason_code']],
  CreditNoteRow: [['Sn', 'sn'], ['CreditNoteDateBs', 'credit_note_date_bs'], ['CreditNoteDateAd', 'credit_note_date_ad'], ['CreditNoteNo', 'credit_note_no'], ['Kind', 'kind'], ['InvoiceNo', 'invoice_no'],
    ['BuyerName', 'buyer_name'], ['BuyerPan', 'buyer_pan'], ['ReasonCode', 'reason_code'], ['Exempt', 'exempt'], ['Taxable', 'taxable'], ['Vat', 'vat'], ['OtherTax', 'other_tax'], ['Net', 'net']],
  ActivityRow: [['OccurredAt', 'occurred_at'], ['Action', 'action'], ['EntityType', 'entity_type'], ['EntityId', 'entity_id'], ['DocumentNo', 'document_no'], ['ActorMembershipId', 'actor_membership_id']],
  CashRow: [['BusinessDate', 'business_date'], ['MethodCode', 'method_code'], ['EntryKind', 'entry_kind'], ['Amount', 'amount']],
};
function dtoOf(kind: string, r: Row, sn: number, creditNoteNo: (r: Row) => string | undefined): Dto {
  switch (kind) {
    case 'sales_register':
      return { sn, invoice_date_bs: r['invoice_date_bs'], invoice_date_ad: localDate(r['issued_at']), invoice_no: r['invoice_no'], buyer_name: r['buyer_name'], buyer_pan: text(r['buyer_pan']), total: money(r['net_paisa']),
        exempt: money(r['exempt_paisa']), taxable: money(r['taxable_paisa']), vat: money(r['vat_paisa']), other_tax: money(r['other_tax_paisa']), status: r['status'] };
    case 'cancelled_invoices': {
      const ad = localDate(r['cancelled_at']);
      return { sn, cancelled_date_bs: bsOf(ad), cancelled_date_ad: ad, invoice_no: r['invoice_no'], credit_note_no: creditNoteNo(r), buyer_name: r['buyer_name'], buyer_pan: text(r['buyer_pan']), total: money(r['net_paisa']), reason_code: r['cancel_reason_code'] };
    }
    case 'credit_notes':
      return { sn, credit_note_date_bs: r['credit_note_date_bs'], credit_note_date_ad: localDate(r['issued_at']), credit_note_no: r['credit_note_no'], kind: r['kind'], invoice_no: r['invoice_no'], buyer_name: r['buyer_name'],
        buyer_pan: text(r['buyer_pan']), reason_code: r['reason_code'], exempt: money(r['exempt_paisa']), taxable: money(r['taxable_paisa']), vat: money(r['vat_paisa']), other_tax: money(r['other_tax_paisa']), net: money(r['net_paisa']) };
    case 'audit_trail':
      return { occurred_at: iso(r['occurred_at']), action: r['action'], entity_type: text(r['document_kind']) ?? 'billing', entity_id: text(r['document_id']), document_no: text(r['document_no']), actor_membership_id: text(r['actor_membership_id']) };
    default:
      return { business_date: dateText(r['business_date']), method_code: r['method_code'], entry_kind: r['entry_kind'], amount: money(r['amount_paisa']) };
  }
}

// ---- XML ----
// XML 1.0 Char production: everything else (control characters, lone surrogates) is dropped, then the five specials are escaped.
const isXmlChar = (c: number) => c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);
const esc = (s: string) => Array.from(s).filter((ch) => isXmlChar(ch.codePointAt(0)!)).join('').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
export function buildXml(kind: string, rows: Dto[], generatedAt: string): string {
  const name = ROW_NAME[kind]!;
  const body = rows.map((r) => '  <' + name + '>' + FIELDS[name]!.filter(([, k]) => r[k] !== undefined).map(([el, k]) => '<' + el + '>' + esc(String(r[k])) + '</' + el + '>').join('') + '</' + name + '>\n').join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Export xmlns="urn:lims:billing:export:v1" kind="' + kind + '" generated_at="' + generatedAt + '" row_count="' + rows.length + '">\n' + body + '</Export>\n';
}

// ---- XLSX (BL-T19; US-BL-12.1/12.6; write-excel-file 4.1.1): one sheet, row 1 = header (the XML element names), then one row per DTO in the same order and column set as the XML row ----
// Every text cell (header included) = XML-illegal chars dropped -> neutraliseFormula (the shared guard, A13 P-9) -> capped at the 32,767-char cell limit. SN and money are number cells (integer paisa); absent = empty cell.
const NUMERIC = new Set(['sn', 'total', 'exempt', 'taxable', 'vat', 'other_tax', 'net', 'amount']);
const CELL_MAX = 32767;
const textCell = (s: string) => ({ value: Array.from(neutraliseFormula(Array.from(s).filter((ch) => isXmlChar(ch.codePointAt(0)!)).join(''))).slice(0, CELL_MAX).join('') });
function numCell(v: string | number) { const n = Number(v); if (!Number.isSafeInteger(n)) throw new Permanent('common.validation_failed'); return { value: n }; }
export async function buildXlsx(kind: string, rows: Dto[]): Promise<Uint8Array> {
  const cols = FIELDS[ROW_NAME[kind]!]!;
  const sheet = [cols.map(([el]) => textCell(el)), ...rows.map((r) => cols.map(([, k]) => {
    const v = r[k];
    return v === undefined ? null : NUMERIC.has(k) ? numCell(v) : textCell(String(v));
  }))];
  return new Uint8Array(await writeXlsxFile(sheet as never).toBuffer());
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export function createExportRender(deps: { render?: RenderPort } = {}): TaskHandler {
  const port = deps.render ?? unavailable;
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const tenantId = ctx.tenantId;
    const exportId = payload?.['export_id'];
    if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId || typeof exportId !== 'string' || !UUID.test(exportId)) {
      ctx.log?.warn?.({ event: 'export_render_skipped', reason: 'bad_payload' });
      return;
    }
    const q = async (sql: string, values: unknown[]): Promise<Row[]> => (await ctx.tx.query(sql, values)).rows;
    const actor: string = ctx.actor.id;

    // the lock makes a duplicate job wait, then see the final status and stop: a file is never written twice
    const job = (await q('SELECT id, kind, format, filters, status, created_at FROM billing.export_jobs WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, exportId]))[0];
    if (!job) { ctx.log?.warn?.({ event: 'export_render_skipped', reason: 'unknown_job' }); return; }
    if (job['status'] !== 'queued') { ctx.log?.info?.({ event: 'export_render_noop', export_id: exportId, status: job['status'] }); return; }

    const fail = (code: string) => q("UPDATE billing.export_jobs SET status = 'failed', error_code = $3, version = version + 1, updated_by = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'running')",
      [tenantId, exportId, code, actor]);
    try {
      const kind: string = job['kind'], format: string = job['format'];
      if (format !== 'xml' && format !== 'pdf' && format !== 'xlsx') throw new Permanent('common.validation_failed');
      // 02-TRD §11: invoice_documents = template billing.invoice over InvoicePrint.document + branding; not built yet -> fail closed (.orchestra/cr/BL-T15.md)
      if (kind === 'invoice_documents') throw new Permanent('common.feature_disabled');
      const filters = typeof job['filters'] === 'string' ? JSON.parse(job['filters']) : (job['filters'] ?? {});
      const cap = format === 'pdf' ? int('LIMS_BILLING_EXPORT_PDF_MAX_ROWS', 5000) : int('LIMS_BILLING_EXPORT_MAX_ROWS', 100000);
      const query = queryOf(kind, tenantId, filters, cap + 1);
      const raw = await q(query.sql, query.values);
      if (raw.length > cap) throw new Permanent('billing.export_too_large');

      // credit_note_no of cancelled invoices: one more tenant-scoped read by id (the invoice row holds only the id)
      let noteNo = new Map<string, string>();
      if (kind === 'cancelled_invoices') {
        const ids = [...new Set(raw.filter((r) => r['credit_note_no'] == null && typeof r['credit_note_id'] === 'string').map((r) => r['credit_note_id'] as string))];
        if (ids.length) noteNo = new Map((await q('SELECT id, credit_note_no FROM billing.credit_notes WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, ids])).map((r) => [String(r['id']), String(r['credit_note_no'])]));
      }
      const dtos = raw.map((r, i) => dtoOf(kind, r, i + 1, (x) => text(x['credit_note_no']) ?? noteNo.get(String(x['credit_note_id']))));

      let bytes: Uint8Array, contentType: string;
      if (format === 'xml') {
        bytes = new TextEncoder().encode(buildXml(kind, dtos, iso(job['created_at'])));
        contentType = 'application/xml';
      } else if (format === 'xlsx') {
        bytes = await buildXlsx(kind, dtos);
        contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      } else {
        const out = await port.renderPdf(ctx, { templateKey: 'billing.register', idempotencyKey: `billing-export:${exportId}`, data: { kind, generated_at: iso(job['created_at']), row_count: dtos.length, rows: dtos } });
        bytes = new Uint8Array(Buffer.from(out.contentBase64, 'base64'));
        if (out.sha256 !== undefined && out.sha256 !== sha256(bytes)) throw new Error('reporting.render_unavailable');   // corrupt transfer: retry
        contentType = 'application/pdf';
      }

      // key from created_at (not now): a retry after a stored object hits the same key
      const c = new Date(iso(job['created_at']));
      const path = `${tenantId}/${c.getUTCFullYear()}/${String(c.getUTCMonth() + 1).padStart(2, '0')}/${exportId}.${format}`;
      try {
        await ctx.storage.put(EXPORT_BUCKET, path, bytes, { contentType, ifAbsent: true });
      } catch (putErr) {
        // ifAbsent refused: an earlier attempt stored the object and then failed. XML is byte-identical by design; a PDF of the same idempotencyKey is the earlier file; an xlsx zip is not byte-stable, so the stored one wins.
        const readBack = (ctx.storage.read ?? ctx.storage.get).bind(ctx.storage);   // StorageAdapter.read (core/storage); `get` = the test fake's shape
        const prev: Uint8Array | undefined = await readBack(EXPORT_BUCKET, path).catch(() => undefined);
        if (!prev) throw putErr;
        if (format === 'xml' && sha256(prev) !== sha256(bytes)) throw putErr;
        bytes = prev;
      }
      const now: string = ctx.now();
      const d = new Date(now);
      const expires = new Date(d.getTime() + int('LIMS_BILLING_EXPORT_TTL_HOURS', 24) * 3_600_000).toISOString();
      await q("UPDATE billing.export_jobs SET status = 'ready', bucket = $3, object_path = $4, sha256 = $5, row_count = $6, completed_at = $7::timestamptz, expires_at = $8::timestamptz, error_code = NULL, " +
        "version = version + 1, updated_by = $9, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'queued'", [tenantId, exportId, EXPORT_BUCKET, path, sha256(bytes), dtos.length, now, expires, actor]);
      ctx.log?.info?.({ event: 'export_render_done', export_id: exportId, kind, format, rows: dtos.length });
    } catch (e) {
      const code = e instanceof Permanent ? e.code : CODE.test(String((e as Row)?.code ?? '')) ? String((e as Row)['code']) : 'billing.export_render_failed';
      ctx.log?.warn?.({ event: 'export_render_failed', export_id: exportId, code, attempt: ctx.attempt });
      if (e instanceof Permanent || ctx.attempt >= ctx.maxAttempts) { await fail(code); return; }   // committed `failed`; the user sees a status, not a hung job
      throw new Error(code);                                                                       // sanitised: a message can carry names
    }
  };
}

export const exportRender: TaskHandler = createExportRender();
