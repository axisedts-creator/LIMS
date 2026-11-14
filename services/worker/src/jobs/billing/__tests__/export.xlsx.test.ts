// BL-T19 worker: billing.export_render for format `xlsx` (US-BL-12.1 columns, US-BL-12.6 formula injection; 07-SECURITY exports row + abuse case A21; 08 A13 P-9, R12e write-excel-file 4.1.1).
// done_when: xlsx outputs pass column tests; formula-injection neutralised on every text cell; the `common.feature_disabled` branch for xlsx is gone (export_render.ts + export.service.ts).
// Same seams as export.render.test.ts (createExportRender / exportRender, ctx.tx.query, ctx.storage.put ifAbsent, job row in billing.export_jobs). Fails now: export_render.ts fails every xlsx job with common.feature_disabled.
// ASSUMED (spec silent; writer: dispute if wrong):
//   - one worksheet holding the register: row 1 = header, then one row per register row (same order as the XML rows). Header labels are NOT pinned (only: non-empty, distinct, one per column).
//   - sales_register column ORDER is the PRD list: SN, B.S. date, A.D. date, invoice no, buyer name, buyer PAN, total, exempt, taxable, VAT, other tax, status (= the XML element order). Other kinds: same field set/order as their XML row.
//   - SN and money columns are NUMBER cells (never text, so a negative refund is not a "-..." text cell). Money is integer paisa (worker [CONV]) OR rupees (paisa/100): either passes; text amounts do not.
//   - absent values (no PAN, no credit note) are empty cells. Text cells hold the value verbatim unless neutraliseFormula changes it (then exactly "'" + value).
//   - a retry after the object was stored must still reach `ready` (so a non-deterministic zip must not make the ifAbsent read-back fail).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { neutraliseFormula, restoreNeutralised } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';

const ROOT = join(import.meta.dirname, '../../../../../..');
const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa', TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
const JOB = '0190a000-0000-7000-8000-000000004001', BUCKET = 'billing-exports', NOW = '2026-11-08T12:00:30.000Z';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const render = async () => (await import('../tasks/export_render.js')) as any;

// ---- independent xlsx inspection (no writer library): unzip via the central directory; text runs; readback through read-excel-file ----
function unzip(buf: Uint8Array): Map<string, string> {
  const b = Buffer.from(buf), out = new Map<string, string>();
  let e = -1; for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('not a zip: no EOCD');
  const n = b.readUInt16LE(e + 10); let p = b.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nlen = b.readUInt16LE(p + 28), elen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), lo = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen), start = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28), body = b.subarray(start, start + csize);
    out.set(name, (method === 8 ? inflateRawSync(body) : body).toString('utf8')); p += 46 + nlen + elen + clen;
  }
  return out;
}
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, g: string) => (g[0] === '#' ? String.fromCodePoint(g[1]!.toLowerCase() === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)) : ENT[g.toLowerCase()]!));
/** every text run (<t>) of every xl/ part (sharedStrings or inline strings), unescaped */
const runs = (parts: Map<string, string>): string[] => [...parts].filter(([k]) => k.startsWith('xl/')).flatMap(([, xml]) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1]!)));
type Cell = string | number | boolean | Date | null;
const sheetsOf = async (bytes: Uint8Array): Promise<Array<{ name: string; rows: Cell[][] }>> => {
  const { default: readXlsxFile } = await import('read-excel-file/node');
  return (await readXlsxFile(Buffer.from(bytes), { trim: false } as never) as any[]).map((s) => ({ name: s.sheet, rows: s.data as Cell[][] }));
};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const inv = (n: number, over: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, id: `0190a000-0000-7000-8000-00000000${String(1000 + n)}`, invoice_seq: n, invoice_no: `083/84-${String(n).padStart(6, '0')}`, issued_at: '2026-11-08T05:00:00.000Z',
  invoice_date_bs: '2083-07-22', buyer_name: `Synthetic Buyer ${n}`, buyer_pan: '123456789', exempt_paisa: '0', taxable_paisa: '100000', vat_paisa: '13000', other_tax_paisa: '0', net_paisa: '113000', status: 'issued',
  cancelled_at: null, cancel_reason_code: null, credit_note_no: null, centre_id: null, fiscal_year_bs: '2083/84', ...over });
