// BL-T08 read handlers (contract tests): B11 listLedgerEntries, B16 listDues, B18 getDailyCash.
// Spec: 02-TRD §5 B11/B16/B18, openapi LedgerEntryPage/LedgerEntryDto, DuePage/DueRow, DailyCash; PRD US-BL-11.1 (per user x method entries/reversals/gross/net equal the ledger), US-BL-11.3
//   (home-collection and B22 credit-party payments appear in daily cash, never in a shift close); REQ-SEC-040/099. x-permission (billing.cash_report.read / billing.invoice.read) is enforced by the core pipeline.
// Fails now: handlers/index.ts maps all three operationIds to the BL-T01 stub (common.service_unavailable).
// Style = invoice.handlers.test.ts: the DB is a fake tx.query routed by the FROM table, row shapes as node-postgres returns them (timestamptz -> Date, bigint -> string).
// ASSUMED (writer: dispute if wrong):
//   B11: statement on billing.ledger_entries returns snake_case ledger rows (+ nothing else); handler orders by (created_at DESC, id DESC), limit+1 keyset cursor (opaque, <= 512 chars).
//   B16: one statement on billing.order_balances returns rows already shaped {order_id, registration_no, patient_display, centre_id, invoiced_paisa, paid_paisa, credited_paisa, balance_due_paisa, oldest_invoice_at}.
//        SPEC GAP: C4 billing has no registration_no / patient name column (they live on frontdesk.orders / patients, which 06-PLAN says billing does not read) - the source of those two fields is undecided.
//   B18: statements on billing.ledger_entries return RAW ledger rows of the business date (no SQL GROUP BY): the handler/service groups by (collected_by_membership_id, method_code) in code.
//        billing.cash_sessions rows return the sessions of that date; for a closed session `expected` / `counted` are jsonb arrays [{method_code, amount_paisa}] (same shape as the close request).
//        Money rule: entries = count(payment), reversals = count(reversal + refund), gross = Σ payment, reversed = |Σ reversal + refund|, net = gross - reversed (= billing.v_pub_payment_collection, 05-SCHEMA:1788-1794).
//   display_name of collected_by: source unspecified (IdentityPort offers getActor for the caller only) -> tests only require a string.
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { handlers } from '../index.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const ORDER = V7('000000050001'), ORDER2 = V7('000000050002'), CENTRE = V7('000000020002'), BRANCH = V7('000000010001'), M1 = V7('000000030001'), M2 = V7('000000030002'), SESSION = V7('0000000d0001');
const M = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const A = makeCtxFor()('A').tenantId as string;
const B = makeCtxFor()('B').tenantId as string;

let seq = 0;
const led = (tenant: string, over: Record<string, unknown> = {}) => ({
  id: V7(`0000000e${String(++seq).padStart(4, '0')}`), tenant_id: tenant, branch_id: BRANCH, centre_id: CENTRE, order_id: ORDER, invoice_id: V7('000000a00001'), credit_party_id: null, entry_kind: 'payment', capture_kind: 'manual',
  method_code: 'cash', amount_paisa: '100000', reverses_entry_id: null, reason_code: null, reason_text: null, reference_text: null, gateway: null, gateway_txn_ref: null, intent_id: null, receipt_no: null, receipt_seq: null,
  fiscal_year_bs: '2083/84', cash_session_id: SESSION, collected_by_membership_id: M1, approved_by_membership_id: null, refund_request_id: null, idempotency_key: `idem-${seq}`, captured_at_device: null,
  business_date: '2026-11-08', is_active: true, created_at: new Date(`2026-11-08T06:${String(10 + seq).padStart(2, '0')}:00.000Z`), created_by: M1, ...over,
});
const sessRow = (tenant: string, over: Record<string, unknown> = {}) => ({
  id: SESSION, tenant_id: tenant, branch_id: BRANCH, centre_id: CENTRE, membership_id: M1, status: 'closed', opened_at: new Date('2026-11-08T04:00:00.000Z'), closed_at: new Date('2026-11-08T10:00:00.000Z'),
  expected: [{ method_code: 'cash', amount_paisa: 1050000 }], counted: [{ method_code: 'cash', amount_paisa: 1045000 }], variance_paisa: '-5000', close_note: 'short', version: 2, is_active: true, created_by: M1, ...over,
});
const dueRow = (tenant: string, n: number, over: Record<string, unknown> = {}) => ({
  tenant_id: tenant, order_id: n === 1 ? ORDER : ORDER2, registration_no: `R-0001-00000${n}`, patient_display: `Demo Patient ${n}`, centre_id: CENTRE, invoiced_paisa: '225000', paid_paisa: '100000', credited_paisa: '0',
  balance_due_paisa: '125000', oldest_invoice_at: new Date('2026-11-05T04:15:00.000Z'), ...over,
});

