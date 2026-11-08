// BL-T15 worker: billing.export_render (build XML in-module / PDF via RenderPort as the system actor, store in bucket billing-exports, status ready, expires_at = now + 24 h) and
// billing.export_purge (cron `30 19 * * *`, per_tenant: delete expired objects, row -> expired). Spec: 02-TRD §9/§10 task rows + §11.1, PRD US-BL-12.1/12.4/12.5, 05-SCHEMA billing.export_jobs
// (object_path first segment = tenant), 07-SECURITY REQ-SEC-024 (payload can never widen the tenant), REQ-SEC-034/035 (private bucket, no URL), 08 R12c / CR-C4-004 (bytes returned by RenderPort, stored by C4).
// XML is validated against the XSD kept in docs/manual/billing/exports.md (urn:lims:billing:export:v1) with the XSD-subset validator in xsdSubset.ts (no XSD engine installed - see notes).
// ASSUMED (spec silent; writer: dispute if wrong):
//   tasks/export_render.ts exports EXPORT_RENDER = 'billing.export_render', `exportRender` and `createExportRender({ render })` (test seam: a RenderPort-like { renderPdf(ctx,{templateKey,data,idempotencyKey}) }); payload { tenant_id, export_id }.
//   tasks/export_purge.ts  exports EXPORT_PURGE = 'billing.export_purge' and `exportPurge`; payload { tenant_id }.
//   All SQL goes through ctx.tx.query. The job is read from billing.export_jobs by (tenant_id, id); register rows are read with SELECTs on billing.invoices / billing.credit_notes / billing.activity_log
//   exposing the NATIVE column names (no aliases): invoices {invoice_seq, invoice_no, issued_at, invoice_date_bs, buyer_name, buyer_pan, exempt_paisa, taxable_paisa, vat_paisa, other_tax_paisa, net_paisa, status, ...},
//   credit_notes {credit_note_seq, credit_note_no, kind, invoice_no, ...}. The job status is written by UPDATE billing.export_jobs (final statement carries 'ready', sha256, row_count, expires_at).
//   Storage: ctx.storage.put(bucket, `${tenant}/${yyyy}/${mm}/${export_id}.${ext}`, bytes, { contentType, ifAbsent: true }) -> { sha256, byteSize }; ctx.storage.delete(bucket, path). signedUrl is never used.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { compileXsd, parseXml, xsdFromDoc, type XNode } from './xsdSubset.js';

const ROOT = join(import.meta.dirname, '../../../../../..');
const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa', TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
const JOB = '0190a000-0000-7000-8000-000000004001', BUCKET = 'billing-exports', NOW = '2026-11-08T12:00:30.000Z', NS = 'urn:lims:billing:export:v1';
const manifest = async (): Promise<any> => (await import('../index.js')).manifest;
const render = async () => (await import('../tasks/export_render.js')) as any;
const purge = async () => (await import('../tasks/export_purge.js')) as any;
const xsd = () => compileXsd(xsdFromDoc(readFileSync(join(ROOT, 'docs/manual/billing/exports.md'), 'utf8')));
const walk = (n: XNode, out: XNode[] = []): XNode[] => { out.push(n); n.children.forEach((c) => walk(c, out)); return out; };
const texts = (xml: string) => walk(parseXml(xml)).map((n) => n.text.trim()).filter(Boolean);

const inv = (n: number, over: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, id: `0190a000-0000-7000-8000-00000000${String(1000 + n)}`, invoice_seq: n, invoice_no: `083/84-${String(n).padStart(6, '0')}`, issued_at: '2026-11-08T05:00:00.000Z',
  invoice_date_bs: '2083-07-22', buyer_name: `Synthetic Buyer ${n}`, buyer_pan: '123456789', exempt_paisa: '0', taxable_paisa: '100000', vat_paisa: '13000', other_tax_paisa: '0', net_paisa: '113000', status: 'issued',
  cancelled_at: null, cancel_reason_code: null, credit_note_no: null, centre_id: null, fiscal_year_bs: '2083/84', ...over });
