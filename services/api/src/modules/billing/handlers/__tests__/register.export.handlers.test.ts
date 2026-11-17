// LD-97 (2026-11-11) BL-T15 reopened: nine operationIds were still the BL-T01 stub (common.service_unavailable) in handlers/index.ts:
// B24 getSalesRegister, B25 getCancelledInvoiceRegister, B26 getCreditNoteRegister, B27 getAuditTrail, B28 createBillingExport, B29 getBillingExport,
// B29a getBillingExportContent, B6 listCreditNotes, B6 getCreditNote. Each runs the REAL service here against a fake tx routed by table; none may answer service_unavailable.
// B29a answers the ctx.download.stream result (real createDownload over fake storage): attachment, nosniff, no-store, bytes, never a URL. Schema, x-permission and Idempotency-Key
// are the core pipeline's (contracts/openapi/billing.yaml) and are NOT re-tested; service behaviour lives in register.service.test.ts / export.service.test.ts.
// Handler contract (same as invoice.handlers.test.ts): (req:{params,query,headers,body}, ctx) -> {status, body, headers?}; needs ctx.tenantId + ctx.actor.id + ctx.tx else auth.unauthenticated.
// Query keys arrive snake_case from the pipeline (fiscal_year_bs, issued_at_from, ...); the handler maps them to the service's camelCase input.
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { createDownload } from '../../../../core/storage/download.js';
import { handlers } from '../index.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const CENTRE = V7('000000020002'), JOB = V7('000000d00001'), INV = V7('000000a00001'), CN = V7('000000c00001'), ACT = V7('000000b00001');
const OPS = ['getSalesRegister', 'getCancelledInvoiceRegister', 'getCreditNoteRegister', 'getAuditTrail', 'createBillingExport', 'getBillingExport', 'getBillingExportContent', 'listCreditNotes', 'getCreditNote'] as const;
type Op = (typeof OPS)[number];
const A = makeCtxFor()('A').tenantId as string;
const B = makeCtxFor()('B').tenantId as string;
const T = (s: string) => new Date(s);
const MONEY = (n: number) => ({ amount_paisa: n, currency: 'NPR' });

const invRow = (tenant: string, over: Record<string, unknown> = {}) => ({
  id: INV, tenant_id: tenant, invoice_seq: 1, invoice_no: '083/84-000001', fiscal_year_bs: '2083/84', centre_id: CENTRE, issued_at: T('2026-11-05T04:00:00.000Z'), invoice_date_bs: '2083-07-19',
  buyer_name: 'Synthetic Buyer One', buyer_pan: '123456789', exempt_paisa: '0', taxable_paisa: '100000', vat_paisa: '13000', other_tax_paisa: '0', net_paisa: '113000', status: 'issued',
  cancelled_at: T('2026-11-05T05:00:00.000Z'), cancel_reason_code: 'billing_error', credit_note_no: 'CN-083/84-000001', ...over,
});
const cnRow = (tenant: string, over: Record<string, unknown> = {}) => ({
  id: CN, tenant_id: tenant, credit_note_seq: 1, credit_note_no: 'CN-083/84-000001', kind: 'cancellation', invoice_id: INV, invoice_no: '083/84-000001', fiscal_year_bs: '2083/84',
  issued_at: T('2026-11-05T05:00:00.000Z'), credit_note_date_bs: '2083-07-19', centre_id: CENTRE, reason_code: 'billing_error', reason_text: null, buyer_name: 'Synthetic Buyer One', buyer_pan: '123456789',
  exempt_paisa: '0', taxable_paisa: '100000', vat_paisa: '13000', other_tax_paisa: '0', net_paisa: '113000', print_count: 0, cbms_state: 'pending', version: 1, ...over,
});
const actRow = (tenant: string) => ({
  id: V7('000000900001'), tenant_id: tenant, action: 'invoice_issued', document_kind: 'invoice', document_id: INV, document_no: '083/84-000001', actor_id: ACT, actor_membership_id: null,
  actor_type: 'user', occurred_at: T('2026-11-05T04:00:00.000Z'),
});
const jobRow = (tenant: string, over: Record<string, unknown> = {}) => ({
  id: JOB, tenant_id: tenant, kind: 'sales_register', format: 'xml', status: 'ready', filters: {}, row_count: 1, bucket: 'billing-exports', object_path: `${tenant}/2026/11/${JOB}.xml`, sha256: 'a'.repeat(64),
  error_code: null, created_at: T('2026-11-05T04:00:00.000Z'), completed_at: T('2026-11-05T04:05:00.000Z'), expires_at: T('2026-11-12T04:05:00.000Z'), requested_by_membership_id: ACT, ...over,
});

