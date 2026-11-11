// BL-T17 live-DB integration (done_when "Nightly check detects planted gap"; plan row: "test inserts as owner"; US-BL-01.1/.3/.5; 02-TRD §10, §15).
// Skipped unless LIMS_TEST_DATABASE_URL (superuser URL of a migrated + seeded DB; tenant 01a1a98a-ac40-7000-8000-00000000a001, branch ...a101, centre ...a201) is set.
// Tasks run through a hand-built JobContext whose tx is a pg client in a transaction with system claims; ctx.now() is controlled.
// ASSUMED (spec silent): violation metric = ctx.metrics.inc('lims_billing_integrity_violations_total', { tenant_id, check }, by?) with
//   check = 'seq_gap' (count != max(seq) or non-contiguous), 'print_count' (print_count != count(print_log)); the task resolves (does not throw) on a violation.
// Fixtures: series INV:BLT17* in FY 2099/00 (integrity) and FYs 2080/81..2082/83 for the counter prepare cases; removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SU = process.env['LIMS_TEST_DATABASE_URL'];
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', BRANCH = '01a1a98a-ac40-7000-8000-00000000a101', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const PREP = 'billing.fiscal_counter_prepare', CHECK = 'billing.integrity_check', METRIC = 'lims_billing_integrity_violations_total';
const FY = '2099/00', S_GAP = 'INV:BLT17G', S_PRINT = 'INV:BLT17P';
const uid = (n: number) => `0190c417-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PREP_FYS = ['2080/81', '2081/82', '2082/83'];

const invoice = (id: string, series: string, seq: number, over: Record<string, unknown> = {}) => ({
  id, tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, series, fiscal_year_bs: FY, invoice_seq: seq, invoice_no: `INV-BLT17-${series.slice(-1)}-${seq}`,
  invoice_kind: 'tax_invoice', purpose: 'registration', order_id: uid(100 + seq + (series === S_GAP ? 0 : 50)), patient_id: uid(200 + seq), buyer_name: 'Test Patient (SYNTHETIC)',
  seller_name: 'Synthetic Lab', issued_at: new Date(Date.now() - (30 - seq) * 60_000).toISOString(), invoice_date_bs: '2099-01-01', gross_paisa: 1000, discount_paisa: 0,
  exempt_paisa: 1000, taxable_paisa: 0, vat_paisa: 0, other_tax_paisa: 0, net_paisa: 1000, prices_include_tax: false, quote_fingerprint: 'a'.repeat(64),
  cbms_state: 'not_required', created_by: SYS, updated_by: SYS, ...over,
});
const counter = (series: string, fy: string, last_no: number) => ({ tenant_id: TENANT, series, fiscal_year_bs: fy, last_no, created_by: SYS, updated_by: SYS });

describe.skipIf(!SU)('billing.fiscal_counter_prepare + billing.integrity_check over a real DB', () => {
  let su: any;
  let manifest: any;

  async function asSystem(stmts: Array<[string, unknown[]?]>) {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      for (const [t, v] of stmts) await c.query(t, v);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  // explicit column list so omitted columns take their table DEFAULTs (a bare SELECT * would insert NULLs)
  const ins = (table: string, row: object): [string, unknown[]] => {
    const cols = Object.keys(row).join(', ');
    return [`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)]];
  };
  const S_RC = 'RC';
  const receipt = (id: string, seq: number) => ({
    id, tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, order_id: uid(700 + seq), entry_kind: 'payment', capture_kind: 'gateway', method_code: 'esewa',
    amount_paisa: 1000, gateway: 'esewa', gateway_txn_ref: `BLT17-TXN-${seq}`, intent_id: uid(800 + seq), receipt_no: `RC-BLT17-${seq}`, receipt_seq: seq,
    fiscal_year_bs: FY, business_date: '2099-01-01', created_by: SYS,
  });

  /** Run a task in one transaction with system claims for TENANT; returns the metric calls it made. */
  async function run(id: string, now = new Date().toISOString()) {
    const c = await su.connect(); const inc: Array<{ name: string; labels: any; by: number }> = [];
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      const ctx: any = {
        tenantId: TENANT, tx: c, actor: { type: 'system', id: SYS }, requestId: uid(900), attempt: 1, maxAttempts: 1, jobId: '1', now: () => now, isNewer: () => true,
        events: {}, core: {}, storage: {}, files: {}, audit: {}, log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
        metrics: { inc: (name: string, labels: any = {}, by = 1) => { inc.push({ name, labels, by }); }, set() {}, observe() {} },
      };
      ctx.db = { tx: async (fn: any) => fn(ctx) };
      await manifest.tasks[id]({ tenant_id: TENANT }, ctx);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    return inc;
  }
  const violations = (inc: Array<{ name: string; labels: any; by: number }>, check: string) =>
    inc.filter((m) => m.name === METRIC && m.labels.tenant_id === TENANT && m.labels.check === check).reduce((n, m) => n + m.by, 0);
  const q = async (sql: string, v: unknown[] = []) => (await su.query(sql, v)).rows;

  async function cleanup() {
    await asSystem([
      [`DELETE FROM billing.print_log WHERE tenant_id = $1 AND document_id = ANY($2)`, [TENANT, [uid(1), uid(2), uid(3), uid(51), uid(52)]]],
      [`DELETE FROM billing.order_balances WHERE tenant_id = $1 AND order_id = $2`, [TENANT, uid(750)]],
      [`DELETE FROM billing.credit_notes WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
      [`DELETE FROM billing.ledger_entries WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
      [`DELETE FROM billing.invoices WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
      [`DELETE FROM billing.fiscal_counters WHERE tenant_id = $1 AND (fiscal_year_bs = $2 OR fiscal_year_bs = ANY($3))`, [TENANT, FY, PREP_FYS]],
    ]);
  }

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    su = new (pg.default ?? pg).Pool({ connectionString: SU, max: 3 });
    manifest = (await import('../index.js')).manifest;
    await cleanup();
  });
  afterAll(async () => { if (su) await cleanup().catch(() => undefined); await su?.end(); });

  describe('integrity_check', () => {
    it('detects a planted gap (invoices 1 and 3, counter 3) and a print_count without print_log rows; reports, never fixes', async () => {
      const base = await run(CHECK);
      const baseGap = violations(base, 'seq_gap'), basePrint = violations(base, 'print_count');
      // gap: counter must move +1 at a time (guard), so seq 2 is simply never inserted as an invoice
      await asSystem([ins('billing.fiscal_counters', counter(S_GAP, FY, 1)), ins('billing.invoices', invoice(uid(1), S_GAP, 1))]);
      await asSystem([[`UPDATE billing.fiscal_counters SET last_no = 2 WHERE tenant_id = $1 AND series = $2 AND fiscal_year_bs = $3`, [TENANT, S_GAP, FY]]]);
      await asSystem([[`UPDATE billing.fiscal_counters SET last_no = 3 WHERE tenant_id = $1 AND series = $2 AND fiscal_year_bs = $3`, [TENANT, S_GAP, FY]],
        ins('billing.invoices', invoice(uid(3), S_GAP, 3))]);
      // print_count 2 on insert (guards only watch UPDATE), but the print_log is empty
      await asSystem([ins('billing.fiscal_counters', counter(S_PRINT, FY, 1)), ins('billing.invoices', invoice(uid(51), S_PRINT, 1, { print_count: 2 }))]);

      const inc = await run(CHECK);
      expect(violations(inc, 'seq_gap')).toBeGreaterThan(baseGap);
      expect(violations(inc, 'print_count')).toBeGreaterThan(basePrint);

      // never auto-fix: counter, invoices and (absent) print_log rows are exactly as planted
      expect((await q(`SELECT last_no FROM billing.fiscal_counters WHERE tenant_id=$1 AND series=$2 AND fiscal_year_bs=$3`, [TENANT, S_GAP, FY]))[0].last_no).toBe(3);
      expect((await q(`SELECT invoice_seq FROM billing.invoices WHERE tenant_id=$1 AND series=$2 ORDER BY invoice_seq`, [TENANT, S_GAP])).map((r: any) => r.invoice_seq)).toEqual([1, 3]);
      expect((await q(`SELECT print_count FROM billing.invoices WHERE id=$1`, [uid(51)]))[0].print_count).toBe(2);
      expect(await q(`SELECT 1 FROM billing.print_log WHERE tenant_id=$1 AND document_id=$2`, [TENANT, uid(51)])).toHaveLength(0);
    });

    it('is idempotent: a second run reports the same violations again (the alert keeps firing until a human fixes it)', async () => {
      const a = await run(CHECK), b = await run(CHECK);
      expect(violations(b, 'seq_gap')).toBe(violations(a, 'seq_gap'));
      expect(violations(b, 'print_count')).toBe(violations(a, 'print_count'));
    });

    it('once the planted rows are gone the violation count returns to the pre-plant baseline (a contiguous series is clean)', async () => {
      const dirty = await run(CHECK);
      await asSystem([[`DELETE FROM billing.invoices WHERE tenant_id=$1 AND fiscal_year_bs=$2`, [TENANT, FY]], [`DELETE FROM billing.fiscal_counters WHERE tenant_id=$1 AND fiscal_year_bs=$2`, [TENANT, FY]]]);
      const clean = await run(CHECK);
      expect(violations(clean, 'seq_gap')).toBeLessThan(violations(dirty, 'seq_gap'));
      expect(violations(clean, 'print_count')).toBeLessThan(violations(dirty, 'print_count'));
      // contiguous 1..3 with matching print_log (one print for invoice 2) adds nothing
      await asSystem([ins('billing.fiscal_counters', counter(S_GAP, FY, 1)), ins('billing.invoices', invoice(uid(1), S_GAP, 1))]);
      await asSystem([[`UPDATE billing.fiscal_counters SET last_no = 2 WHERE tenant_id=$1 AND series=$2 AND fiscal_year_bs=$3`, [TENANT, S_GAP, FY]], ins('billing.invoices', invoice(uid(2), S_GAP, 2))]);
      await asSystem([[`UPDATE billing.fiscal_counters SET last_no = 3 WHERE tenant_id=$1 AND series=$2 AND fiscal_year_bs=$3`, [TENANT, S_GAP, FY]], ins('billing.invoices', invoice(uid(3), S_GAP, 3))]);
      expect(violations(await run(CHECK), 'seq_gap')).toBe(violations(clean, 'seq_gap'));
    });
  });

  describe('integrity_check: receipts + paid recomputation (review BL-T17 items 1-2)', () => {
    it('detects a planted RC gap (receipts 1 and 3 in ledger_entries, counter 3) and a paid_paisa that differs from the ledger sum; reports, never fixes', async () => {
      await cleanup();
      const base = await run(CHECK);
      const baseGap = violations(base, 'seq_gap'), baseBal = violations(base, 'order_balance');
      // RC: counter moves +1 at a time (guard); receipt 2 is simply never written
      await asSystem([ins('billing.fiscal_counters', counter(S_RC, FY, 1)), ins('billing.ledger_entries', receipt(uid(61), 1))]);
      await asSystem([[`UPDATE billing.fiscal_counters SET last_no = 2 WHERE tenant_id = $1 AND series = $2 AND fiscal_year_bs = $3`, [TENANT, S_RC, FY]]]);
      await asSystem([[`UPDATE billing.fiscal_counters SET last_no = 3 WHERE tenant_id = $1 AND series = $2 AND fiscal_year_bs = $3`, [TENANT, S_RC, FY]],
        ins('billing.ledger_entries', receipt(uid(63), 3))]);
      // paid mismatch: balance row claims 500 paid for an order with no ledger entries and no invoices (invoiced/credited agree at 0)
      await asSystem([ins('billing.order_balances', { tenant_id: TENANT, order_id: uid(750), centre_id: CENTRE, billing_mode: 'cash', paid_paisa: 500, created_by: SYS, updated_by: SYS })]);

      const inc = await run(CHECK);
      expect(violations(inc, 'seq_gap')).toBeGreaterThan(baseGap);        // visible only if RC is checked against ledger_entries.receipt_seq
      expect(violations(inc, 'order_balance')).toBeGreaterThan(baseBal);  // visible only if paid_paisa is recomputed from ledger_entries

      expect((await q(`SELECT last_no FROM billing.fiscal_counters WHERE tenant_id=$1 AND series=$2 AND fiscal_year_bs=$3`, [TENANT, S_RC, FY]))[0].last_no).toBe(3);
      expect((await q(`SELECT receipt_seq FROM billing.ledger_entries WHERE tenant_id=$1 AND fiscal_year_bs=$2 ORDER BY receipt_seq`, [TENANT, FY])).map((r: any) => r.receipt_seq)).toEqual([1, 3]);
      expect(Number((await q(`SELECT paid_paisa FROM billing.order_balances WHERE tenant_id=$1 AND order_id=$2`, [TENANT, uid(750)]))[0].paid_paisa)).toBe(500);
    });

    it('a contiguous RC series 1..2 whose paid_paisa equals the ledger sum adds no violations', async () => {
      await cleanup();
      const base = await run(CHECK);
      await asSystem([ins('billing.fiscal_counters', counter(S_RC, FY, 1)), ins('billing.ledger_entries', receipt(uid(61), 1))]);
      await asSystem([[`UPDATE billing.fiscal_counters SET last_no = 2 WHERE tenant_id = $1 AND series = $2 AND fiscal_year_bs = $3`, [TENANT, S_RC, FY]],
        ins('billing.ledger_entries', { ...receipt(uid(62), 2), order_id: uid(750) })]);
      await asSystem([ins('billing.order_balances', { tenant_id: TENANT, order_id: uid(750), centre_id: CENTRE, billing_mode: 'cash', paid_paisa: 1000, created_by: SYS, updated_by: SYS })]);
      const inc = await run(CHECK);
      expect(violations(inc, 'seq_gap')).toBe(violations(base, 'seq_gap'));
      expect(violations(inc, 'order_balance')).toBe(violations(base, 'order_balance'));
    });
  });

  describe('integrity_check: credited via credit_notes.invoice_id (review BL-T17 round 2, TRD "Balance:")', () => {
    const S_CN = 'INV:BLT17C', CN = 'CN';
    const cnInvoice = () => invoice(uid(5), S_CN, 1, { order_id: uid(750) });
    // credit_notes.order_id is nullable; the credit note is tied to the order only through its invoice
    const creditNote = () => ({
      id: uid(71), tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, series: CN, fiscal_year_bs: FY, credit_note_seq: 1, credit_note_no: 'CN-BLT17-1',
      kind: 'partial', invoice_id: uid(5), invoice_no: 'INV-BLT17-C-1', invoice_fiscal_year_bs: FY, buyer_name: 'Test Patient (SYNTHETIC)',
      issued_at: new Date().toISOString(), credit_note_date_bs: '2099-01-01', reason_code: 'correction', gross_paisa: 300, discount_paisa: 0, exempt_paisa: 300,
      taxable_paisa: 0, vat_paisa: 0, other_tax_paisa: 0, net_paisa: 300, cbms_state: 'not_required', created_by: SYS, updated_by: SYS,
    });
    const balance = (credited: number) => ins('billing.order_balances', { tenant_id: TENANT, order_id: uid(750), centre_id: CENTRE, billing_mode: 'cash',
      invoiced_paisa: 1000, paid_paisa: 0, credited_paisa: credited, created_by: SYS, updated_by: SYS });

    it('a CN with NULL order_id against the order\'s invoice counts as credited: matching credited_paisa adds no order_balance violation, a wrong one does', async () => {
      await cleanup();
      const base = await run(CHECK);
      await asSystem([ins('billing.fiscal_counters', counter(S_CN, FY, 1)), ins('billing.invoices', cnInvoice())]);
      await asSystem([ins('billing.fiscal_counters', counter(CN, FY, 1)), ins('billing.credit_notes', creditNote())]);
      expect((await q(`SELECT order_id FROM billing.credit_notes WHERE id=$1`, [uid(71)]))[0].order_id).toBeNull();

      await asSystem([balance(300)]);
      const ok = await run(CHECK);
      expect(violations(ok, 'order_balance')).toBe(violations(base, 'order_balance'));   // red while credited is keyed on credit_notes.order_id (sees 0, flags 300)
      expect(violations(ok, 'seq_gap')).toBe(violations(base, 'seq_gap'));

      await asSystem([[`DELETE FROM billing.order_balances WHERE tenant_id=$1 AND order_id=$2`, [TENANT, uid(750)]], balance(0)]);
      const bad = await run(CHECK);
      expect(violations(bad, 'order_balance')).toBeGreaterThan(violations(base, 'order_balance'));   // the real mismatch (CN not reflected) must not be hidden
    });
  });

  describe('fiscal_counter_prepare (US-BL-01.3)', () => {
    const ctrRows = (fy: string) => q(`SELECT series, last_no, closed_at FROM billing.fiscal_counters WHERE tenant_id=$1 AND fiscal_year_bs=$2 ORDER BY series`, [TENANT, fy]);
    const tenantSeries = (rows: any[]) => rows.map((r) => r.series).filter((s: string) => !s.includes(':'));

    it('mid-year (Magh 2081): creates INV, CN, RC for 2081/82 at last_no 0 and not yet the next FY; closes the ended FY 2080/81', async () => {
      await cleanup();
      await asSystem([ins('billing.fiscal_counters', counter('INV', '2080/81', 7))]);
      await run(PREP, '2025-01-15T06:00:00.000Z');
      const cur = await ctrRows('2081/82');
      expect(tenantSeries(cur)).toEqual(['CN', 'INV', 'RC']);
      expect(cur.every((r: any) => r.last_no === 0 && r.closed_at === null)).toBe(true);
      expect(await ctrRows('2082/83')).toEqual([]);
      const old = (await ctrRows('2080/81')).find((r: any) => r.series === 'INV');
      expect(old.closed_at).not.toBeNull();
      expect(old.last_no).toBe(7);                       // closing never touches the number
    });

    it('from Ashadh 25 (12 Jul 2025) the next FY 2082/83 rows are prepared too', async () => {
      await run(PREP, '2025-07-12T06:00:00.000Z');
      expect(tenantSeries(await ctrRows('2082/83'))).toEqual(['CN', 'INV', 'RC']);
      expect((await ctrRows('2081/82')).every((r: any) => r.closed_at === null)).toBe(true);
    });

    it('is idempotent and never resets or bumps an existing counter', async () => {
      await asSystem([[`UPDATE billing.fiscal_counters SET last_no = 1 WHERE tenant_id=$1 AND series='INV' AND fiscal_year_bs='2081/82'`, [TENANT]]]);
      const before = await ctrRows('2081/82');
      await run(PREP, '2025-07-12T06:00:00.000Z'); await run(PREP, '2025-07-12T06:00:00.000Z');
      expect(await ctrRows('2081/82')).toEqual(before);
      expect((await ctrRows('2081/82')).find((r: any) => r.series === 'INV').last_no).toBe(1);
    });

    it('an already closed counter keeps its closed_at (guard: set once)', async () => {
      const before = (await ctrRows('2080/81')).find((r: any) => r.series === 'INV').closed_at;
      await run(PREP, '2025-07-12T06:00:00.000Z');
      expect((await ctrRows('2080/81')).find((r: any) => r.series === 'INV').closed_at).toEqual(before);
    });
  });
});