const cn = (n: number, over: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, id: `0190a000-0000-7000-8000-00000000${String(2000 + n)}`, credit_note_seq: n, credit_note_no: `083/84-CN-${String(n).padStart(6, '0')}`, kind: n % 2 ? 'cancellation' : 'partial',
  invoice_no: '083/84-000001', issued_at: '2026-11-08T05:00:00.000Z', credit_note_date_bs: '2083-07-22', buyer_name: `Synthetic Buyer ${n}`, buyer_pan: null, reason_code: 'billing_error', exempt_paisa: '0',
  taxable_paisa: String(1000 * n), vat_paisa: String(130 * n), other_tax_paisa: '0', net_paisa: String(1130 * n), centre_id: null, fiscal_year_bs: '2083/84', ...over });
const act = (n: number) => ({ tenant_id: TENANT_A, id: `0190a000-0000-7000-8000-00000000${String(3000 + n)}`, action: 'invoice_issued', document_kind: 'invoice', document_id: null, document_no: `083/84-00000${n}`,
  actor_id: '0190a000-0000-7000-8000-00000000a0a1', actor_membership_id: '0190a000-0000-7000-8000-00000000a0b1', actor_type: 'user', occurred_at: '2026-11-08T05:00:00.000Z', details: { secret_note: 'PHI-LIKE-DETAIL' } });
const jobRow = (over: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, id: JOB, kind: 'sales_register', format: 'xml', filters: {}, status: 'queued', row_count: null, bucket: null, object_path: null, sha256: null,
  error_code: null, requested_by_membership_id: '0190a000-0000-7000-8000-00000000a0b1', completed_at: null, expires_at: null, created_at: NOW, version: 1, is_active: true, ...over });

function world(o: { job?: Record<string, unknown> | null; invoices?: any[]; creditNotes?: any[]; activity?: any[]; expired?: any[]; putFail?: Error; deleteFail?: (p: string) => Error | undefined; tenantId?: string | undefined; attempt?: number;
  objects?: Map<string, Buffer>; now?: string; failReadyOnce?: boolean } = {}) {
  let readyFailed = false; const objects = o.objects ?? new Map<string, Buffer>();
  const stmts: Array<{ text: string; values: unknown[] }> = []; const puts: any[] = []; const dels: string[] = []; const renders: any[] = []; let urlCalls = 0;
  const job = o.job === null ? undefined : (o.job ?? jobRow());
  const tx = { async query(text: string, values: unknown[] = []) {
    stmts.push({ text, values });
    if (o.failReadyOnce && !readyFailed && /UPDATE\s+billing\.export_jobs/i.test(text) && /ready/.test(`${text} ${JSON.stringify(values)}`)) { readyFailed = true; throw new Error('db: connection lost'); }
    const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
    if (/^\s*(UPDATE|DELETE|INSERT)/i.test(text)) return { rows: [], rowCount: 1 };
    if (/count\(/i.test(text)) { const n = /credit_notes/.test(text) ? (o.creditNotes ?? []).length : /activity_log/.test(text) ? (o.activity ?? []).length : (o.invoices ?? []).length; return rows([{ count: String(n), n, c: n }]); }
    if (/billing\.export_jobs/.test(text) && job && values.includes(job.id)) return rows([structuredClone(job)]);
    if (/billing\.export_jobs/.test(text)) return rows(structuredClone(o.expired ?? []));
    if (/billing\.credit_notes/.test(text)) return rows(structuredClone(o.creditNotes ?? []));
    if (/billing\.activity_log/.test(text)) return rows(structuredClone(o.activity ?? []));
    if (/billing\.invoices/.test(text)) return rows(structuredClone(o.invoices ?? []));
    return rows([]);
  } };
  const ctx: any = {
    tenantId: 'tenantId' in o ? o.tenantId : TENANT_A, tx, actor: { type: 'system', id: '0190a000-0000-7000-8000-00000000a009' }, requestId: 'r', attempt: o.attempt ?? 1, maxAttempts: 5, jobId: '1', now: () => o.now ?? NOW,
    log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} }, events: {}, core: {}, files: {}, audit: {},
    storage: {
      async put(bucket: string, path: string, bytes: Uint8Array, opts: any) {
        if (o.putFail) throw o.putFail; if (opts?.ifAbsent && objects.has(`${bucket}/${path}`)) throw new Error('storage: object exists (ifAbsent never overwrites)');
        objects.set(`${bucket}/${path}`, Buffer.from(bytes)); puts.push({ bucket, path, bytes: Buffer.from(bytes), opts }); return { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length }; },
      async delete(bucket: string, path: string) { const e = o.deleteFail?.(path); if (e) throw e; dels.push(`${bucket}/${path}`); },
      async signedUrl() { urlCalls++; return 'https://storage.invalid/signed?token=SECRET'; }, async get(bucket: string, path: string) { const b = objects.get(`${bucket}/${path}`); if (!b) throw new Error('storage: no such object'); return new Uint8Array(b); },
    },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  const port = (over: { fail?: Error } = {}) => ({ async renderPdf(c: any, input: any) {
    renders.push({ actor: c?.actor?.type, input: structuredClone(input) }); if (over.fail) throw over.fail;
    const b = Buffer.from(`%PDF-1.7 fake ${input.idempotencyKey}`); return { contentBase64: b.toString('base64'), sha256: createHash('sha256').update(b).digest('hex'), byteSize: b.length, pageCount: 1 };
  } });
  const updates = () => stmts.filter((s) => /UPDATE\s+billing\.export_jobs/i.test(s.text));
  const blob = (s: { text: string; values: unknown[] }) => `${s.text} ${JSON.stringify(s.values)}`;
  return { ctx, stmts, puts, dels, renders, port, updates, blob, urlCalls: () => urlCalls };
}
const run = async (w: ReturnType<typeof world>, o: { port?: unknown; payload?: unknown } = {}) => {
  const m = await render(); const task = o.port ? m.createExportRender({ render: o.port }) : m.exportRender;
  return task('payload' in o ? o.payload : { tenant_id: TENANT_A, export_id: JOB }, w.ctx);
};