interface Data { invoices?: any[]; creditNotes?: any[]; activity?: any[]; jobs?: any[] }
/** Fake tx routed by the table named in the statement; the tests do not depend on the SQL text beyond that. */
function fakeTx(d: Data) {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  const mine = (rows: any[], values: unknown[]) => rows.filter((r) => values.includes(r.tenant_id));
  const byId = (text: string) => /(?<![A-Za-z_])id\s*=\s*\$\d/i.test(text);
  const tx = {
    async query(text: string, values: unknown[] = []) {
      stmts.push({ text, values });
      const t = (name: string) => new RegExp(`\\bbilling\\.${name}\\b`, 'i').test(text);
      if (/\bcount\(\*\)/i.test(text)) return { rows: [{ count: 1 }] };
      if (/\bapp\.enqueue_job\b/i.test(text)) return { rows: [{}] };
      if (/^\s*INSERT\s+INTO\s+billing\.export_jobs/i.test(text)) {
        const [id, tenant_id, kind, format, filters, requested_by_membership_id, created_at] = values as any[];
        return { rows: [{ id, tenant_id, kind, format, filters: JSON.parse(filters), status: 'queued', requested_by_membership_id, created_at: new Date(created_at), completed_at: null, expires_at: null, row_count: null }] };
      }
      if (/^\s*INSERT\b/i.test(text)) return { rows: [] };
      if (t('export_jobs')) return { rows: mine(d.jobs ?? [], values).filter((r) => !byId(text) || values.includes(r.id)) };
      if (t('activity_log')) return { rows: mine(d.activity ?? [], values) };
      if (t('credit_note_lines')) return { rows: [] };
      if (t('credit_notes') && !t('invoices')) return { rows: mine(d.creditNotes ?? [], values).filter((r) => !byId(text) || values.includes(r.id)) };
      if (t('invoices')) return { rows: mine(d.invoices ?? [], values) };
      return { rows: [] };
    },
  };
  return { tx, stmts };
}

interface Spy { access: Array<Record<string, any>>; reads: string[]; streams: Array<Record<string, any>> }
const BYTES = new TextEncoder().encode('<?xml version="1.0"?><export xmlns="urn:lims:billing:export:v1"/>');
function hctx(tx: unknown, o: { tenant?: 'A' | 'B'; privileged?: boolean } = {}) {
  const spy: Spy = { access: [], reads: [], streams: [] };
  const audit = { access: async (e: Record<string, any>) => { spy.access.push(e); } };
  const storage = {
    // get/read both exist: the service may read bytes itself (get) or leave it to ctx.download.stream (read); whichever the writer picks, no URL is ever produced
    async get(bucket: string, path: string) { spy.reads.push(`${bucket}/${path}`); return BYTES; },
    async read(bucket: string, path: string) { spy.reads.push(`${bucket}/${path}`); return BYTES; },
    async put() {}, async delete() {}, async signedUrl() { throw new Error('signedUrl must never be called (08 A13 P-2)'); },
  };
  const download = createDownload({ storage: storage as never, audit });
  const base = makeCtxFor()(o.tenant ?? 'A', {
    tx: tx as never, audit, storage, download: { stream: (i: any) => { spy.streams.push(i); return download.stream(i); } },
    ports: { IdentityPort: { assertRole: async () => { if (o.privileged === false) { const e: any = new Error('forbidden'); e.code = 'auth.forbidden'; throw e; } }, getActor: async () => ({ displayName: 'Synthetic Staff' }) } },
    events: { publish: async () => {} },
  } as never) as any;
  base.actor = { ...base.actor, membershipId: ACT };
  return { ctx: { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, ...base } as never, spy };
}
const req = (o: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o }) as never;
const run = (op: Op, r: unknown, c: unknown) => (handlers[op] as any)(r, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const wrote = (stmts: Array<{ text: string; values: unknown[] }>, re: RegExp) => stmts.filter((s) => re.test(s.text));

const GOOD_REQ: Record<Op, unknown> = {
  getSalesRegister: req({ query: { limit: 50 } }), getCancelledInvoiceRegister: req({ query: { limit: 50 } }), getCreditNoteRegister: req({ query: { limit: 50 } }),
  getAuditTrail: req({ query: { limit: 50 } }),
  createBillingExport: req({ headers: { 'idempotency-key': 'bl15-h-1' }, body: { kind: 'sales_register', format: 'xml', filters: { fiscal_year_bs: '2083/84' } } }),
  getBillingExport: req({ params: { export_id: JOB } }), getBillingExportContent: req({ params: { export_id: JOB } }),
  listCreditNotes: req({ query: { limit: 50 } }), getCreditNote: req({ params: { credit_note_id: CN } }),
};
const data = (t: string): Data => ({ invoices: [invRow(t)], creditNotes: [cnRow(t)], activity: [actRow(t)], jobs: [jobRow(t)] });

describe('LD-97: the nine operationIds are real handlers, not the BL-T01 stub (REQ-SEC-099)', () => {
  for (const op of OPS) {
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated (the stub answers common.service_unavailable)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(op, GOOD_REQ[op], bare))).code).toBe('auth.unauthenticated');
    });
    it(`${op}: with a full ctx and fake DB it never throws common.service_unavailable`, async () => {
      const { ctx } = hctx(fakeTx(data(A)).tx);
      let out: any, err: any;
      try { out = await run(op, GOOD_REQ[op], ctx); } catch (e) { err = e; }
      expect(err?.code, op).not.toBe('common.service_unavailable');
      expect(err, `${op} threw ${err?.code ?? err}`).toBeUndefined();
      expect(out.status, op).toBeGreaterThanOrEqual(200);
      expect(out.status, op).toBeLessThan(300);
    });
  }
  it('no two of the nine share one function (no leftover shared stub)', () => {
    const fns = OPS.map((op) => handlers[op]);
    expect(new Set(fns).size).toBe(OPS.length);
    const stub = (handlers as any).createPaymentIntent; // BL-T21 stays the stub, Phase 1.5
    for (const op of OPS) expect(handlers[op], op).not.toBe(stub);
    expect((handlers as any).verifyPaymentIntent).toBe(stub);
  });
});