interface Data { ledger?: any[]; sessions?: any[]; dues?: any[] }
function fakeTx(d: Data) {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  const mine = (rows: any[], values: unknown[]) => rows.filter((r) => values.includes(r.tenant_id));
  const tx = {
    async query(text: string, values: unknown[] = []) {
      stmts.push({ text, values });
      const t = (name: string) => new RegExp(`\\bbilling\\.${name}\\b`, 'i').test(text);
      if (t('order_balances')) return { rows: mine(d.dues ?? [], values) };
      if (t('ledger_entries')) return { rows: mine(d.ledger ?? [], values) };
      if (t('cash_sessions')) return { rows: mine(d.sessions ?? [], values) };
      return { rows: [] };
    },
  };
  return { tx, stmts };
}
const identity = { getActor: async () => ({ displayName: 'Synthetic Cashier' }), getTenantSettings: async () => ({ timezone: 'Asia/Kathmandu', releaseRequiresPayment: true }) };
const hctx = (extra: Record<string, unknown> = {}, tenant: 'A' | 'B' = 'A') => ({
  operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
  ...makeCtxFor()(tenant, { ports: { IdentityPort: identity } as never }), now: () => '2026-11-08T06:00:00.000Z', ...extra,
}) as never;
const req = (o: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o }) as never;
type Op = 'listLedgerEntries' | 'listDues' | 'getDailyCash';
const run = (op: Op, r: unknown, c: unknown) => (handlers[op] as any)(r, c);
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const billingStmts = (s: Array<{ text: string }>) => s.filter((x) => /billing\./i.test(x.text));

describe('fail closed without an authenticated request context (REQ-SEC-099)', () => {
  for (const op of ['listLedgerEntries', 'listDues', 'getDailyCash'] as const)
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated (not the BL-T01 503 stub)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(op, req(), bare))).code).toBe('auth.unauthenticated');
    });
});