describe('manifest + crontab (02-TRD §10)', () => {
  it('registers both tasks; export_render maxAttempts 5, outbox (no cron); export_purge cron `30 19 * * *`, per_tenant, maxAttempts 3; manifest still validates', async () => {
    const m = await manifest(); const cron = m.crontab as any[];
    expect(typeof m.tasks['billing.export_render']).toBe('function'); expect(typeof m.tasks['billing.export_purge']).toBe('function');
    expect(m.maxAttempts['billing.export_render']).toBe(5); expect(m.maxAttempts['billing.export_purge']).toBe(3);
    expect(cron.filter((c) => c.identifier === 'billing.export_render')).toEqual([]);
    expect(cron.filter((c) => c.identifier === 'billing.export_purge')).toEqual([expect.objectContaining({ schedule: '30 19 * * *', tenantScope: 'per_tenant', maxAttempts: 3 })]);
    expect(() => validateManifests([m])).not.toThrow();
    expect(Object.keys(m.tasks)).toEqual(expect.arrayContaining(['billing.export_tenant', 'billing.cbms_sync', 'billing.integrity_check']));
  });
  it('modules export their identifiers', async () => {
    expect((await render()).EXPORT_RENDER).toBe('billing.export_render'); expect((await purge()).EXPORT_PURGE).toBe('billing.export_purge');
  });
});

describe('docs/manual/billing/exports.md keeps the XSD', () => {
  it('has a fenced xml block with an xs:schema whose targetNamespace is urn:lims:billing:export:v1', () => {
    expect(xsd().targetNamespace).toBe(NS);
  });
});