describe('B24 / B25 / B26 registers (real register.service over the fake tx)', () => {
  it('B24 getSalesRegister: 200 page with SalesRegisterRow, Money integers, snake_case filters travel as bound values, tenant bound, no tenant_id leak', async () => {
    const { tx, stmts } = fakeTx(data(A));
    const { ctx } = hctx(tx);
    const out = await run('getSalesRegister', req({ query: { fiscal_year_bs: '2083/84', issued_at_from: '2026-11-05T00:00:00.000Z', issued_at_to: '2026-11-06T00:00:00.000Z', centre_id: CENTRE, limit: 50 } }), ctx);
    expect(out.status).toBe(200);
    expect(out.body.page).toEqual({ limit: 50 });
    expect(out.body.data).toHaveLength(1);
    expect(out.body.data[0]).toMatchObject({ sn: 1, invoice_date_bs: '2083-07-19', invoice_no: '083/84-000001', buyer_name: 'Synthetic Buyer One', total: MONEY(113000), vat: MONEY(13000), status: 'issued' });
    const q = stmts.find((s) => /billing\.invoices/i.test(s.text))!;
    expect(q.values).toEqual(expect.arrayContaining([A, '2083/84', CENTRE, '2026-11-05T00:00:00.000Z']));
    expect(JSON.stringify(out.body)).not.toMatch(/tenant_id|created_by|stack/);
  });
  it('B25 getCancelledInvoiceRegister: 200 with the credit note number and reason_code', async () => {
    const { tx } = fakeTx(data(A));
    const out = await run('getCancelledInvoiceRegister', req({ query: { limit: 50 } }), hctx(tx).ctx);
    expect(out.status).toBe(200);
    expect(out.body.data[0]).toMatchObject({ sn: 1, invoice_no: '083/84-000001', credit_note_no: 'CN-083/84-000001', reason_code: 'billing_error', total: MONEY(113000) });
  });
  it('B26 getCreditNoteRegister: 200 with the credit note row (kind, net Money)', async () => {
    const { tx } = fakeTx(data(A));
    const out = await run('getCreditNoteRegister', req({ query: { limit: 50 } }), hctx(tx).ctx);
    expect(out.status).toBe(200);
    expect(out.body.data[0]).toMatchObject({ sn: 1, credit_note_no: 'CN-083/84-000001', kind: 'cancellation', invoice_no: '083/84-000001', net: MONEY(113000) });
  });
  it('a hostile fiscal_year_bs is refused (400) before any billing query', async () => {
    const { tx, stmts } = fakeTx(data(A));
    const e = await fail(run('getSalesRegister', req({ query: { fiscal_year_bs: "2083/84'; DROP TABLE billing.invoices; --" } }), hctx(tx).ctx));
    expect(e.code).toBe('common.validation_failed');
    expect(wrote(stmts, /billing\./i)).toEqual([]);
  });
  it('tenant scoping: another tenant\'s rows are never returned', async () => {
    const { tx } = fakeTx({ invoices: [invRow(B)] });
    const out = await run('getSalesRegister', req({ query: { limit: 50 } }), hctx(tx).ctx);
    expect(out.body.data).toEqual([]);
  });
});

