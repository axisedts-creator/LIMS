// BL-T15 test helpers (not a test file). In-memory billing world for registers (B24-B27) and exports (B28/B29/B29a). Synthetic data only.
// ASSUMED seams (spec fixes behaviour, not signatures; writer: object via a dispute if wrong). Repo fns take (tx, args), carry tenantId from ctx only, rows are snake_case DB columns
// (bigint money arrives as pg strings or numbers; the service returns integers):
//   repo.listSalesRegister(tx,{tenantId,fiscalYearBs?,issuedAtFrom?,issuedAtTo?,centreId?,afterKey?,limit})   -> invoices rows ordered by invoice_seq (cancelled INCLUDED), at most `limit` rows
//        row = { id, invoice_seq, invoice_no, issued_at, invoice_date_bs, buyer_name, buyer_pan, exempt_paisa, taxable_paisa, vat_paisa, other_tax_paisa, net_paisa, status }
//   repo.listCancelledInvoices(tx,{...same filters on cancelled_at})  -> row = { id, invoice_no, cancelled_at, cancelled_date_bs, buyer_name, buyer_pan, net_paisa, cancel_reason_code, credit_note_no }
//   repo.listCreditNoteRegister(tx,{...same filters on credit_notes.issued_at / centre_id}) -> credit_notes rows ordered by credit_note_seq
//        row = { id, credit_note_seq, credit_note_no, issued_at, credit_note_date_bs, kind, invoice_no, buyer_name, buyer_pan, reason_code, exempt_paisa, taxable_paisa, vat_paisa, other_tax_paisa, net_paisa }
//   repo.listAuditTrail(tx,{tenantId,actorMembershipId?,action?,occurredAtFrom?,occurredAtTo?,afterKey?,limit}) -> billing.activity_log rows ordered by occurred_at desc
//   repo.countExportRows(tx,{tenantId,kind,filters:{fiscal_year_bs?,from?,to?,centre_id?,actor_membership_id?}}) -> number
//   repo.insertExportJob(tx,row) -> row (billing.export_jobs columns)      repo.enqueueExportRender(tx,{tenantId,exportId}) -> void (job billing.export_render)
//   repo.getExportJob(tx,{tenantId,jobId}) -> row | undefined (exists: exports.repo.ts)       repo.insertActivity(tx,row) (exists)
// ASSUMED service seams: createRegisterService({ repo }) -> { sales, cancelled, creditNotes, auditTrail }(ctx, q camelCase) -> { data, page:{ limit, next_cursor? } }
//   createExportService({ repo, config:{exportMaxRows,exportPdfMaxRows,exportTtlHours} }) -> { create(ctx, body{kind,format,filters}), get(ctx,{exportId}), content(ctx,{exportId}) }
//   content() -> { fileName, contentType, bytes:Uint8Array } read with ctx.storage.get('billing-exports', object_path); the handler streams it (core download helper).
// ctx = { tenantId, requestId, actor:{type,id,membershipId}, tx, now, audit:{access}, storage:{get,signedUrl}, ports:{IdentityPort:{assertRole}} }.
import { LimsError } from '../../../../core/errors.js';

export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const USER = '0190a000-0000-7000-8000-00000000a0a1';
export const MEMBERSHIP = '0190a000-0000-7000-8000-00000000a0b1';
export const OTHER_MEMBERSHIP = '0190a000-0000-7000-8000-00000000a0b2';
export const CENTRE = '0190a000-0000-7000-8000-00000000c001';
export const NOW = '2026-11-08T06:00:00.000Z';
export const BUCKET = 'billing-exports';
export const SECRET_URL = 'https://storage.example.invalid/signed?token=SECRET-TOKEN-123';
export const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as LimsError; } throw new Error('expected rejection'); };