const cn = (n: number, over: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, id: `0190a000-0000-7000-8000-00000000${String(2000 + n)}`, credit_note_seq: n, credit_note_no: `083/84-CN-${String(n).padStart(6, '0')}`, kind: n % 2 ? 'cancellation' : 'partial',
  invoice_no: '083/84-000001', issued_at: '2026-11-08T05:00:00.000Z', credit_note_date_bs: '2083-07-22', buyer_name: `Synthetic Buyer ${n}`, buyer_pan: null, reason_code: 'billing_error', exempt_paisa: '0',
  taxable_paisa: String(1000 * n), vat_paisa: String(130 * n), other_tax_paisa: '0', net_paisa: String(1130 * n), centre_id: null, fiscal_year_bs: '2083/84', ...over });
const act = (n: number, over: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, id: `0190a000-0000-7000-8000-00000000${String(3000 + n)}`, action: 'invoice_issued', document_kind: 'invoice', document_id: null, document_no: `083/84-00000${n}`,
  actor_id: '0190a000-0000-7000-8000-00000000a0a1', actor_membership_id: '0190a000-0000-7000-8000-00000000a0b1', actor_type: 'user', occurred_at: '2026-11-08T05:00:00.000Z', details: { secret_note: 'PHI-LIKE-DETAIL' }, ...over });
const cash = (n: number, over: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, id: `0190a000-0000-7000-8000-00000000${String(4000 + n)}`, business_date: '2026-11-08', method_code: 'cash', entry_kind: 'payment', amount_paisa: '50000', created_at: '2026-11-08T05:00:00.000Z', centre_id: null, ...over });
const jobRow = (over: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, id: JOB, kind: 'sales_register', format: 'xlsx', filters: {}, status: 'queued', row_count: null, bucket: null, object_path: null, sha256: null,
  error_code: null, requested_by_membership_id: '0190a000-0000-7000-8000-00000000a0b1', completed_at: null, expires_at: null, created_at: NOW, version: 1, is_active: true, ...over });