describe('B27 getAuditTrail (real register.service)', () => {
  it('200 ActivityRow page: ISO occurred_at, actor {membership_id, display_name}, action, entity; details / user ids / tenant never leave', async () => {
    const { tx, stmts } = fakeTx(data(A));
    const out = await run('getAuditTrail', req({ query: { action: 'invoice_issued', occurred_at_from: '2026-11-05T00:00:00.000Z', limit: 50 } }), hctx(tx).ctx);
    expect(out.status).toBe(200);
    expect(out.body.data).toHaveLength(1);
    expect(out.body.data[0]).toMatchObject({ occurred_at: '2026-11-05T04:00:00.000Z', action: 'invoice_issued', entity_type: 'invoice', entity_id: INV });
    expect(typeof out.body.data[0].actor.membership_id).toBe('string');
    expect(typeof out.body.data[0].actor.display_name).toBe('string');
    expect(JSON.stringify(out.body)).not.toMatch(/tenant_id|"details"|created_by|stack/);
    expect(stmts.find((s) => /billing\.activity_log/i.test(s.text))!.values).toEqual(expect.arrayContaining([A, 'invoice_issued']));
  });
  it('an action outside billing.activity_log__action__ck is refused (400)', async () => {
    const { tx } = fakeTx(data(A));
    expect((await fail(run('getAuditTrail', req({ query: { action: 'drop_everything' } }), hctx(tx).ctx))).code).toBe('common.validation_failed');
  });
});

describe('B28 createBillingExport (real export.service)', () => {
  it('202 ExportJob status queued: job row + billing.export_render enqueued + access_log data.export stage create; ExportJob carries no bucket / path / sha256 / URL', async () => {
    const { tx, stmts } = fakeTx(data(A));
    const { ctx, spy } = hctx(tx);
    const out = await run('createBillingExport', GOOD_REQ.createBillingExport, ctx);
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ kind: 'sales_register', format: 'xml', status: 'queued' });
    expect(typeof out.body.id).toBe('string');
    for (const k of ['bucket', 'object_path', 'sha256', 'error_code', 'filters', 'tenant_id', 'requested_by_membership_id', 'url', 'signed_url']) expect(Object.keys(out.body), k).not.toContain(k);
    expect(wrote(stmts, /\bapp\.enqueue_job\b/i)).toHaveLength(1);
    expect(wrote(stmts, /\bapp\.enqueue_job\b/i)[0]!.values[0]).toBe('billing.export_render');
    expect(spy.access).toEqual([expect.objectContaining({ action: 'data.export', entityType: 'billing_export', entityId: out.body.id, detail: { stage: 'create' } })]);
  });
  it('privileged: a caller who fails IdentityPort billing.data.export gets auth.forbidden and no job row, no enqueue', async () => {
    const { tx, stmts } = fakeTx(data(A));
    const { ctx, spy } = hctx(tx, { privileged: false });
    expect((await fail(run('createBillingExport', GOOD_REQ.createBillingExport, ctx))).code).toBe('auth.forbidden');
    expect(wrote(stmts, /INSERT|enqueue_job/i)).toEqual([]);
    expect(spy.access).toEqual([]);
  });
  it('an unknown kind or format is refused (400) before any write', async () => {
    const { tx, stmts } = fakeTx(data(A));
    for (const body of [{ kind: 'everything', format: 'xml' }, { kind: 'sales_register', format: 'exe' }])
      expect((await fail(run('createBillingExport', req({ headers: { 'idempotency-key': 'k' }, body }), hctx(tx).ctx))).code).toBe('common.validation_failed');
    expect(wrote(stmts, /INSERT|enqueue_job/i)).toEqual([]);
  });
});