describe('B11 listLedgerEntries', () => {
  const ENTRY_ALLOWED = new Set(['id', 'entry_kind', 'capture_kind', 'order_id', 'invoice_id', 'credit_party_id', 'method_code', 'amount', 'reference_masked', 'receipt_no', 'reverses_entry_id', 'collected_by', 'cash_session_id', 'created_at', 'business_date_bs']);
  const FORBIDDEN = ['tenant_id', 'idempotency_key', 'created_by', 'fiscal_year_bs', 'branch_id', 'centre_id', 'gateway_txn_ref', 'intent_id', 'approved_by_membership_id', 'receipt_seq', 'captured_at_device', 'is_active', 'reference_text'];
  const rows = (t: string) => [
    led(t, { receipt_no: 'RC-083/84-000001', reference_text: 'POS-AB12', method_code: 'card' }),
    led(t, { entry_kind: 'reversal', amount_paisa: '-30000', reverses_entry_id: V7('0000000e9999'), reason_code: 'wrong_amount' }),
    led(t, { capture_kind: 'gateway', gateway: 'esewa', gateway_txn_ref: 'TXN-1', intent_id: V7('0000000aa001'), collected_by_membership_id: null, cash_session_id: null, method_code: 'esewa' }),
  ];
  it('200 LedgerEntryPage: LedgerEntryDto keys only, signed integer Money, B.S. business date, ISO created_at, reference_masked, receipt_no, no internal columns', async () => {
    const { tx } = fakeTx({ ledger: rows(A) });
    const out = await run('listLedgerEntries', req({ query: { limit: 50 } }), hctx({ tx }));
    expect(out.status).toBe(200); expect(out.body.page).toEqual({ limit: 50 }); expect(out.body.data).toHaveLength(3);
    for (const d of out.body.data) { expect(Object.keys(d).filter((k) => !ENTRY_ALLOWED.has(k)), d.id).toEqual([]); for (const k of FORBIDDEN) expect(Object.keys(d), k).not.toContain(k); }
    const [pay, rev] = out.body.data;
    expect(pay).toMatchObject({ entry_kind: 'payment', capture_kind: 'manual', order_id: ORDER, method_code: 'card', amount: M(100000), receipt_no: 'RC-083/84-000001', reference_masked: 'POS-AB12',
      cash_session_id: SESSION, business_date_bs: '2083-07-22', collected_by: { membership_id: M1, display_name: expect.any(String) } });
    expect(pay.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(rev).toMatchObject({ entry_kind: 'reversal', amount: M(-30000), reverses_entry_id: V7('0000000e9999') });
  });
  it('gateway rows carry no collected_by and no cash_session_id (08 R8)', async () => {
    const { tx } = fakeTx({ ledger: rows(A) });
    const g = (await run('listLedgerEntries', req({ query: { limit: 50 } }), hctx({ tx }))).body.data[2];
    expect(g.capture_kind).toBe('gateway'); expect(g.collected_by).toBeUndefined(); expect(g.cash_session_id).toBeUndefined();
  });
  it('limit 2 of 3 -> 2 rows and an opaque next_cursor (<= 512); fewer rows than limit -> none', async () => {
    const { tx } = fakeTx({ ledger: rows(A) });
    const out = await run('listLedgerEntries', req({ query: { limit: 2 } }), hctx({ tx }));
    expect(out.body.data).toHaveLength(2); expect(out.body.page.limit).toBe(2);
    expect(typeof out.body.page.next_cursor).toBe('string'); expect(out.body.page.next_cursor.length).toBeLessThanOrEqual(512);
    const { tx: tx2 } = fakeTx({ ledger: rows(A).slice(0, 1) });
    expect((await run('listLedgerEntries', req({ query: { limit: 2 } }), hctx({ tx: tx2 }))).body.page.next_cursor).toBeUndefined();
  });
  it('malformed cursor -> common.invalid_cursor (400) before any billing query', async () => {
    const { tx, stmts } = fakeTx({ ledger: rows(A) });
    for (const cursor of ['%%%not-a-cursor', 'x'.repeat(600), '{"a":1}']) {
      const e = await fail(run('listLedgerEntries', req({ query: { cursor, limit: 10 } }), hctx({ tx })));
      expect(['common.invalid_cursor', 'common.validation_failed'], cursor.slice(0, 12)).toContain(e.code);
    }
    expect(billingStmts(stmts)).toEqual([]);
  });
  it('tenant scoping: every billing statement binds ctx.tenantId; another tenant\'s entries are never returned', async () => {
    const { tx, stmts } = fakeTx({ ledger: [...rows(A), ...rows(B)] });
    const out = await run('listLedgerEntries', req({ query: { limit: 50 } }), hctx({ tx }, 'A'));
    expect(out.body.data).toHaveLength(3);
    const q = billingStmts(stmts); expect(q.length).toBeGreaterThan(0);
    for (const s of q) { expect(s.values).toContain(A); expect(s.values).not.toContain(B); expect(s.text).toMatch(/tenant_id/i); }
  });
  it('filters travel as bound values only (collected_by_membership_id, method_code, centre_id, entry_kind, created_at range); a hostile method_code is never in the SQL text; id is the final sort key', async () => {
    const evil = "cash'; DROP TABLE billing.ledger_entries; --";
    const { tx, stmts } = fakeTx({ ledger: rows(A) });
    await run('listLedgerEntries', req({ query: { collected_by_membership_id: M1, method_code: evil, centre_id: CENTRE, entry_kind: 'payment', created_at_from: '2026-11-08T00:00:00.000Z', created_at_to: '2026-11-08T23:59:59.000Z', limit: 10 } }), hctx({ tx }));
    const q = stmts.find((s) => /billing\.ledger_entries/i.test(s.text))!;
    expect(q.text).not.toContain('DROP TABLE'); expect(q.text).not.toContain(evil);
    expect(q.values).toContain(evil); expect(q.values).toContain(M1); expect(q.values).toContain(CENTRE); expect(q.values).toContain('payment');
    expect(q.text).toMatch(/ORDER\s+BY[\s\S]*\bid\b/i);
  });
  it('an unknown entry_kind, a non-uuid collected_by_membership_id or an inverted created_at range is refused (400 common.validation_failed) with no billing query', async () => {
    const { tx, stmts } = fakeTx({ ledger: rows(A) });
    for (const query of [{ entry_kind: 'gift' }, { collected_by_membership_id: 'abc' }, { created_at_from: '2026-11-09T00:00:00.000Z', created_at_to: '2026-11-08T00:00:00.000Z' }, { created_at_from: 'yesterday' }]) {
      expect((await fail(run('listLedgerEntries', req({ query }), hctx({ tx })))).code, JSON.stringify(query)).toBe('common.validation_failed');
    }
    expect(billingStmts(stmts)).toEqual([]);
  });
});

describe('B16 listDues', () => {
  const ALLOWED = new Set(['order_id', 'registration_no', 'patient_display', 'centre_id', 'invoiced', 'paid', 'credited', 'balance_due', 'oldest_invoice_at']);
  it('200 DuePage: DueRow keys only, Money integers, ISO oldest_invoice_at, nothing else (no tenant_id, no patient id)', async () => {
    const { tx } = fakeTx({ dues: [dueRow(A, 1), dueRow(A, 2, { balance_due_paisa: '50000', paid_paisa: '175000' })] });
    const out = await run('listDues', req({ query: { limit: 50 } }), hctx({ tx }));
    expect(out.status).toBe(200); expect(out.body.page).toEqual({ limit: 50 }); expect(out.body.data).toHaveLength(2);
    for (const d of out.body.data) expect(Object.keys(d).filter((k) => !ALLOWED.has(k))).toEqual([]);
    expect(out.body.data[0]).toEqual({ order_id: ORDER, registration_no: 'R-0001-000001', patient_display: 'Demo Patient 1', centre_id: CENTRE, invoiced: M(225000), paid: M(100000), credited: M(0),
      balance_due: M(125000), oldest_invoice_at: '2026-11-05T04:15:00.000Z' });
    expect(out.body.data[1].balance_due).toEqual(M(50000));
  });
  it('pagination: limit 1 of 2 -> next_cursor; malformed cursor -> common.invalid_cursor before any billing query', async () => {
    const { tx, stmts } = fakeTx({ dues: [dueRow(A, 1), dueRow(A, 2)] });
    const out = await run('listDues', req({ query: { limit: 1 } }), hctx({ tx }));
    expect(out.body.data).toHaveLength(1); expect(typeof out.body.page.next_cursor).toBe('string');
    stmts.length = 0;
    const e = await fail(run('listDues', req({ query: { cursor: '%%%', limit: 10 } }), hctx({ tx })));
    expect(['common.invalid_cursor', 'common.validation_failed']).toContain(e.code); expect(billingStmts(stmts)).toEqual([]);
  });
  it('tenant scoping and bound filters: centre_id / min_due_paisa / older_than_days only as values', async () => {
    const { tx, stmts } = fakeTx({ dues: [dueRow(A, 1), dueRow(B, 2)] });
    const out = await run('listDues', req({ query: { centre_id: CENTRE, min_due_paisa: 10000, older_than_days: 7, limit: 10 } }), hctx({ tx }, 'A'));
    expect(out.body.data).toHaveLength(1); expect(out.body.data[0].order_id).toBe(ORDER);
    const q = stmts.find((s) => /billing\.order_balances/i.test(s.text))!;
    expect(q.values).toContain(A); expect(q.values).not.toContain(B); expect(q.values).toContain(CENTRE); expect(q.values).toContain(10000); expect(q.values).toContain(7);
    expect(q.text).toMatch(/tenant_id/i); expect(q.text).toMatch(/ORDER\s+BY/i);
  });
  it('invalid filters (negative min_due_paisa, older_than_days 4000, non-uuid centre_id, fractional) -> common.validation_failed, no billing query', async () => {
    const { tx, stmts } = fakeTx({ dues: [dueRow(A, 1)] });
    for (const query of [{ min_due_paisa: -1 }, { older_than_days: 4000 }, { centre_id: 'c' }, { min_due_paisa: 1.5 }, { limit: 0 }, { limit: 201 }])
      expect((await fail(run('listDues', req({ query }), hctx({ tx })))).code, JSON.stringify(query)).toBe('common.validation_failed');
    expect(billingStmts(stmts)).toEqual([]);
  });
});

describe('B18 getDailyCash', () => {
  const day = (t: string) => [
    led(t, { collected_by_membership_id: M1, method_code: 'cash', amount_paisa: '100000' }),
    led(t, { collected_by_membership_id: M1, method_code: 'cash', amount_paisa: '50000' }),
    led(t, { collected_by_membership_id: M1, method_code: 'cash', entry_kind: 'reversal', amount_paisa: '-30000', reverses_entry_id: V7('0000000e9999'), reason_code: 'wrong_amount' }),
    led(t, { collected_by_membership_id: M1, method_code: 'card', amount_paisa: '70000', reference_text: 'POS-1' }),
    led(t, { collected_by_membership_id: M2, method_code: 'cash', amount_paisa: '20000' }),
    // US-BL-11.3: no session, still in daily cash
    led(t, { collected_by_membership_id: M2, capture_kind: 'home_collection', cash_session_id: null, method_code: 'cash', amount_paisa: '5000' }),
    led(t, { collected_by_membership_id: M2, order_id: null, credit_party_id: V7('0000000f0001'), invoice_id: V7('000000a00009'), cash_session_id: null, method_code: 'bank_transfer', amount_paisa: '900000' }),
  ];
  const find = (body: any, who: string, method: string) => body.rows.find((r: any) => r.collected_by.membership_id === who && r.method_code === method);

  it('US-BL-11.1: rows per user x method: entries, reversals, gross, reversed, net match the ledger exactly; totals are the column sums', async () => {
    const { tx } = fakeTx({ ledger: day(A) });
    const out = await run('getDailyCash', req({ query: { business_date: '2026-11-08' } }), hctx({ tx }));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ business_date: '2026-11-08', business_date_bs: '2083-07-22' });
    const c1 = find(out.body, M1, 'cash');
    expect(c1).toMatchObject({ entries: 2, reversals: 1, gross: M(150000), net: M(120000) }); expect(Math.abs(c1.reversed.amount_paisa)).toBe(30000);
    expect(find(out.body, M1, 'card')).toMatchObject({ entries: 1, reversals: 0, gross: M(70000), net: M(70000) });
    expect(find(out.body, M2, 'cash')).toMatchObject({ entries: 2, reversals: 0, gross: M(25000), net: M(25000) });
    for (const r of out.body.rows) expect(r.collected_by).toMatchObject({ membership_id: expect.any(String), display_name: expect.any(String) });
    const sum = (k: string) => out.body.rows.reduce((t: number, r: any) => t + Math.abs(r[k].amount_paisa), 0);
    expect(out.body.totals.gross.amount_paisa).toBe(sum('gross')); expect(out.body.totals.reversed.amount_paisa).toBe(sum('reversed')); expect(out.body.totals.net.amount_paisa).toBe(sum('net'));
    expect(out.body.totals.net.amount_paisa).toBe(out.body.totals.gross.amount_paisa - Math.abs(out.body.totals.reversed.amount_paisa));
    expect(out.body.totals.gross).toEqual(M(100000 + 50000 + 70000 + 20000 + 5000 + 900000));
  });
  it('US-BL-11.1: a refund pay-out counts as a reversal and lowers net, like billing.v_pub_payment_collection (entry_kind IN reversal, refund)', async () => {
    const { tx } = fakeTx({ ledger: [
      led(A, { collected_by_membership_id: M1, method_code: 'cash', amount_paisa: '100000' }),
      led(A, { collected_by_membership_id: M1, method_code: 'cash', entry_kind: 'reversal', amount_paisa: '-30000', reverses_entry_id: V7('0000000e9999'), reason_code: 'wrong_amount' }),
      led(A, { collected_by_membership_id: M1, method_code: 'cash', entry_kind: 'refund', amount_paisa: '-20000', reason_code: 'overcharge', approved_by_membership_id: M2, refund_request_id: V7('0000000b0001') }),
    ] });
    const out = await run('getDailyCash', req({ query: { business_date: '2026-11-08' } }), hctx({ tx }));
    const c = find(out.body, M1, 'cash');
    expect(c).toMatchObject({ entries: 1, reversals: 2, gross: M(100000), net: M(50000) }); expect(Math.abs(c.reversed.amount_paisa)).toBe(50000);
    expect(out.body.totals.net.amount_paisa).toBe(50000);
  });
  it('US-BL-11.3: home_collection and B22 credit-party rows (no cash session) are in daily cash', async () => {
    const { tx } = fakeTx({ ledger: day(A) });
    const out = await run('getDailyCash', req({ query: { business_date: '2026-11-08' } }), hctx({ tx }));
    expect(find(out.body, M2, 'bank_transfer')).toMatchObject({ entries: 1, gross: M(900000) });
    expect(find(out.body, M2, 'cash').entries).toBe(2); // 20,000 session payment + 5,000 home collection
  });
  it('sessions[]: CashSessionDto per session of the day, closed ones with counted/variance per method and the opener; no tenant ids', async () => {
    const { tx } = fakeTx({ ledger: day(A), sessions: [sessRow(A)] });
    const s = (await run('getDailyCash', req({ query: { business_date: '2026-11-08' } }), hctx({ tx }))).body.sessions;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: SESSION, centre_id: CENTRE, status: 'closed', opened_at: '2026-11-08T04:00:00.000Z', closed_at: '2026-11-08T10:00:00.000Z', note: 'short', version: 2,
      opened_by: { membership_id: M1, display_name: expect.any(String) } });
    expect(s[0].rows).toEqual([{ method_code: 'cash', expected: M(1050000), counted: M(1045000), variance: M(-5000) }]);
    for (const k of ['tenant_id', 'membership_id', 'variance_paisa', 'created_by']) expect(Object.keys(s[0]), k).not.toContain(k);
  });
  it('no business_date -> today in the tenant timezone (ctx.now = 2026-11-08T06:00Z -> 2026-11-08 / 2083-07-22); empty day -> rows [], totals 0, sessions []', async () => {
    const { tx } = fakeTx({});
    const out = await run('getDailyCash', req(), hctx({ tx }));
    expect(out.body).toEqual({ business_date: '2026-11-08', business_date_bs: '2083-07-22', rows: [], totals: { gross: M(0), reversed: M(0), net: M(0) }, sessions: [] });
  });
  it('filters (business_date, centre_id, collected_by_membership_id) travel as bound values; every billing statement binds the tenant; other tenants\' rows are not counted', async () => {
    const { tx, stmts } = fakeTx({ ledger: [...day(A), ...day(B)] });
    const out = await run('getDailyCash', req({ query: { business_date: '2026-11-08', centre_id: CENTRE, collected_by_membership_id: M1 } }), hctx({ tx }, 'A'));
    expect(out.body.rows.length).toBeGreaterThan(0);
    const q = billingStmts(stmts); expect(q.length).toBeGreaterThan(0);
    for (const s of q) { expect(s.values).toContain(A); expect(s.values).not.toContain(B); expect(s.text).toMatch(/tenant_id/i); }
    const l = stmts.find((s) => /billing\.ledger_entries/i.test(s.text))!;
    expect(l.values).toEqual(expect.arrayContaining(['2026-11-08', CENTRE, M1]));
  });
  it('invalid business_date (2026-13-45, "today", datetime) or non-uuid ids -> common.validation_failed, no billing query', async () => {
    const { tx, stmts } = fakeTx({ ledger: day(A) });
    for (const query of [{ business_date: '2026-13-45' }, { business_date: 'today' }, { business_date: '2026-11-08T00:00:00Z' }, { centre_id: 'x' }, { collected_by_membership_id: 'x' }])
      expect((await fail(run('getDailyCash', req({ query }), hctx({ tx })))).code, JSON.stringify(query)).toBe('common.validation_failed');
    expect(billingStmts(stmts)).toEqual([]);
  });
  it('rows are free of reference text and idempotency keys (no card-slip data in a report)', async () => {
    const { tx } = fakeTx({ ledger: day(A) });
    const body = JSON.stringify((await run('getDailyCash', req({ query: { business_date: '2026-11-08' } }), hctx({ tx }))).body);
    expect(body).not.toMatch(/POS-1|idem-/);
  });
});
