// BL-T06 read handlers (contract tests): B1 listInvoices, B2 getInvoice (+ cbms_submissions[]), B7 getOrderBilling, B37 listInvoicePrints.
// contracts/openapi/billing.yaml (InvoiceSummaryPage, InvoiceDetail, OrderBillingDto, InvoicePrintPage); 02-TRD §5 B1/B2/B7/B37; PRD US-BL-13.1 (submission rows visible), US-BL-03.1–.2 (print rows); REQ-SEC-099.
// Fails now: handlers/index.ts maps all four operationIds to the BL-T01 stub (common.service_unavailable).
// Handler contract (same as settings.handlers.test.ts): (req:{params,query,headers,body}, ctx) -> {status, body, headers?}; needs ctx.tenantId + ctx.actor.id + ctx.tx else auth.unauthenticated;
// schema / auth / x-permission (billing.invoice.read) are enforced by the core pipeline, not here. The DB is a fake tx.query routed by the FROM table, so the tests do not depend on the SQL text
// beyond: every statement on a billing.* table binds the caller's tenant id and user input only ever travels as a bound value.
// Row shapes follow 05-SCHEMA exactly the way node-postgres returns them: timestamptz -> Date, bigint -> string, integer -> number.
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { handlers } from '../index.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const INV = V7('000000a00001'), INV2 = V7('000000a00002'), INV3 = V7('000000a00003'), ORDER = V7('000000050001'), CENTRE = V7('000000020002'), BRANCH = V7('000000010001');
const MONEY = (n: number) => ({ amount_paisa: n, currency: 'NPR' });

const invRow = (tenant: string, id: string, seq: number, over: Record<string, unknown> = {}) => ({
  id, tenant_id: tenant, branch_id: BRANCH, centre_id: CENTRE, series: 'INV', fiscal_year_bs: '2083/84', invoice_seq: seq, invoice_no: `083/84-${String(seq).padStart(6, '0')}`,
  invoice_kind: 'tax_invoice', purpose: 'registration', order_id: ORDER, patient_id: V7('000000040001'), credit_party_id: null, is_periodic_credit_bill: false, period_month: null, referrer_id: null,
  buyer_name: 'Synthetic Buyer One', buyer_pan: '123456789', buyer_address: 'Synthetic Street 1', seller_name: 'Synthetic Lab Pvt Ltd', seller_pan: '999999999', seller_address: 'Synthetic Road 2',
  issued_at: new Date('2026-11-08T06:00:01.000Z'), invoice_date_bs: '2083-07-22',
  gross_paisa: '100000', discount_paisa: '0', exempt_paisa: '0', taxable_paisa: '100000', vat_paisa: '13000', other_tax_paisa: '0', net_paisa: '113000',
  prices_include_tax: false, quote_fingerprint: 'a'.repeat(64), status: 'issued', is_active: true, cancelled_at: null, cancelled_by: null, cancel_reason_code: null, cancel_reason_text: null,
  credit_note_id: null, credited_total_paisa: '0', print_count: 1, last_printed_at: new Date('2026-11-08T06:01:00.000Z'), cbms_state: 'pending', cbms_attempts: 1, cbms_last_attempt_at: new Date('2026-11-08T06:02:00.000Z'),
  cbms_synced_at: null, cbms_external_ref: null, cbms_cancel_state: null, version: 2, created_at: new Date('2026-11-08T06:00:01.000Z'), created_by: V7('000000030001'),
  updated_at: new Date('2026-11-08T06:02:00.000Z'), updated_by: V7('000000030001'), ...over,
});
const lineRow = (tenant: string) => ({
  id: V7('000000e00001'), tenant_id: tenant, invoice_id: INV, centre_id: CENTRE, line_no: 1, line_kind: 'orderable', order_item_id: V7('000000060001'), orderable_id: V7('000000070001'), orderable_kind: 'test',
  code: 'CBC', name: 'Complete blood count', department_id: null, hs_code: null, quantity: 1, unit_price_paisa: '100000', gross_paisa: '100000', discount_paisa: '0', exempt_paisa: '0', taxable_paisa: '100000',
  vat_treatment: 'taxable', vat_rate_bp: 1300, vat_paisa: '13000', other_tax_code: null, other_tax_rate_bp: null, other_tax_paisa: '0', net_paisa: '113000', price_list_id: V7('000000080001'), price_list_version: 1,
  price_source: 'tenant_default', is_active: true, created_at: new Date('2026-11-08T06:00:01.000Z'), created_by: V7('000000030001'),
});
const subRow = (tenant: string) => ({
  id: V7('000000f00001'), tenant_id: tenant, document_kind: 'invoice', document_id: INV, attempt_no: 1, client_mode: 'stub', outcome: 'stub_recorded', external_ref: null,
  raw_status_redacted: 'REDACTED-RAW-STATUS', submitted_at: new Date('2026-11-08T06:02:00.000Z'), is_active: true, created_at: new Date('2026-11-08T06:02:00.000Z'), created_by: V7('000000030001'),
});
const printRow = (tenant: string, n: number) => ({
  id: V7(`0000010000${String(n).padStart(2, '0')}`), tenant_id: tenant, centre_id: CENTRE, document_kind: 'invoice', document_id: INV, document_no: '083/84-000001', print_no: n, is_copy: n > 1,
  reason_code: n === 1 ? 'first_print' : 'reprint', printed_at: new Date(`2026-11-08T06:0${n}:00.000Z`), is_active: true, created_at: new Date(), created_by: V7('000000030001'),
});
const balRow = (tenant: string) => ({
  tenant_id: tenant, order_id: ORDER, centre_id: CENTRE, billing_mode: 'cash', invoiced_paisa: '113000', paid_paisa: '100000', credited_paisa: '0', balance_due_paisa: '13000', balance_version: 2,
  release_basis: 'due_outstanding', is_active: true, created_at: new Date(), created_by: V7('000000030001'), updated_at: new Date('2026-11-08T06:03:00.000Z'), updated_by: V7('000000030001'), version: 2,
});