describe('B29 getBillingExport (real export.service)', () => {
  it('200 ExportJob of this tenant: status only, ISO dates, no bucket / object_path / sha256 / error_code / URL', async () => {
    const { tx } = fakeTx(data(A));
    const out = await run('getBillingExport', req({ params: { export_id: JOB } }), hctx(tx).ctx);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ id: JOB, kind: 'sales_register', format: 'xml', status: 'ready', row_count: 1, expires_at: '2026-11-12T04:05:00.000Z' });
    for (const k of ['bucket', 'object_path', 'sha256', 'error_code', 'tenant_id', 'url', 'signed_url']) expect(Object.keys(out.body), k).not.toContain(k);
    expect(JSON.stringify(out.body)).not.toMatch(/billing-exports|https?:\/\//);
  });
  it('another tenant\'s job and an unknown id both -> 404 common.not_found; a non-uuid id -> 400 before any query', async () => {
    const { tx, stmts } = fakeTx(data(A));
    expect((await fail(run('getBillingExport', req({ params: { export_id: JOB } }), hctx(tx, { tenant: 'B' }).ctx))).code).toBe('common.not_found');
    expect((await fail(run('getBillingExport', req({ params: { export_id: V7('0000000a9999') } }), hctx(tx).ctx))).code).toBe('common.not_found');
    const n = stmts.length;
    expect((await fail(run('getBillingExport', req({ params: { export_id: '1; DROP TABLE x' } }), hctx(tx).ctx))).code).toBe('common.validation_failed');
    expect(stmts.length).toBe(n);
  });
});