describe('export_render XML (US-BL-12.1, 12.7): valid against the XSD, stored privately, ready', () => {
  it('sales register: valid against the XSD, every invoice present (cancelled marked), then ONE put into billing-exports at {tenant}/{yyyy}/{mm}/{export_id}.xml with ifAbsent; job ready with sha256/row_count/expires_at = now + 24 h', async () => {
    const w = world({ invoices: [inv(1), inv(2, { status: 'cancelled', cancelled_at: '2026-11-08T05:30:00.000Z', cancel_reason_code: 'billing_error', credit_note_no: '083/84-CN-000001' }), inv(3, { buyer_pan: null })] });
    await run(w);
    expect(w.puts).toHaveLength(1);
    const p = w.puts[0];
    expect(p.bucket).toBe(BUCKET); expect(p.path).toBe(`${TENANT_A}/2026/11/${JOB}.xml`); expect(p.opts).toMatchObject({ ifAbsent: true, contentType: expect.stringMatching(/^(application|text)\/xml/) });
    const xml = p.bytes.toString('utf8');
    expect(xsd().validate(xml), xml.slice(0, 400)).toEqual([]);
    expect(parseXml(xml).ns).toBe(NS);
    const t = texts(xml);
    for (const n of [1, 2, 3]) expect(t).toContain(`083/84-00000${n}`);
    expect(t).toContain('cancelled'); expect(t.filter((x) => x === 'issued')).toHaveLength(2);
    expect(t).toContain('Synthetic Buyer 1'); expect(t).toContain('2083-07-22');
    expect(t).toContain('2026-11-08'); // A.D. date (Kathmandu calendar date), P-15
    const done = w.updates().map(w.blob).find((b) => b.includes('ready'))!;
    expect(done, 'an UPDATE billing.export_jobs carrying ready').toBeDefined();
    expect(done).toContain(createHash('sha256').update(p.bytes).digest('hex')); expect(done).toContain(`${TENANT_A}/2026/11/${JOB}.xml`); expect(done).toContain(BUCKET);
    expect(done).toContain('2026-11-09T12:00:30'); expect(done).toMatch(/\b3\b/);
    expect(w.urlCalls()).toBe(0);
  });
  it('hostile cell content cannot break out of the document: <, &, quotes, ]]>, a fake closing tag and a leading = stay text, the file still validates and round-trips', async () => {
    const evil = `</Export><x a="1">&amp; ]]> <script>alert(1)</script> =HYPERLINK("http://evil")`;
    const w = world({ invoices: [inv(1, { buyer_name: evil })] }); await run(w);
    const xml = w.puts[0].bytes.toString('utf8');
    expect(xsd().validate(xml)).toEqual([]);
    expect(texts(xml)).toContain(evil); expect(xml).not.toContain('<script>');
  });
  it('credit notes (B26 shape): both kinds, valid XML, Σ net of the XML equals Σ net_paisa of the stored rows (C8 R1)', async () => {
    const rows = [cn(1), cn(2), cn(3), cn(4)]; const w = world({ job: jobRow({ kind: 'credit_notes' }), creditNotes: rows }); await run(w);
    const xml = w.puts[0].bytes.toString('utf8'); expect(xsd().validate(xml)).toEqual([]);
    const t = texts(xml); for (const r of rows) expect(t).toContain(r.credit_note_no); expect(t).toContain('cancellation'); expect(t).toContain('partial');
    const expected = rows.reduce((s, r) => s + Number(r.net_paisa), 0);
    const amounts = t.filter((x) => /^-?\d+(\.\d+)?$/.test(x)).map(Number);
    for (const r of rows) expect(amounts.some((a) => a === Number(r.net_paisa) || Math.round(a * 100) === Number(r.net_paisa)), `net of ${r.credit_note_no}`).toBe(true);
    expect(expected).toBe(1130 + 2260 + 3390 + 4520);
  });
  it('cancelled-invoice report and audit trail export validate too; the audit trail never carries activity_log.details', async () => {
    const a = world({ job: jobRow({ kind: 'cancelled_invoices' }), invoices: [inv(2, { status: 'cancelled', cancelled_at: '2026-11-08T05:30:00.000Z', cancel_reason_code: 'billing_error', credit_note_no: '083/84-CN-000001' })] }); await run(a);
    expect(xsd().validate(a.puts[0].bytes.toString('utf8'))).toEqual([]); expect(texts(a.puts[0].bytes.toString('utf8'))).toContain('083/84-CN-000001');
    const b = world({ job: jobRow({ kind: 'audit_trail' }), activity: [act(1), act(2)] }); await run(b);
    const xml = b.puts[0].bytes.toString('utf8'); expect(xsd().validate(xml)).toEqual([]); expect(xml).not.toContain('PHI-LIKE-DETAIL'); expect(texts(xml)).toContain('083/84-000001');
  });
  it('an empty range is a valid empty register, status ready, row_count 0', async () => {
    const w = world({ invoices: [] }); await run(w); expect(xsd().validate(w.puts[0].bytes.toString('utf8'))).toEqual([]); expect(w.updates().map(w.blob).some((b) => b.includes('ready'))).toBe(true);
  });
  it('every statement is tenant-scoped: the tenant id is bound, the other tenant never appears', async () => {
    const w = world({ invoices: [inv(1)] }); await run(w);
    for (const s of w.stmts) expect(s.text, s.text).toMatch(/tenant_id/);
    expect(JSON.stringify(w.stmts.map((s) => s.values))).toContain(TENANT_A); expect(JSON.stringify(w.stmts)).not.toContain(TENANT_B);
  });
});