export const invRow = (n: number, over: Record<string, unknown> = {}) => ({
  tenant_id: TENANT_A, centre_id: CENTRE, id: id(1000 + n), invoice_seq: n, invoice_no: `083/84-${String(n).padStart(6, '0')}`, issued_at: '2026-11-08T05:00:00.000Z', invoice_date_bs: '2083-07-22',
  buyer_name: `Synthetic Buyer ${n}`, buyer_pan: '123456789', exempt_paisa: 0, taxable_paisa: 100000, vat_paisa: 13000, other_tax_paisa: 0, net_paisa: 113000, status: 'issued',
  cancelled_at: null as string | null, cancel_reason_code: null as string | null, credit_note_no: null as string | null, ...over,
});
export const cnRow = (n: number, over: Record<string, unknown> = {}) => ({
  tenant_id: TENANT_A, centre_id: CENTRE as string | null, id: id(2000 + n), credit_note_seq: n, credit_note_no: `083/84-CN-${String(n).padStart(6, '0')}`, issued_at: '2026-11-08T05:00:00.000Z',
  credit_note_date_bs: '2083-07-22', kind: n % 2 ? 'cancellation' : 'partial', invoice_no: '083/84-000001', buyer_name: `Synthetic Buyer ${n}`, buyer_pan: '123456789', reason_code: 'billing_error',
  exempt_paisa: 0, taxable_paisa: 1000 * n, vat_paisa: 130 * n, other_tax_paisa: 0, net_paisa: 1130 * n, ...over,
});
export const actRow = (n: number, over: Record<string, unknown> = {}) => ({
  tenant_id: TENANT_A, id: id(3000 + n), action: 'invoice_issued', document_kind: 'invoice', document_id: id(1000 + n), document_no: `083/84-${String(n).padStart(6, '0')}`, actor_id: USER,
  actor_membership_id: MEMBERSHIP, actor_type: 'user', occurred_at: `2026-11-08T0${n}:00:00.000Z`, request_id: id(9000 + n), details: { secret_note: 'PHI-LIKE-DETAIL' }, centre_id: CENTRE, ...over,
});

export interface ExportRow { tenant_id: string; id: string; kind: string; format: string; filters: any; status: string; row_count: number | null; bucket: string | null; object_path: string | null;
  sha256: string | null; error_code: string | null; requested_by_membership_id: string; completed_at: string | null; expires_at: string | null; created_at: string; [k: string]: unknown }
export const exportRow = (n: number, over: Partial<ExportRow> = {}): ExportRow => ({
  tenant_id: TENANT_A, id: id(4000 + n), kind: 'sales_register', format: 'xml', filters: {}, status: 'ready', row_count: 2, bucket: BUCKET, object_path: `${TENANT_A}/2026/11/${id(4000 + n)}.xml`,
  sha256: 'a'.repeat(64), error_code: null, requested_by_membership_id: MEMBERSHIP, completed_at: NOW, expires_at: '2026-11-09T06:00:00.000Z', created_at: NOW, version: 1, is_active: true, ...over,
});

interface Opts { invoices?: any[]; creditNotes?: any[]; activity?: any[]; exports?: ExportRow[]; counts?: number; objects?: Record<string, Uint8Array>; noAudit?: boolean }