function world(o: { job?: Record<string, unknown> | null; invoices?: any[]; creditNotes?: any[]; activity?: any[]; cashRows?: any[]; putFail?: Error; objects?: Map<string, Buffer>; now?: string; failReadyOnce?: boolean; attempt?: number } = {}) {
  let readyFailed = false; const objects = o.objects ?? new Map<string, Buffer>();
  const stmts: Array<{ text: string; values: unknown[] }> = []; const puts: any[] = [];
  const job = o.job === null ? undefined : (o.job ?? jobRow());
  const tx = { async query(text: string, values: unknown[] = []) {
    stmts.push({ text, values });
    if (o.failReadyOnce && !readyFailed && /UPDATE\s+billing\.export_jobs/i.test(text) && /ready/.test(`${text} ${JSON.stringify(values)}`)) { readyFailed = true; throw new Error('db: connection lost'); }
    const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
    if (/^\s*(UPDATE|DELETE|INSERT)/i.test(text)) return { rows: [], rowCount: 1 };
    if (/count\(/i.test(text)) { const n = /credit_notes/.test(text) ? (o.creditNotes ?? []).length : /activity_log/.test(text) ? (o.activity ?? []).length : /ledger_entries/.test(text) ? (o.cashRows ?? []).length : (o.invoices ?? []).length; return rows([{ count: String(n), n, c: n }]); }
    if (/billing\.export_jobs/.test(text) && job && values.includes(job.id)) return rows([structuredClone(job)]);
    if (/billing\.credit_notes/.test(text)) return rows(structuredClone(o.creditNotes ?? []));
    if (/billing\.activity_log/.test(text)) return rows(structuredClone(o.activity ?? []));
    if (/billing\.ledger_entries/.test(text)) return rows(structuredClone(o.cashRows ?? []));
    if (/billing\.invoices/.test(text)) return rows(structuredClone(o.invoices ?? []));
    return rows([]);
  } };
  const ctx: any = {
    tenantId: TENANT_A, tx, actor: { type: 'system', id: '0190a000-0000-7000-8000-00000000a009' }, requestId: 'r', attempt: o.attempt ?? 1, maxAttempts: 5, jobId: '1', now: () => o.now ?? NOW,
    log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} }, events: {}, core: {}, files: {}, audit: {},
    storage: {
      async put(bucket: string, path: string, bytes: Uint8Array, opts: any) {
        if (o.putFail) throw o.putFail; if (opts?.ifAbsent && objects.has(`${bucket}/${path}`)) throw new Error('storage: object exists (ifAbsent never overwrites)');
        objects.set(`${bucket}/${path}`, Buffer.from(bytes)); puts.push({ bucket, path, bytes: Buffer.from(bytes), opts }); return { sha256: sha(bytes), byteSize: bytes.length }; },
      async delete() {}, async signedUrl() { return 'https://storage.invalid/signed?token=SECRET'; },
      async get(bucket: string, path: string) { const b = objects.get(`${bucket}/${path}`); if (!b) throw new Error('storage: no such object'); return new Uint8Array(b); },
    },
  };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  const updates = () => stmts.filter((s) => /UPDATE\s+billing\.export_jobs/i.test(s.text));
  const blob = (s: { text: string; values: unknown[] }) => `${s.text} ${JSON.stringify(s.values)}`;
  return { ctx, stmts, puts, updates, blob, ready: () => updates().map(blob).find((b) => b.includes('ready')), failed: () => updates().map(blob).find((b) => b.includes('failed')) };
}
const run = async (w: ReturnType<typeof world>) => (await render()).exportRender({ tenant_id: TENANT_A, export_id: JOB }, w.ctx);
/** render one xlsx job and return the stored file + parsed first sheet */
async function xlsxOf(o: Parameters<typeof world>[0]) {
  const w = world(o); await run(w);
  expect(w.puts, 'exactly one stored object (job failed? ' + (w.failed() ?? 'no') + ')').toHaveLength(1);
  const bytes: Buffer = w.puts[0].bytes; const parts = unzip(bytes); const sheets = await sheetsOf(bytes);
  return { w, bytes, parts, sheets, rows: sheets[0]!.rows, body: sheets[0]!.rows.slice(1) };
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** a money/SN cell: a number cell equal to paisa or to rupees */
const money = (cell: unknown, paisa: number) => isNum(cell) && (cell === paisa || Math.round(cell * 100) === paisa);

describe('xlsx job is rendered, not disabled (done_when: feature_disabled branch removed)', () => {
  it('sales register: ONE put into billing-exports at {tenant}/{yyyy}/{mm}/{export_id}.xlsx with ifAbsent + spreadsheetml content type; job ready with sha256/row_count/expires_at = now + 24 h; never feature_disabled', async () => {
    const { w, bytes } = await xlsxOf({ invoices: [inv(1), inv(2), inv(3)] });
    const p = w.puts[0];
    expect(p.bucket).toBe(BUCKET); expect(p.path).toBe(`${TENANT_A}/2026/11/${JOB}.xlsx`); expect(p.opts).toMatchObject({ ifAbsent: true, contentType: XLSX_TYPE });
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const done = w.ready()!; expect(done, 'an UPDATE billing.export_jobs carrying ready').toBeDefined();
    expect(done).toContain(sha(bytes)); expect(done).toContain(`${TENANT_A}/2026/11/${JOB}.xlsx`); expect(done).toContain(BUCKET); expect(done).toContain('2026-11-09T12:00:30'); expect(done).toMatch(/\b3\b/);
    expect(w.updates().map(w.blob).some((b) => b.includes('feature_disabled'))).toBe(false); expect(w.failed()).toBeUndefined();
  });
  it('an empty range is a valid workbook with the header row only, status ready, row_count 0', async () => {
    const { w, rows } = await xlsxOf({ invoices: [] });
    expect(rows).toHaveLength(1); expect(rows[0]!.length).toBe(12); expect(w.ready()).toBeDefined();
  });
  it('the package is a real xlsx: [Content_Types].xml, xl/workbook.xml, one worksheet, no macros / external links / formulas', async () => {
    const { parts } = await xlsxOf({ invoices: [inv(1)] });
    expect([...parts.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml']));
    expect([...parts.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).length).toBeGreaterThanOrEqual(1);
    for (const k of parts.keys()) { expect(k, k).not.toMatch(/vbaProject|externalLinks|\.bin$/i); }
    for (const [k, xml] of parts) if (k.startsWith('xl/')) { expect(xml, k).not.toMatch(/<f[\s>/]/); expect(xml, k).not.toMatch(/t="e"/); expect(xml, k).not.toMatch(/<hyperlink[\s>/]|TargetMode="External"/); }
  });
  it('a storage failure never marks the job ready; a bad stored filter fails the job permanently (committed failed, no object)', async () => {
    const a = world({ invoices: [inv(1)], putFail: new Error('storage down') }); await run(a).catch(() => undefined); expect(a.ready()).toBeUndefined();
    const b = world({ job: jobRow({ filters: { fiscal_year_bs: 'nope' } }), invoices: [inv(1)] }); await run(b).catch(() => undefined);
    expect(b.puts).toEqual([]); expect(b.failed()).toContain('common.validation_failed'); expect(b.ready()).toBeUndefined();
  });
});

describe('US-BL-12.1 columns (sales register)', () => {
  it('header + one row per invoice in PRD column order: SN, B.S. date, A.D. date, invoice no, buyer name, buyer PAN, total, exempt, taxable, VAT, other tax, status', async () => {
    const { rows, body } = await xlsxOf({ invoices: [inv(1), inv(2, { buyer_pan: null, exempt_paisa: '5000', taxable_paisa: '200000', vat_paisa: '26000', other_tax_paisa: '1000', net_paisa: '232000' })] });
    const header = rows[0]!;
    expect(header).toHaveLength(12); expect(header.every((h) => typeof h === 'string' && h.trim() !== '')).toBe(true); expect(new Set(header.map((h) => String(h).toLowerCase())).size).toBe(12);
    expect(body).toHaveLength(2);
    const [r1, r2] = body as Cell[][];
    expect(r1!.length).toBe(12);
    expect(r1![0]).toBe(1); expect(r1![1]).toBe('2083-07-22'); expect(String(r1![2])).toContain('2026-11-08'); expect(r1![3]).toBe('083/84-000001'); expect(r1![4]).toBe('Synthetic Buyer 1'); expect(String(r1![5])).toBe('123456789');
    expect(money(r1![6], 113000), 'total').toBe(true); expect(money(r1![7], 0), 'exempt').toBe(true); expect(money(r1![8], 100000), 'taxable').toBe(true); expect(money(r1![9], 13000), 'vat').toBe(true); expect(money(r1![10], 0), 'other tax').toBe(true);
    expect(r1![11]).toBe('issued');
    expect(r2![0]).toBe(2); expect(r2![3]).toBe('083/84-000002'); expect(r2![5] ?? null).toBeNull();
    expect(money(r2![6], 232000)).toBe(true); expect(money(r2![7], 5000)).toBe(true); expect(money(r2![8], 200000)).toBe(true); expect(money(r2![9], 26000)).toBe(true); expect(money(r2![10], 1000)).toBe(true);
  });
  it('SN and money are number cells, not text (a numeric string would be neutralised / not summable)', async () => {
    const { rows, body } = await xlsxOf({ invoices: [inv(1), inv(2)] });
    for (const r of body as Cell[][]) for (const i of [0, 6, 7, 8, 9, 10]) expect(isNum(r[i]), `col ${i} of ${JSON.stringify(r)}`).toBe(true);
    expect(rows.length).toBe(3);
  });
  it('cancelled invoices are present and marked (status cell = cancelled), issued ones are not', async () => {
    const { body } = await xlsxOf({ invoices: [inv(1), inv(2, { status: 'cancelled', cancelled_at: '2026-11-08T05:30:00.000Z', cancel_reason_code: 'billing_error' }), inv(3)] });
    expect((body as Cell[][]).map((r) => r[11])).toEqual(['issued', 'cancelled', 'issued']); expect((body as Cell[][]).map((r) => r[3])).toEqual(['083/84-000001', '083/84-000002', '083/84-000003']);
  });
  it('Σ total of the sheet equals Σ net_paisa of the stored rows (register reconciles to the ledger)', async () => {
    const invoices = [inv(1), inv(2, { net_paisa: '99', taxable_paisa: '88', vat_paisa: '11' }), inv(3, { net_paisa: '1' })]; const { body } = await xlsxOf({ invoices });
    const sum = (body as Cell[][]).reduce((s, r) => s + (r[6] as number), 0); const paisa = invoices.reduce((s, r) => s + Number(r.net_paisa), 0);
    expect(sum === paisa || Math.round(sum * 100) === paisa, `${sum} vs ${paisa}`).toBe(true);
  });
});

describe('other kinds: same field set as the XML row, values in the right cells', () => {
  it('cancelled_invoices: invoice no, credit-note no, buyer, reason, total; one row per cancelled invoice', async () => {
    const { rows, body } = await xlsxOf({ job: jobRow({ kind: 'cancelled_invoices' }), invoices: [inv(2, { status: 'cancelled', cancelled_at: '2026-11-08T05:30:00.000Z', cancel_reason_code: 'billing_error', credit_note_no: '083/84-CN-000001' })] });
    expect(rows[0]!).toHaveLength(9); expect(body).toHaveLength(1);
    const r = (body as Cell[][])[0]!; expect(r).toHaveLength(9); expect(r[0]).toBe(1); expect(r).toEqual(expect.arrayContaining(['083/84-000002', '083/84-CN-000001', 'Synthetic Buyer 2', 'billing_error']));
    expect(r.some((c) => money(c, 113000))).toBe(true);
  });
  it('credit_notes: both kinds, 14 columns, Σ net equals Σ net_paisa (C8 R1) and rows keep credit_note_seq order', async () => {
    const creditNotes = [cn(1), cn(2), cn(3), cn(4)]; const { rows, body } = await xlsxOf({ job: jobRow({ kind: 'credit_notes' }), creditNotes });
    expect(rows[0]!).toHaveLength(14); expect(body).toHaveLength(4);
    expect((body as Cell[][]).map((r) => r.find((c) => typeof c === 'string' && c.startsWith('083/84-CN-')))).toEqual(creditNotes.map((r) => r.credit_note_no));
    for (const k of ['cancellation', 'partial']) expect((body as Cell[][]).some((r) => r.includes(k)), k).toBe(true);
    const net = (body as Cell[][]).reduce((s, r) => s + (r[13] as number), 0); const paisa = 1130 + 2260 + 3390 + 4520;
    expect(net === paisa || Math.round(net * 100) === paisa, `${net} vs ${paisa}`).toBe(true);
  });
  it('audit_trail: action, timestamp and document no per row; activity_log.details is never exported', async () => {
    const { rows, body, parts } = await xlsxOf({ job: jobRow({ kind: 'audit_trail' }), activity: [act(1), act(2, { action: 'invoice_cancelled' })] });
    expect(rows[0]!).toHaveLength(6); expect(body).toHaveLength(2);
    expect((body as Cell[][])[0]).toEqual(expect.arrayContaining(['invoice_issued', '083/84-000001'])); expect((body as Cell[][])[1]).toEqual(expect.arrayContaining(['invoice_cancelled', '083/84-000002']));
    for (const [k, xml] of parts) expect(xml, k).not.toContain('PHI-LIKE-DETAIL');
  });
  it('daily_cash: payment, reversal and refund rows; a negative amount is a number cell, never "-…" text', async () => {
    const { rows, body, parts } = await xlsxOf({ job: jobRow({ kind: 'daily_cash' }), cashRows: [cash(1), cash(2, { entry_kind: 'refund', amount_paisa: '-2500' })] });
    expect(rows[0]!).toHaveLength(4); expect(body).toHaveLength(2);
    expect(money((body as Cell[][])[1]![3], -2500)).toBe(true); expect(money((body as Cell[][])[0]![3], 50000)).toBe(true);
    for (const t of runs(parts)) expect(t, t).not.toMatch(/^-/);
  });
});

// ---- US-BL-12.6 / A21: every text cell goes through neutraliseFormula ----
const HOSTILE = ['=HYPERLINK("http://evil","click")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', "'=1", "'", '=', '-'];
const GOLDEN: Array<{ input: string; neutralised: string }> = JSON.parse(readFileSync(join(ROOT, 'packages/test-fixtures/spreadsheet/golden.json'), 'utf8')).cases;
const DANGEROUS_START = /^[=+\-@\t\r]/;

describe('US-BL-12.6 formula injection: buyer name (A21)', () => {
  it.each(HOSTILE)('buyer_name %j is stored neutralised ("\'" prefix), never raw, and restores to the original', async (s) => {
    const { body, parts } = await xlsxOf({ invoices: [inv(1, { buyer_name: s })] });
    const cell = (body as Cell[][])[0]![4] as string;
    expect(cell).toBe(neutraliseFormula(s)); expect(cell).not.toBe(s); expect(cell.startsWith("'")).toBe(true); expect(restoreNeutralised(cell)).toBe(s);
    expect(runs(parts)).toContain(neutraliseFormula(s)); expect(runs(parts)).not.toContain(s);
  });
  it('the PRD example: "=HYPERLINK(...)" exports as \'=HYPERLINK(...) text and creates no formula or hyperlink', async () => {
    const evil = '=HYPERLINK("http://evil.invalid","x")'; const { body, parts } = await xlsxOf({ invoices: [inv(1, { buyer_name: evil })] });
    expect((body as Cell[][])[0]![4]).toBe(`'${evil}`);
    for (const [k, xml] of parts) if (k.startsWith('xl/')) { expect(xml, k).not.toMatch(/<f[\s>/]/); expect(xml, k).not.toMatch(/<hyperlink/); }
  });
  it.each(GOLDEN.map((g) => [g.input, g.neutralised] as const))('shared golden case %j -> %j', async (input, expected) => {
    const { body } = await xlsxOf({ invoices: [inv(1, { buyer_name: input })] });
    expect((body as Cell[][])[0]![4] ?? '').toBe(expected);
  });
  it('safe strings are written verbatim (no stray apostrophes), including apostrophes inside a name and non-Latin text', async () => {
    for (const s of ['Ram Prasad', "O'Neil Traders", 'सिन्थेटिक खरिदकर्ता', 'a=b', '1+1']) { const { body } = await xlsxOf({ invoices: [inv(1, { buyer_name: s })] }); expect((body as Cell[][])[0]![4], s).toBe(s); }
  });
});

describe('US-BL-12.6 formula injection: EVERY text cell, every kind', () => {
  const E = '=cmd|\' /C calc\'!A0';
  const textOnly = (parts: Map<string, string>) => { const t = runs(parts); expect(t.length).toBeGreaterThan(0); for (const x of t) expect(x, `unneutralised text run ${JSON.stringify(x)}`).not.toMatch(DANGEROUS_START); return t; };
  it('sales_register: invoice no, buyer name, buyer PAN, status and B.S. date all hostile -> every text cell neutralised', async () => {
    const { body, parts } = await xlsxOf({ invoices: [inv(1, { invoice_no: '=1+1', buyer_name: '+SUM(1)', buyer_pan: '@PAN', status: '-issued', invoice_date_bs: '=2083-07-22' })] });
    const r = (body as Cell[][])[0]!; expect(r[3]).toBe("'=1+1"); expect(r[4]).toBe("'+SUM(1)"); expect(String(r[5])).toBe("'@PAN"); expect(r[11]).toBe("'-issued"); expect(r[1]).toBe("'=2083-07-22");
    textOnly(parts);
  });
  it('cancelled_invoices: invoice no, credit-note no, buyer name, PAN, reason code', async () => {
    const { body, parts } = await xlsxOf({ job: jobRow({ kind: 'cancelled_invoices' }), invoices: [inv(2, { status: 'cancelled', cancelled_at: '2026-11-08T05:30:00.000Z', invoice_no: '=A1', credit_note_no: '+CN', buyer_name: '-B', buyer_pan: '@P', cancel_reason_code: '=reason' })] });
    expect((body as Cell[][])[0]).toEqual(expect.arrayContaining(["'=A1", "'+CN", "'-B", "'@P", "'=reason"])); textOnly(parts);
  });
  it('credit_notes: credit-note no, kind-independent text (invoice no, buyer name, PAN, reason code)', async () => {
    const { body, parts } = await xlsxOf({ job: jobRow({ kind: 'credit_notes' }), creditNotes: [cn(1, { credit_note_no: '=CN', invoice_no: '+INV', buyer_name: '-B', buyer_pan: '@P', reason_code: '=r' })] });
    expect((body as Cell[][])[0]).toEqual(expect.arrayContaining(["'=CN", "'+INV", "'-B", "'@P", "'=r"])); textOnly(parts);
  });
  it('audit_trail: action, document kind, document no, actor ids', async () => {
    const { body, parts } = await xlsxOf({ job: jobRow({ kind: 'audit_trail' }), activity: [act(1, { action: '=act', document_kind: '+kind', document_no: '@no', document_id: '-id', actor_membership_id: '=mid' })] });
    expect((body as Cell[][])[0]).toEqual(expect.arrayContaining(["'=act", "'+kind", "'@no", "'-id", "'=mid"])); textOnly(parts);
  });
  it('daily_cash: method code and entry kind', async () => {
    const { body, parts } = await xlsxOf({ job: jobRow({ kind: 'daily_cash' }), cashRows: [cash(1, { method_code: '=m', entry_kind: '+k' })] });
    expect((body as Cell[][])[0]).toEqual(expect.arrayContaining(["'=m", "'+k"])); textOnly(parts);
  });
  it('header cells are text cells too, and no text run anywhere in the package starts with = + - @ TAB CR (generic scan, all kinds, hostile everywhere)', async () => {
    for (const [kind, extra] of [['sales_register', { invoices: [inv(1, { buyer_name: E })] }], ['credit_notes', { creditNotes: [cn(1, { buyer_name: E })] }], ['audit_trail', { activity: [act(1, { document_no: E })] }]] as const) {
      const { parts, rows } = await xlsxOf({ job: jobRow({ kind }), ...extra } as never); textOnly(parts);
      for (const h of rows[0]!) expect(String(h), kind).not.toMatch(DANGEROUS_START);
    }
  });
});

describe('robustness: hostile bytes in cells cannot corrupt the workbook', () => {
  it('XML-significant text (<, &, quotes, ]]>, fake closing tags) round-trips as text; the file still opens', async () => {
    const evil = '</c></row></sheetData><x a="1">&amp; ]]> <script>alert(1)</script>';
    const { body, parts } = await xlsxOf({ invoices: [inv(1, { buyer_name: evil })] });
    expect((body as Cell[][])[0]![4]).toBe(evil); expect(runs(parts)).toContain(evil); for (const [k, xml] of parts) if (k.startsWith('xl/')) expect(xml, k).not.toContain('<script>');
  });
  it('characters XML 1.0 forbids (NUL, C0 controls, lone surrogate) do not make the file unreadable', async () => {
    const { body } = await xlsxOf({ invoices: [inv(1, { buyer_name: 'A\u0000B\u0001C\u001fD\ud800E', invoice_no: 'X\u0008Y' })] });
    expect(body).toHaveLength(1); expect(String((body as Cell[][])[0]![4])).toMatch(/^A.*B.*C.*D.*E$/s);
  });
  it('very long cells (40,000 chars) are stored whole or capped, never crash the job', async () => {
    const w = world({ invoices: [inv(1, { buyer_name: 'x'.repeat(40_000) })] }); await run(w);
    expect(w.puts).toHaveLength(1); expect(w.ready()).toBeDefined(); expect(((await sheetsOf(w.puts[0].bytes))[0]!.rows[1]![4] as string).length).toBeGreaterThan(1000);
  });
});

describe('caps, tenant scope, retries', () => {
  it('xlsx uses the general row cap (LIMS_BILLING_EXPORT_MAX_ROWS), not the PDF cap: over it -> job failed billing.export_too_large, nothing stored', async () => {
    const old = process.env['LIMS_BILLING_EXPORT_MAX_ROWS']; process.env['LIMS_BILLING_EXPORT_MAX_ROWS'] = '3';
    try {
      const over = world({ invoices: [inv(1), inv(2), inv(3), inv(4)] }); await run(over).catch(() => undefined);
      expect(over.puts).toEqual([]); expect(over.failed()).toContain('billing.export_too_large'); expect(over.ready()).toBeUndefined();
      const at = world({ invoices: [inv(1), inv(2), inv(3)] }); await run(at); expect(at.puts).toHaveLength(1);
    } finally { if (old === undefined) delete process.env['LIMS_BILLING_EXPORT_MAX_ROWS']; else process.env['LIMS_BILLING_EXPORT_MAX_ROWS'] = old; }
  });
  it('5,001 rows as xlsx still render (the 5,000 cap is PDF only)', async () => {
    const w = world({ invoices: Array.from({ length: 5001 }, (_, i) => inv(i + 1)) }); await run(w); expect(w.puts).toHaveLength(1); expect(w.ready()).toBeDefined();
  }, 60_000);
  it('every statement is tenant-scoped: the tenant id is bound, the other tenant never appears', async () => {
    const { w } = await xlsxOf({ invoices: [inv(1)] });
    for (const s of w.stmts) expect(s.text, s.text).toMatch(/tenant_id/);
    expect(JSON.stringify(w.stmts.map((s) => s.values))).toContain(TENANT_A); expect(JSON.stringify(w.stmts)).not.toContain(TENANT_B);
  });
  it('first attempt stores the object then fails on the ready UPDATE; the retry (even in a later month) reaches ready with exactly ONE object at the original key', async () => {
    const objects = new Map<string, Buffer>(); const invoices = [inv(1), inv(2)];
    const first = world({ invoices, objects, failReadyOnce: true });
    await expect(run(first)).rejects.toBeDefined(); expect(objects.size).toBe(1);
    const second = world({ invoices, objects, attempt: 2, now: '2026-12-02T12:00:00.000Z' }); await run(second);
    expect(second.ready(), 'retry reaches ready (a non-deterministic zip must not break the ifAbsent read-back)').toBeDefined(); expect(second.failed()).toBeUndefined();
    expect([...objects.keys()]).toEqual([`${BUCKET}/${TENANT_A}/2026/11/${JOB}.xlsx`]);
    expect(second.ready()).toContain(sha(objects.get(`${BUCKET}/${TENANT_A}/2026/11/${JOB}.xlsx`)!));   // the sha recorded is that of the object actually stored
  });
  it('replays are no-ops: a ready / failed / expired xlsx job is not rendered again', async () => {
    for (const status of ['ready', 'failed', 'expired']) { const w = world({ job: jobRow({ status }), invoices: [inv(1)] }); await run(w); expect(w.puts, status).toEqual([]); }
  });
});

describe('static: the xlsx branch is gone and the shared guard is the only guard (P-9, lint no-local-spreadsheet-guard)', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const src = (rel: string) => strip(readFileSync(join(ROOT, rel), 'utf8'));
  it('neither export_render.ts nor export.service.ts ties xlsx to common.feature_disabled any more', () => {
    for (const rel of ['services/worker/src/jobs/billing/tasks/export_render.ts', 'services/api/src/modules/billing/service/export.service.ts']) {
      const lines = src(rel).split('\n'); expect(lines.filter((l) => /xlsx/i.test(l) && /feature_disabled/.test(l)), rel).toEqual([]);
      expect(src(rel), rel).not.toMatch(/format\s*===\s*['"]xlsx['"][^;\n]*(throw|feature_disabled)/);
    }
  });
  it('worker billing tasks that write xlsx import neutraliseFormula from the shared spreadsheet helper and define no local copy', () => {
    const walk = (d: string): string[] => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.name === '__tests__' ? [] : e.isDirectory() ? walk(`${d}/${e.name}`) : /\.ts$/.test(e.name) ? [`${d}/${e.name}`] : []));
    const files = walk('services/worker/src/jobs/billing');
    const writer = files.map((f) => ({ f, s: src(f) })).filter(({ s }) => /write-excel-file/.test(s));
    expect(writer.length, 'a billing worker module must use write-excel-file 4.1.1').toBeGreaterThan(0);
    for (const { f, s } of writer) {
      expect(s, f).toMatch(/neutraliseFormula/); expect(s, f).toMatch(/(@lims\/shared-ts\/spreadsheet|shared-ts\/src\/spreadsheet)/);
      expect(s, f).not.toMatch(/(function|const|let)\s+neutraliseFormula\b/);
    }
  });
  it('the writer library is the pinned 4.1.1 (08 R12e) and the CSV-style local guards are not reintroduced in billing', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'services/worker/package.json'), 'utf8')).dependencies['write-excel-file']).toBe('4.1.1');
    for (const f of ['services/worker/src/jobs/billing/tasks/export_render.ts', 'services/api/src/modules/billing/service/export.service.ts']) expect(src(f), f).not.toMatch(/replace\([^)]*\[=\+\\?-@/);
  });
});