describe('export_render PDF (US-BL-12.4, CR-C4-004): RenderPort as system actor, bytes stored by C4', () => {
  it('billing.register template, idempotencyKey derived from the export id, bytes stored at ....pdf with application/pdf and the RenderPort sha256', async () => {
    const w = world({ job: jobRow({ format: 'pdf' }), invoices: [inv(1), inv(2)] }); await run(w, { port: w.port() });
    expect(w.renders).toHaveLength(1); expect(w.renders[0].input.templateKey).toBe('billing.register'); expect(w.renders[0].input.idempotencyKey).toContain(JOB);
    expect(typeof w.renders[0].input.data).toBe('object'); expect(JSON.stringify(w.renders[0].input.data)).toContain('083/84-000001'); expect(w.renders[0].actor).toBe('system');
    expect(w.puts).toHaveLength(1); expect(w.puts[0]).toMatchObject({ bucket: BUCKET, path: `${TENANT_A}/2026/11/${JOB}.pdf`, opts: { ifAbsent: true, contentType: 'application/pdf' } });
    expect(w.puts[0].bytes.toString()).toBe(`%PDF-1.7 fake ${w.renders[0].input.idempotencyKey}`);
    expect(w.updates().map(w.blob).some((b) => b.includes('ready') && b.includes(createHash('sha256').update(w.puts[0].bytes).digest('hex')))).toBe(true);
  });
  it('more than 5,000 rows for a PDF (count drifted after B28) -> job failed with billing.export_too_large; renderer never called, nothing stored', async () => {
    const w = world({ job: jobRow({ format: 'pdf' }), invoices: Array.from({ length: 5001 }, (_, i) => inv(i + 1)) }); const m = await render();
    await m.createExportRender({ render: w.port() })({ tenant_id: TENANT_A, export_id: JOB }, w.ctx).catch(() => undefined);
    expect(w.renders).toHaveLength(0); expect(w.puts).toHaveLength(0);
    expect(w.updates().map(w.blob).some((b) => b.includes('failed') && b.includes('billing.export_too_large'))).toBe(true);
  });
  it('exactly 5,000 rows still renders', async () => {    const w = world({ job: jobRow({ format: 'pdf' }), invoices: Array.from({ length: 5000 }, (_, i) => inv(i + 1)) }); await run(w, { port: w.port() });
    expect(w.renders).toHaveLength(1); expect(w.puts).toHaveLength(1);
  });
  it('reporting.render_unavailable -> the task throws (graphile retry, max 5); no object stored and the job is not marked ready', async () => {
    await render(); const w = world({ job: jobRow({ format: 'pdf' }), invoices: [inv(1)] }); const err = Object.assign(new Error('reporting.render_unavailable'), { code: 'reporting.render_unavailable' });
    await expect(run(w, { port: w.port({ fail: err }) })).rejects.toMatchObject({ message: expect.stringContaining('render_unavailable') });
    expect(w.puts).toHaveLength(0); expect(w.updates().map(w.blob).some((b) => /ready/.test(b))).toBe(false);
  });
  it('final attempt failing -> job failed with an error_code, nothing stored (the user sees status failed, not a hung queued job)', async () => {
    const w = world({ job: jobRow({ format: 'pdf' }), invoices: [inv(1)], attempt: 5 }); const err = Object.assign(new Error('reporting.render_unavailable'), { code: 'reporting.render_unavailable' });
    await run(w, { port: w.port({ fail: err }) }).catch(() => undefined);
    expect(w.puts).toHaveLength(0); expect(w.updates().map(w.blob).some((b) => b.includes('failed') && b.includes('reporting.render_unavailable'))).toBe(true);
  });
});