interface Data { invoices?: (t: string) => any[]; lines?: (t: string) => any[]; subs?: (t: string) => any[]; prints?: (t: string) => any[]; balance?: (t: string) => any | undefined }
function fakeTx(d: Data) {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  const mine = (rows: any[], values: unknown[]) => rows.filter((r) => values.includes(r.tenant_id));
  const tx = {
    async query(text: string, values: unknown[] = []) {
      stmts.push({ text, values });
      const t = (name: string) => new RegExp(`\\bbilling\\.${name}\\b`, 'i').test(text);
      if (t('invoice_lines')) return { rows: mine(d.lines?.('*') ?? [], values).filter((r) => values.includes(r.invoice_id)) };
      if (t('cbms_submissions')) return { rows: mine(d.subs?.('*') ?? [], values) };
      if (t('print_log')) return { rows: mine(d.prints?.('*') ?? [], values) };
      if (t('order_balances')) { const b = d.balance?.('*'); return { rows: b ? mine([b], values) : [] }; }
      if (t('invoices')) { // `WHERE tenant_id = $1 AND id = $2` style lookups only match that id; list / by-order queries return the tenant's rows
        const byId = /(?<![A-Za-z_])id\s*=\s*\$\d/i.test(text);
        return { rows: mine(d.invoices?.('*') ?? [], values).filter((r) => !byId || values.includes(r.id)) };
      }
      return { rows: [] };
    },
  };
  return { tx, stmts };
}
const A = makeCtxFor()('A').tenantId as string;
const B = makeCtxFor()('B').tenantId as string;
const hctx = (extra: Record<string, unknown> = {}, tenant: 'A' | 'B' = 'A') => ({
  operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
  ...makeCtxFor()(tenant, { ports: { IdentityPort: { getTenantSettings: async () => ({ releaseRequiresPayment: false }) } } as never }), ...extra,
}) as never;
const req = (o: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o }) as never;
type Op = 'listInvoices' | 'getInvoice' | 'getOrderBilling' | 'listInvoicePrints';
const run = (op: Op, r: unknown, c: unknown) => (handlers[op] as any)(r, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };

const SUMMARY_KEYS = ['id', 'invoice_no', 'invoice_seq', 'fiscal_year_bs', 'invoice_kind', 'status', 'issued_at', 'invoice_date_bs', 'centre_id', 'order_id', 'credit_party_id', 'buyer_name', 'net', 'cbms_state'];
const DETAIL_REQUIRED = ['id', 'invoice_no', 'invoice_seq', 'series', 'fiscal_year_bs', 'invoice_kind', 'status', 'is_active', 'issued_at', 'invoice_date_bs', 'branch_id', 'is_periodic_credit_bill', 'buyer', 'seller',
  'lines', 'totals', 'credited_total', 'print_count', 'cbms_state', 'version', 'cbms_submissions'];
const DETAIL_ALLOWED = new Set([...DETAIL_REQUIRED, 'centre_id', 'order_id', 'credit_party_id', 'referrer_id', 'cancellation', 'last_printed_at', 'cbms_cancel_state']);
const FORBIDDEN = ['tenant_id', 'patient_id', 'quote_fingerprint', 'created_by', 'updated_by', 'created_at', 'updated_at', 'buyer_pan', 'buyer_address', 'buyer_name_raw', 'cbms_external_ref', 'cbms_attempts', 'prices_include_tax'];

describe('fail closed without an authenticated request context (REQ-SEC-099)', () => {
  for (const op of ['listInvoices', 'getInvoice', 'getOrderBilling', 'listInvoicePrints'] as const)
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated (not the BL-T01 503 stub)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(op, req({ params: { invoice_id: INV, order_id: ORDER } }), bare))).code).toBe('auth.unauthenticated');
    });
});

describe('B1 listInvoices', () => {
  const rows = (t: string) => [invRow(t, INV, 3), invRow(t, INV2, 2), invRow(t, INV3, 1)];
  it('200 InvoiceSummaryPage: exact summary keys, net as integer Money, ISO issued_at, no PHI beyond buyer_name, no buyer_pan / patient_id / fingerprint', async () => {
    const { tx } = fakeTx({ invoices: () => rows(A) });
    const out = await run('listInvoices', req({ query: { limit: 50 } }), hctx({ tx }));
    expect(out.status).toBe(200);
    expect(out.body.page).toEqual({ limit: 50 });
    expect(out.body.data).toHaveLength(3);
    const first = out.body.data[0];
    expect(Object.keys(first).every((k) => SUMMARY_KEYS.includes(k))).toBe(true);
    expect(first).toMatchObject({ id: INV, invoice_no: '083/84-000003', invoice_seq: 3, fiscal_year_bs: '2083/84', status: 'issued', issued_at: '2026-11-08T06:00:01.000Z', invoice_date_bs: '2083-07-22',
      centre_id: CENTRE, order_id: ORDER, buyer_name: 'Synthetic Buyer One', net: MONEY(113000), cbms_state: 'pending' });
    for (const k of FORBIDDEN) expect(Object.keys(first), k).not.toContain(k);
    expect(JSON.stringify(out.body)).not.toContain('123456789');
  });
  it('limit 2 with 3 rows available -> 2 rows and an opaque next_cursor (<= 512 chars); fewer rows than limit -> no next_cursor', async () => {
    const { tx } = fakeTx({ invoices: () => rows(A) });
    const out = await run('listInvoices', req({ query: { limit: 2 } }), hctx({ tx }));
    expect(out.body.data).toHaveLength(2); expect(out.body.page.limit).toBe(2);
    expect(typeof out.body.page.next_cursor).toBe('string'); expect(out.body.page.next_cursor.length).toBeLessThanOrEqual(512);
    const { tx: tx2 } = fakeTx({ invoices: () => rows(A).slice(0, 1) });
    expect((await run('listInvoices', req({ query: { limit: 2 } }), hctx({ tx: tx2 }))).body.page.next_cursor).toBeUndefined();
  });
  it('malformed cursor -> common.invalid_cursor (400) before any billing query', async () => {
    const { tx, stmts } = fakeTx({ invoices: () => rows(A) });
    for (const cursor of ['%%%not-a-cursor', 'x'.repeat(600), '{"a":1}']) {
      const e = await fail(run('listInvoices', req({ query: { cursor, limit: 10 } }), hctx({ tx })));
      expect(['common.invalid_cursor', 'common.validation_failed'], cursor.slice(0, 12)).toContain(e.code);
    }
    expect(stmts.filter((s) => /billing\./i.test(s.text))).toEqual([]);
  });
  it('tenant scoping: every billing statement binds ctx.tenantId; another tenant\'s invoices are never returned', async () => {
    const { tx, stmts } = fakeTx({ invoices: () => [...rows(A), ...rows(B)] });
    const out = await run('listInvoices', req({ query: { limit: 50 } }), hctx({ tx }, 'A'));
    expect(out.body.data).toHaveLength(3);
    const q = stmts.filter((s) => /billing\./i.test(s.text));
    expect(q.length).toBeGreaterThan(0);
    for (const s of q) { expect(s.values).toContain(A); expect(s.values).not.toContain(B); expect(s.text).toMatch(/tenant_id/i); }
  });
  it('filters (invoice_no, order_id, sort) travel as bound values only; a hostile invoice_no is never in the SQL text; id is the final sort key (02-CV §4.4)', async () => {
    const evil = "x'; DROP TABLE billing.invoices; --";
    const { tx, stmts } = fakeTx({ invoices: () => rows(A) });
    await run('listInvoices', req({ query: { invoice_no: evil, order_id: ORDER, sort: '-invoice_seq', limit: 10 } }), hctx({ tx }));
    const q = stmts.find((s) => /billing\.invoices/i.test(s.text))!;
    expect(q.text).not.toContain('DROP TABLE'); expect(q.text).not.toContain(evil);
    expect(q.values).toContain(evil); expect(q.values).toContain(ORDER);
    expect(q.text).toMatch(/ORDER\s+BY[\s\S]*\bid\b/i);
  });
  it('an unknown sort value is refused (400 common.validation_failed) and issues no billing query', async () => {
    const { tx, stmts } = fakeTx({ invoices: () => rows(A) });
    const e = await fail(run('listInvoices', req({ query: { sort: 'buyer_name; DROP' } }), hctx({ tx })));
    expect(e.code).toBe('common.validation_failed'); expect(stmts.filter((s) => /billing\./i.test(s.text))).toEqual([]);
  });
});