export function makeWorld(o: Opts = {}) {
  const s = { invoices: o.invoices ?? [], creditNotes: o.creditNotes ?? [], activity: o.activity ?? [], exports: [...(o.exports ?? [])], insertedActivity: [] as any[], access: [] as any[], enqueued: [] as any[], undo: [] as Array<() => void> };
  const calls: Array<{ name: string; args: any }> = [];
  const rec = (name: string, a: any) => { if (typeof a?.tenantId !== 'string' && typeof a?.tenant_id !== 'string') throw new Error(`fake repo: ${name} called without a tenant id`); calls.push({ name, args: structuredClone(a) }); };
  const w = { s, calls, count: o.counts ?? 0, accessError: undefined as undefined | (() => Error), roleCalls: [] as any[], getCalls: [] as any[], signedUrlCalls: 0, objects: { ...(o.objects ?? {}) } as Record<string, Uint8Array> };
  const inRange = (iso: string, f?: string, t?: string) => (!f || iso >= f) && (!t || iso <= t);
  const page = (rows: any[], a: any, keyOf: (r: any) => string) => { // keyset over the fake's ordering: afterKey = key of the last row served
    const start = a.afterKey === undefined ? 0 : rows.findIndex((r) => keyOf(r) === a.afterKey) + 1;
    return structuredClone(rows.slice(start, start + a.limit));
  };
  const common = (a: any) => (r: any) => r.tenant_id === a.tenantId && (!a.centreId || r.centre_id === a.centreId) && (!a.fiscalYearBs || !r.fiscal_year_bs || r.fiscal_year_bs === a.fiscalYearBs);
  const repo = {
    async listSalesRegister(_tx: unknown, a: any) { rec('listSalesRegister', a); const rows = s.invoices.filter(common(a)).filter((r) => inRange(r.issued_at, a.issuedAtFrom, a.issuedAtTo)).sort((x, y) => x.invoice_seq - y.invoice_seq); return page(rows, a, (r) => String(r.invoice_seq)); },
    async listCancelledInvoices(_tx: unknown, a: any) { rec('listCancelledInvoices', a); const rows = s.invoices.filter(common(a)).filter((r) => r.cancelled_at && inRange(r.cancelled_at, a.issuedAtFrom, a.issuedAtTo)).sort((x, y) => x.invoice_seq - y.invoice_seq); return page(rows, a, (r) => String(r.invoice_seq)); },
    async listCreditNoteRegister(_tx: unknown, a: any) { rec('listCreditNoteRegister', a); const rows = s.creditNotes.filter(common(a)).filter((r) => inRange(r.issued_at, a.issuedAtFrom, a.issuedAtTo)).sort((x, y) => x.credit_note_seq - y.credit_note_seq); return page(rows, a, (r) => String(r.credit_note_seq)); },
    async listAuditTrail(_tx: unknown, a: any) {
      rec('listAuditTrail', a);
      const rows = s.activity.filter((r) => r.tenant_id === a.tenantId && (!a.actorMembershipId || r.actor_membership_id === a.actorMembershipId) && (!a.action || r.action === a.action) && inRange(r.occurred_at, a.occurredAtFrom, a.occurredAtTo))
        .sort((x, y) => (x.occurred_at < y.occurred_at ? 1 : -1));
      return page(rows, a, (r) => r.id);
    },
    async countExportRows(_tx: unknown, a: any) { rec('countExportRows', a); return w.count; },
    async insertExportJob(_tx: unknown, row: any) { rec('insertExportJob', row); const r = structuredClone(row); s.exports.push(r); s.undo.push(() => { s.exports.pop(); }); return structuredClone(r); },
    async enqueueExportRender(_tx: unknown, a: any) { rec('enqueueExportRender', a); s.enqueued.push(structuredClone(a)); s.undo.push(() => { s.enqueued.pop(); }); },
    async getExportJob(_tx: unknown, a: any) { rec('getExportJob', a); const r = s.exports.find((e) => e.tenant_id === a.tenantId && e.id === a.jobId); return r ? structuredClone(r) : undefined; },
    async insertActivity(_tx: unknown, row: any) { rec('insertActivity', row); s.insertedActivity.push(structuredClone(row)); s.undo.push(() => { s.insertedActivity.pop(); }); },
  };
  const ctxOf = (over: Record<string, unknown> = {}): any => ({
    tenantId: TENANT_A, requestId: id(9999), actor: { type: 'user', id: USER, membershipId: MEMBERSHIP }, tx: { query: async () => { throw new Error('service must go through repo fns'); } }, now: () => NOW,
    audit: o.noAudit ? undefined : { access: async (e: unknown) => { if (w.accessError) throw w.accessError(); const c = structuredClone(e); s.access.push(c); s.undo.push(() => { s.access.pop(); }); } },
    storage: {
      async get(bucket: string, path: string) { w.getCalls.push({ bucket, path }); const b = w.objects[`${bucket}/${path}`]; if (!b) throw new Error('storage: no such object'); return b; },
      async signedUrl() { w.signedUrlCalls++; return SECRET_URL; },
    },
    ports: { IdentityPort: { async assertRole(_c: unknown, req: unknown) { w.roleCalls.push(req); } } }, ...over,
  });
  /** One DB transaction: any throw undoes every write made through the fake (repo + access log). */
  async function inTx<T>(fn: (ctx: any) => Promise<T>, over: Record<string, unknown> = {}): Promise<T> {
    const mark = s.undo.length;
    try { return await fn(ctxOf(over)); } catch (e) { while (s.undo.length > mark) s.undo.pop()!(); throw e; }
  }
  const writes = () => calls.filter((c) => /^(insert|enqueue|update|delete)/.test(c.name)).map((c) => c.name);
  return Object.assign(w, { repo, ctxOf, inTx, writes });
}
export type World = ReturnType<typeof makeWorld>;