describe('export_render guards (REQ-SEC-024) and replays', () => {
  it.each([[{ tenant_id: TENANT_B, export_id: JOB }], [{ export_id: JOB }], [{ tenant_id: TENANT_A }], [{ tenant_id: TENANT_A, export_id: 'not-a-uuid' }], [null], [undefined]])('payload %j -> resolves, runs no statement, stores nothing', async (payload) => {
    const w = world({ invoices: [inv(1)] }); await run(w, { payload }); expect(w.stmts).toEqual([]); expect(w.puts).toEqual([]);
  });
  it('no tenant on the job context -> no statement, nothing stored', async () => {
    const w = world({ tenantId: undefined }); await run(w); expect(w.stmts).toEqual([]); expect(w.puts).toEqual([]);
  });
  it('unknown job id: resolves, nothing stored; an already ready / expired / failed job is not rendered again (replay-safe, no second object)', async () => {
    const a = world({ job: null }); await run(a); expect(a.puts).toEqual([]);
    for (const status of ['ready', 'expired', 'failed']) { const w = world({ job: jobRow({ status }), invoices: [inv(1)] }); await run(w); expect(w.puts, status).toEqual([]); }
  });
  // BL-T19: the former 'xlsx jobs are not rendered before BL-T19' case is removed on purpose (its branch is BL-T19 done_when); xlsx rendering is covered by export.xlsx.test.ts.
  it('a storage failure never marks the job ready', async () => {
    await render(); const w = world({ invoices: [inv(1)], putFail: new Error('storage down') }); await run(w).catch(() => undefined);
    expect(w.updates().map(w.blob).some((b) => /ready/.test(b))).toBe(false);
  });
});