describe('B2 getInvoice', () => {
  const data = (): Data => ({ invoices: () => [invRow(A, INV, 1)], lines: () => [lineRow(A)], subs: () => [subRow(A)] });
  it('200 InvoiceDetail: required keys present, nothing outside the schema, Money integers, buyer/seller as Party, lines with credited, totals with 7 Money', async () => {
    const { tx } = fakeTx(data());
    const out = await run('getInvoice', req({ params: { invoice_id: INV } }), hctx({ tx }));
    expect(out.status).toBe(200);
    const b = out.body;
    for (const k of DETAIL_REQUIRED) expect(Object.keys(b), k).toContain(k);
    expect(Object.keys(b).filter((k) => !DETAIL_ALLOWED.has(k))).toEqual([]);
    for (const k of FORBIDDEN) expect(Object.keys(b), k).not.toContain(k);
    expect(b).toMatchObject({ id: INV, invoice_no: '083/84-000001', series: 'INV', is_active: true, is_periodic_credit_bill: false, print_count: 1, cbms_state: 'pending', version: 2,
      issued_at: '2026-11-08T06:00:01.000Z', last_printed_at: '2026-11-08T06:01:00.000Z', credited_total: MONEY(0) });
    expect(b.buyer).toEqual({ name: 'Synthetic Buyer One', pan: '123456789', address: 'Synthetic Street 1' });
    expect(b.seller).toEqual({ name: 'Synthetic Lab Pvt Ltd', pan: '999999999', address: 'Synthetic Road 2' });
    expect(b.totals).toEqual({ gross: MONEY(100000), discount: MONEY(0), exempt: MONEY(0), taxable: MONEY(100000), vat: MONEY(13000), other_tax: MONEY(0), net: MONEY(113000) });
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]).toMatchObject({ line_no: 1, line_kind: 'orderable', code: 'CBC', quantity: 1, unit_price: MONEY(100000), vat: MONEY(13000), net: MONEY(113000), credited: MONEY(0) });
  });
  it('US-BL-13.1: cbms_submissions[] lists the stub attempt (kind invoice, attempt 1, client_mode stub, outcome stub_recorded) while cbms_state stays pending; raw status and external ref are not exposed', async () => {
    const { tx } = fakeTx(data());
    const b = (await run('getInvoice', req({ params: { invoice_id: INV } }), hctx({ tx }))).body;
    expect(b.cbms_submissions).toEqual([{ document_kind: 'invoice', attempt_no: 1, client_mode: 'stub', outcome: 'stub_recorded', submitted_at: '2026-11-08T06:02:00.000Z' }]);
    expect(b.cbms_state).toBe('pending');
    expect(JSON.stringify(b)).not.toContain('REDACTED-RAW-STATUS');
  });
  it('no submissions yet -> cbms_submissions is an empty array (never absent)', async () => {
    const { tx } = fakeTx({ ...data(), subs: () => [] });
    expect((await run('getInvoice', req({ params: { invoice_id: INV } }), hctx({ tx }))).body.cbms_submissions).toEqual([]);
  });
  it('unknown id and another tenant\'s invoice both -> 404 common.not_found (same answer, no existence leak)', async () => {
    const { tx } = fakeTx(data());
    expect((await fail(run('getInvoice', req({ params: { invoice_id: V7('0000000a9999') } }), hctx({ tx })))).code).toBe('common.not_found');
    expect((await fail(run('getInvoice', req({ params: { invoice_id: INV } }), hctx({ tx }, 'B')))).code).toBe('common.not_found');
  });
  it('a non-uuid id is refused before any query', async () => {
    const { tx, stmts } = fakeTx(data());
    for (const id of ['1; DROP TABLE x', '', undefined]) expect((await fail(run('getInvoice', req({ params: { invoice_id: id } }), hctx({ tx })))).code).toBe('common.validation_failed');
    expect(stmts.filter((s) => /billing\./i.test(s.text))).toEqual([]);
  });
  it('cancelled invoice: cancellation block with credit note number; is_active false', async () => {
    const cancelled = invRow(A, INV, 1, { status: 'cancelled', is_active: false, cancelled_at: new Date('2026-11-08T07:00:00.000Z'), cancelled_by: V7('000000030009'), cancel_reason_code: 'billing_error',
      credit_note_id: V7('000000c00001'), credited_total_paisa: '113000', cbms_cancel_state: 'pending' });
    const { tx } = fakeTx({ ...data(), invoices: () => [cancelled] });
    const b = (await run('getInvoice', req({ params: { invoice_id: INV } }), hctx({ tx }))).body;
    expect(b).toMatchObject({ status: 'cancelled', is_active: false, credited_total: MONEY(113000), cbms_cancel_state: 'pending' });
    expect(b.cancellation).toMatchObject({ cancelled_at: '2026-11-08T07:00:00.000Z', reason_code: 'billing_error', credit_note_id: V7('000000c00001') });
  });
});