describe('B29a getBillingExportContent (service + core ctx.download.stream; 08 A13 P-2)', () => {
  it('200 file stream: the stored bytes, Content-Disposition attachment, X-Content-Type-Options nosniff, Cache-Control no-store, application/xml; never a URL', async () => {
    const { tx } = fakeTx(data(A));
    const { ctx, spy } = hctx(tx);
    const out = await run('getBillingExportContent', req({ params: { export_id: JOB } }), ctx);
    expect(out.status).toBe(200);
    const h = Object.fromEntries(Object.entries(out.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    expect(h['content-disposition']).toMatch(/^attachment;/);
    expect(h['content-disposition']).toContain(`${JOB}.xml`);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['cache-control']).toBe('no-store');
    expect(h['content-type']).toBe('application/xml');
    expect(h['location']).toBeUndefined();
    expect(Buffer.from(out.body as Uint8Array).equals(Buffer.from(BYTES))).toBe(true);
    expect(JSON.stringify(out.headers)).not.toMatch(/https?:\/\//);
    expect(spy.reads.every((p) => p === `billing-exports/${A}/2026/11/${JOB}.xml`)).toBe(true);
    expect(spy.reads.length).toBeGreaterThan(0);
  });
  it('the download is routed through ctx.download.stream (scanState clean, bucket billing-exports, tenant-prefixed path) and writes access_log data.export stage download', async () => {
    const { tx } = fakeTx(data(A));
    const { ctx, spy } = hctx(tx);
    await run('getBillingExportContent', req({ params: { export_id: JOB } }), ctx);
    expect(spy.streams).toHaveLength(1);
    expect(spy.streams[0]).toMatchObject({ bucket: 'billing-exports', objectPath: `${A}/2026/11/${JOB}.xml`, scanState: 'clean', contentType: 'application/xml' });
    expect(spy.access.some((e) => e['action'] === 'data.export' && e['entityType'] === 'billing_export' && e['entityId'] === JOB && e['detail']?.stage === 'download')).toBe(true);
  });
  it('every call writes an access_log row (P-2): two downloads -> at least two download rows', async () => {
    const { tx } = fakeTx(data(A));
    const { ctx, spy } = hctx(tx);
    await run('getBillingExportContent', req({ params: { export_id: JOB } }), ctx);
    await run('getBillingExportContent', req({ params: { export_id: JOB } }), ctx);
    expect(spy.access.filter((e) => e['detail']?.stage === 'download').length).toBeGreaterThanOrEqual(2);
  });
  it('privileged: a caller who fails IdentityPort billing.data.export gets auth.forbidden and no byte is read', async () => {
    const { tx } = fakeTx(data(A));
    const { ctx, spy } = hctx(tx, { privileged: false });
    expect((await fail(run('getBillingExportContent', req({ params: { export_id: JOB } }), ctx))).code).toBe('auth.forbidden');
    expect(spy.reads).toEqual([]);
  });
  it('not ready -> 409 common.version_conflict (file_not_ready); expired -> 404; another tenant -> 404; none reads storage', async () => {
    for (const [over, tenant, code] of [[{ status: 'running', object_path: null }, 'A', 'common.version_conflict'], [{ status: 'expired' }, 'A', 'common.not_found'], [{}, 'B', 'common.not_found']] as const) {
      const { tx } = fakeTx({ jobs: [jobRow(A, over)] });
      const { ctx, spy } = hctx(tx, { tenant });
      expect((await fail(run('getBillingExportContent', req({ params: { export_id: JOB } }), ctx))).code, JSON.stringify(over)).toBe(code);
      expect(spy.reads).toEqual([]);
    }
  });
  it('a stored path outside the caller\'s tenant prefix is never read (defence in depth) -> 404', async () => {
    const { tx } = fakeTx({ jobs: [jobRow(A, { object_path: `${B}/2026/11/${JOB}.xml` })] });
    const { ctx, spy } = hctx(tx);
    expect((await fail(run('getBillingExportContent', req({ params: { export_id: JOB } }), ctx))).code).toBe('common.not_found');
    expect(spy.reads).toEqual([]);
  });
});

describe('B6 listCreditNotes / getCreditNote (credit-note reads in the invoice read service; CreditNoteDto per 02-TRD §5)', () => {
  it('listCreditNotes: 200 CreditNotePage of CreditNoteDto; tenant bound; no tenant_id / reason internals beyond the DTO', async () => {
    const { tx, stmts } = fakeTx(data(A));
    const out = await run('listCreditNotes', req({ query: { limit: 50 } }), hctx(tx).ctx);
    expect(out.status).toBe(200);
    expect(out.body.page).toEqual({ limit: 50 });
    expect(out.body.data).toHaveLength(1);
    expect(out.body.data[0]).toMatchObject({ id: CN, credit_note_no: 'CN-083/84-000001', credit_note_seq: 1, kind: 'cancellation', invoice_id: INV, fiscal_year_bs: '2083/84', issued_at: '2026-11-05T05:00:00.000Z',
      centre_id: CENTRE, reason_code: 'billing_error', totals: expect.objectContaining({ net: MONEY(113000), vat: MONEY(13000) }) });
    expect(Array.isArray(out.body.data[0].lines)).toBe(true);
    expect(JSON.stringify(out.body)).not.toMatch(/tenant_id|created_by|stack/);
    for (const s of wrote(stmts, /billing\./i)) expect(s.values).toContain(A);
  });
  it('listCreditNotes: another tenant\'s notes are never returned; a hostile fiscal_year_bs is refused before any query', async () => {
    const { tx } = fakeTx({ creditNotes: [cnRow(B)] });
    expect((await run('listCreditNotes', req({ query: { limit: 50 } }), hctx(tx).ctx)).body.data).toEqual([]);
    const { tx: tx2, stmts } = fakeTx(data(A));
    expect((await fail(run('listCreditNotes', req({ query: { fiscal_year_bs: "x' OR '1'='1" } }), hctx(tx2).ctx))).code).toBe('common.validation_failed');
    expect(wrote(stmts, /billing\./i)).toEqual([]);
  });
  it('getCreditNote: 200 CreditNoteDto with lines[] and totals (Money integers), version, print_count, cbms_state', async () => {
    const { tx } = fakeTx(data(A));
    const out = await run('getCreditNote', req({ params: { credit_note_id: CN } }), hctx(tx).ctx);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ id: CN, credit_note_no: 'CN-083/84-000001', credit_note_seq: 1, kind: 'cancellation', invoice_id: INV, invoice_no: '083/84-000001', credit_note_date_bs: '2083-07-19',
      totals: { exempt: MONEY(0), taxable: MONEY(100000), vat: MONEY(13000), other_tax: MONEY(0), net: MONEY(113000) }, print_count: 0, cbms_state: 'pending', version: 1 });
    expect(Array.isArray(out.body.lines)).toBe(true);
  });
  it('getCreditNote: unknown id and another tenant\'s note both -> 404 common.not_found; non-uuid id -> 400 before any query', async () => {
    const { tx, stmts } = fakeTx(data(A));
    expect((await fail(run('getCreditNote', req({ params: { credit_note_id: V7('0000000a9999') } }), hctx(tx).ctx))).code).toBe('common.not_found');
    expect((await fail(run('getCreditNote', req({ params: { credit_note_id: CN } }), hctx(tx, { tenant: 'B' }).ctx))).code).toBe('common.not_found');
    const n = stmts.length;
    expect((await fail(run('getCreditNote', req({ params: { credit_note_id: 'nope' } }), hctx(tx).ctx))).code).toBe('common.validation_failed');
    expect(stmts.length).toBe(n);
  });
});