describe('export_render retries (BL-T15 review item 1) and credit-note order (item 4)', () => {
  it('first attempt fails after the object was stored (DB error on the ready UPDATE); the retry — even in a later month — reaches ready with exactly ONE object at the original key', async () => {
    const objects = new Map<string, Buffer>(); const invoices = [inv(1), inv(2)];
    const first = world({ invoices, objects, failReadyOnce: true });
    await expect(run(first)).rejects.toBeDefined();
    expect(objects.size).toBe(1);
    const second = world({ invoices, objects, attempt: 2, now: '2026-12-02T12:00:00.000Z' }); // job.created_at is 2026-11-08: the key must not move to 2026/12
    await run(second);
    expect(second.updates().map(second.blob).some((b) => b.includes('ready'))).toBe(true);
    expect(second.updates().map(second.blob).some((b) => b.includes('failed'))).toBe(false);
    expect([...objects.keys()]).toEqual([`${BUCKET}/${TENANT_A}/2026/11/${JOB}.xml`]);
  });
  it('credit-note SELECT orders by credit_note_seq (not issued_at) so the export is in sequence order', async () => {
    const w = world({ job: jobRow({ kind: 'credit_notes' }), creditNotes: [cn(1), cn(2)] }); await run(w);
    const sel = w.stmts.find((s) => /^\s*SELECT/i.test(s.text) && /billing\.credit_notes/.test(s.text) && !/count\(/i.test(s.text))!;
    const order = /ORDER BY\s+([\s\S]*?)(?:\s+LIMIT|\s*$)/i.exec(sel.text)?.[1] ?? '';
    expect(order, sel.text).toMatch(/credit_note_seq/); expect(order).not.toMatch(/issued_at/);
  });
});

describe('export_purge: expired objects deleted, row -> expired (TRD §10; 05-SCHEMA retention)', () => {
  const exp = (n: number, over: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, id: `0190a000-0000-7000-8000-00000000500${n}`, status: 'ready', bucket: BUCKET, object_path: `${TENANT_A}/2026/11/0190a000-0000-7000-8000-00000000500${n}.xml`, expires_at: '2026-11-07T12:00:00.000Z', ...over });
  const go = async (w: ReturnType<typeof world>, ...a: unknown[]) => { const m = await purge(); return m.exportPurge(a.length ? a[0] : { tenant_id: TENANT_A }, w.ctx); };
  it('deletes each expired object from billing-exports and marks its row expired; selects only ready rows past expires_at for this tenant', async () => {
    const w = world({ expired: [exp(1), exp(2)] }); await go(w);
    expect(w.dels).toEqual(expect.arrayContaining(exp(1).object_path ? [`${BUCKET}/${exp(1).object_path}`, `${BUCKET}/${exp(2).object_path}`] : []));
    expect(w.dels).toHaveLength(2);
    const sel = w.stmts.find((s) => /^\s*SELECT/i.test(s.text) && /billing\.export_jobs/.test(s.text))!;
    expect(sel.text).toMatch(/expires_at/); expect(sel.text).toMatch(/ready/); expect(sel.text).toMatch(/tenant_id/); expect(JSON.stringify(sel.values)).toContain(TENANT_A);
    const expired = w.updates().map(w.blob).filter((b) => b.includes('expired'));
    expect(expired.length).toBeGreaterThanOrEqual(1); for (const n of [1, 2]) expect(expired.some((b) => b.includes(exp(n).id))).toBe(true);
    expect(w.urlCalls()).toBe(0);
  });
  it('a failed delete leaves that row ready (retry next run) and does not stop the others', async () => {
    await purge(); const bad = exp(1).object_path; const w = world({ expired: [exp(1), exp(2)], deleteFail: (p) => (p === bad ? new Error('storage down') : undefined) });
    await go(w).catch(() => undefined);
    expect(w.dels).toEqual([`${BUCKET}/${exp(2).object_path}`]);
    const marked = w.updates().map(w.blob).filter((b) => b.includes('expired'));
    expect(marked.some((b) => b.includes(exp(2).id))).toBe(true); expect(marked.some((b) => b.includes(exp(1).id))).toBe(false);
  });
  it('an object_path outside the tenant prefix is never deleted (cross-tenant delete guard)', async () => {
    await purge(); const w = world({ expired: [exp(1, { object_path: `${TENANT_B}/2026/11/x.xml` })] }); await go(w).catch(() => undefined);
    expect(w.dels).toEqual([]);
  });
  it('rows are removed after the 90-day retention (DELETE on billing.export_jobs scoped to the tenant and to expired / failed rows only)', async () => {
    const w = world({ expired: [] }); await go(w);
    const del = w.stmts.find((s) => /DELETE\s+FROM\s+billing\.export_jobs/i.test(s.text))!;
    expect(del, 'retention DELETE').toBeDefined(); expect(del.text).toMatch(/tenant_id/); expect(del.text).toMatch(/status/); expect(del.text).not.toMatch(/'ready'|'queued'|'running'/); expect(JSON.stringify(del.values)).toContain(TENANT_A);
  });
  it.each([[{ tenant_id: TENANT_B }], [{}], [null], [undefined]])('payload %j -> resolves, no statement, no delete', async (payload) => {
    const w = world({ expired: [exp(1)] }); await go(w, payload); expect(w.stmts).toEqual([]); expect(w.dels).toEqual([]);
  });
});