describe('B7 getOrderBilling', () => {
  const data = (): Data => ({ invoices: () => [invRow(A, INV, 1)], balance: () => balRow(A) });
  it('200 OrderBillingDto: balance (integer Money, version, ISO as_of), eligibility, and every list present as an array', async () => {
    const { tx } = fakeTx(data());
    const out = await run('getOrderBilling', req({ params: { order_id: ORDER } }), hctx({ tx }));
    expect(out.status).toBe(200);
    expect(out.body.balance).toEqual({ order_id: ORDER, invoiced: MONEY(113000), paid: MONEY(100000), credited: MONEY(0), balance_due: MONEY(13000), balance_version: 2, as_of: '2026-11-08T06:03:00.000Z' });
    for (const k of ['invoices', 'credit_notes', 'ledger_entries', 'credit_charges', 'open_credit_note_tasks', 'open_finance_review_items', 'refund_requests']) expect(Array.isArray(out.body[k]), k).toBe(true);
    expect(out.body.invoices.map((i: any) => i.id)).toEqual([INV]);
    expect(Object.keys(out.body.invoices[0]).every((k) => SUMMARY_KEYS.includes(k))).toBe(true);
    expect(out.body.eligibility).toMatchObject({ order_id: ORDER, eligible: true, basis: 'policy_not_enforced', balance_due: MONEY(13000) }); // releaseRequiresPayment=false in the test ctx
    expect(typeof out.body.eligibility.evaluated_at).toBe('string');
    for (const k of FORBIDDEN) expect(JSON.stringify(out.body)).not.toContain(`"${k}"`);
  });
  it('order with neither balance row nor invoice, and another tenant\'s order -> 404 common.not_found', async () => {
    const { tx } = fakeTx({});
    expect((await fail(run('getOrderBilling', req({ params: { order_id: ORDER } }), hctx({ tx })))).code).toBe('common.not_found');
    const { tx: tx2 } = fakeTx(data());
    expect((await fail(run('getOrderBilling', req({ params: { order_id: ORDER } }), hctx({ tx: tx2 }, 'B')))).code).toBe('common.not_found');
  });
  it('every statement binds the caller tenant; a non-uuid order id is refused before any query', async () => {
    const { tx, stmts } = fakeTx(data());
    await run('getOrderBilling', req({ params: { order_id: ORDER } }), hctx({ tx }));
    for (const s of stmts.filter((x) => /billing\./i.test(x.text))) expect(s.values).toContain(A);
    const { tx: tx2, stmts: s2 } = fakeTx(data());
    expect((await fail(run('getOrderBilling', req({ params: { order_id: "x' OR '1'='1" } }), hctx({ tx: tx2 })))).code).toBe('common.validation_failed');
    expect(s2.filter((x) => /billing\./i.test(x.text))).toEqual([]);
  });
});

describe('B37 listInvoicePrints', () => {
  const data = (): Data => ({ invoices: () => [invRow(A, INV, 1)], prints: () => [printRow(A, 1), printRow(A, 2)] });
  it('200 InvoicePrintPage: print_no ascending, first is not a copy, later ones are; rows carry only print_no/is_copy/reason_code/printed_by_display/printed_at', async () => {
    const { tx } = fakeTx(data());
    const out = await run('listInvoicePrints', req({ params: { invoice_id: INV }, query: { limit: 50 } }), hctx({ tx }));
    expect(out.status).toBe(200);
    expect(out.body.page).toEqual({ limit: 50 });
    expect(out.body.data.map((r: any) => [r.print_no, r.is_copy, r.reason_code, r.printed_at])).toEqual([
      [1, false, 'first_print', '2026-11-08T06:01:00.000Z'], [2, true, 'reprint', '2026-11-08T06:02:00.000Z']]);
    for (const r of out.body.data) {
      expect(Object.keys(r).every((k) => ['print_no', 'is_copy', 'reason_code', 'printed_by_display', 'printed_at'].includes(k))).toBe(true);
      expect(typeof r.printed_by_display).toBe('string'); expect(r.printed_by_display.length).toBeGreaterThan(0);
      expect(r.printed_by_display).not.toMatch(/^[0-9a-f]{8}-/i); // a display name, never the raw user id
    }
  });
  it('unknown invoice or another tenant\'s invoice -> 404 common.not_found', async () => {
    const { tx } = fakeTx(data());
    expect((await fail(run('listInvoicePrints', req({ params: { invoice_id: V7('0000000a9999') } }), hctx({ tx })))).code).toBe('common.not_found');
    expect((await fail(run('listInvoicePrints', req({ params: { invoice_id: INV } }), hctx({ tx }, 'B')))).code).toBe('common.not_found');
  });
  it('only the print rows of THIS invoice and tenant are bound; non-uuid id refused', async () => {
    const { tx, stmts } = fakeTx(data());
    await run('listInvoicePrints', req({ params: { invoice_id: INV } }), hctx({ tx }));
    const q = stmts.find((s) => /billing\.print_log/i.test(s.text))!;
    expect(q.values).toContain(A); expect(q.values).toContain(INV); expect(q.text).toMatch(/document_kind/i);
    expect((await fail(run('listInvoicePrints', req({ params: { invoice_id: 'nope' } }), hctx({ tx })))).code).toBe('common.validation_failed');
  });
});
