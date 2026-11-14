// BL-T03 live-DB integration (05-SCHEMA §9 tests 3/4/6; US-BL-02.1/.2; done_when "Direct UPDATE/DELETE as lims_app fail as specified").
// Gated like identity/repository/__tests__/sessions.repo.live.test.ts: skipped unless both URLs are set (needs the `pg` driver, loaded dynamically).
//   LIMS_TEST_DATABASE_URL      superuser URL of a migrated + seeded DB (tenant 01a1a98a-ac40-7000-8000-00000000a001, branch ...a101, centre ...a201). Seeds/cleans only.
//   LIMS_TEST_APP_DATABASE_URL  URL of a connection that logs in as (or can SET ROLE to) lims_app; every assertion below runs as lims_app with real claims.
// Fixtures use fiscal year 2099/00 and series INV:BLT03* so they cannot collide with seeds; they are removed in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../../../core/db/tx.js';
import { bumpCounter } from '../counters.repo.js';
import { markInvoicePrinted } from '../invoices.repo.js';

const SU = process.env['LIMS_TEST_DATABASE_URL'], APP = process.env['LIMS_TEST_APP_DATABASE_URL'];
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', BRANCH = '01a1a98a-ac40-7000-8000-00000000a101', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const uid = (n: number) => `0190c403-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FY = '2099/00', SER = 'INV:BLT03', SER_BUMP = 'INV:BLT03B';
const ID_OPEN = uid(1), ID_CANCELLED = uid(2), ID_LEDGER = uid(3);
const CLAIMS = { actor_type: 'system', tenant_id: TENANT, sub: SYS, membership_id: MEMBERSHIP };
const APPEND_ONLY = ['invoice_lines', 'credit_note_lines', 'ledger_entries', 'print_log', 'activity_log', 'cbms_submissions', 'release_overrides', 'payment_intent_refs'];

const invoice = (id: string, seq: number, over: Record<string, unknown> = {}) => ({
  id, tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, series: SER, fiscal_year_bs: FY, invoice_seq: seq, invoice_no: `INV-BLT03-${seq}`,
  invoice_kind: 'tax_invoice', purpose: 'registration', order_id: uid(10 + seq), patient_id: uid(20 + seq), buyer_name: 'Test Patient (SYNTHETIC)', seller_name: 'Synthetic Lab',
  issued_at: new Date(Date.now() - (10 - seq) * 60_000).toISOString(), invoice_date_bs: '2099-01-01', gross_paisa: 1000, discount_paisa: 0, exempt_paisa: 1000, taxable_paisa: 0,
  vat_paisa: 0, other_tax_paisa: 0, net_paisa: 1000, prices_include_tax: false, quote_fingerprint: 'a'.repeat(64), cbms_state: 'not_required', created_by: SYS, updated_by: SYS, ...over,
});

describe.skipIf(!SU || !APP)('billing immutability + repositories as lims_app over a real DB', () => {
  let su: any, app: any, db: ReturnType<typeof createDb>;

  async function asSystem(pool: any, stmts: Array<[string, unknown[]?]>) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      for (const [t, v] of stmts) await c.query(t, v);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  const ins = (table: string, row: object): [string, unknown[]] => [`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)]];
  /** Run one statement as lims_app with staff claims in its own transaction; resolves 'n=<rowcount>' or 'E<sqlstate>|<message>'. */
  async function asApp(sql: string, values: unknown[] = []): Promise<string> {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE lims_app');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(CLAIMS)]);
      const r = await c.query(sql, values);
      await c.query('ROLLBACK'); // never persist what the test provokes
      return `n=${r.rowCount}`;
    } catch (e: any) { await c.query('ROLLBACK').catch(() => undefined); return `E${e.code}|${e.message}`; } finally { c.release(); }
  }
  const requestTx = <T>(fn: Parameters<typeof db.requestTx<T>>[1]) =>
    db.requestTx({ claims: CLAIMS as never, requestId: uid(900), clientIp: '203.0.113.7', operation: { module: 'billing', operationId: 'BL-T03.live' } }, fn);

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    const Pool = (pg.default ?? pg).Pool;
    su = new Pool({ connectionString: SU, max: 2 }); app = new Pool({ connectionString: APP, max: 4 });
    db = createDb({ pool: app, identitySystemActorId: SYS });
    const ctr = (series: string, last_no: number) => ({ tenant_id: TENANT, series, fiscal_year_bs: FY, last_no, created_by: SYS, updated_by: SYS });
    await asSystem(su, [ins('billing.fiscal_counters', ctr(SER, 1)), ins('billing.fiscal_counters', ctr(SER_BUMP, 0)), ins('billing.invoices', invoice(ID_OPEN, 1))]);
    await asSystem(su, [[`UPDATE billing.fiscal_counters SET last_no = 2 WHERE tenant_id = $1 AND series = $2 AND fiscal_year_bs = $3`, [TENANT, SER, FY]],
      ins('billing.invoices', invoice(ID_CANCELLED, 2, { status: 'cancelled', is_active: false, cancelled_at: new Date().toISOString(), cancel_reason_code: 'billing_error', credit_note_id: uid(78), cbms_cancel_state: 'not_required' }))]);
    await asSystem(su, [ins('billing.ledger_entries', { id: ID_LEDGER, tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, order_id: uid(11), invoice_id: ID_OPEN, entry_kind: 'payment',
      capture_kind: 'manual', method_code: 'cash', amount_paisa: 500, fiscal_year_bs: FY, collected_by_membership_id: MEMBERSHIP, business_date: new Date().toISOString().slice(0, 10), created_by: SYS, updated_by: SYS })]);
  });
  afterAll(async () => {
    if (su) {
      await asSystem(su, [[`DELETE FROM billing.ledger_entries WHERE id = $1`, [ID_LEDGER]], [`DELETE FROM billing.invoices WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
        [`DELETE FROM billing.fiscal_counters WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]]]).catch(() => undefined);
    }
    await su?.end(); await app?.end();
  });

  describe('grants (§9.3, §9.4; US-BL-02.2)', () => {
    it('lims_app has no DELETE privilege on any frontdesk/billing table except billing.export_jobs', async () => {
      const { rows } = await su.query(`SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables WHERE schemaname IN ('frontdesk','billing') AND has_table_privilege('lims_app', format('%I.%I', schemaname, tablename), 'DELETE')`);
      expect(rows.map((r: any) => r.t)).toEqual(['billing.export_jobs']);
    });
    it('lims_app has no UPDATE privilege on the append-only tables (+ frontdesk.patient_consents)', async () => {
      const { rows } = await su.query(`SELECT t FROM unnest($1::text[]) t WHERE has_table_privilege('lims_app', t, 'UPDATE')`, [[...APPEND_ONLY.map((t) => `billing.${t}`), 'frontdesk.patient_consents']]);
      expect(rows).toEqual([]);
    });
  });

  describe('direct statements as lims_app (US-BL-02.1; §9.6)', () => {
    it('UPDATE invoices.net_paisa -> P0001 immutable_row, row unchanged', async () => {
      expect(await asApp(`UPDATE billing.invoices SET net_paisa = net_paisa + 1 WHERE id = $1`, [ID_OPEN])).toMatch(/^EP0001\|immutable_row/);
      const { rows } = await su.query(`SELECT net_paisa FROM billing.invoices WHERE id = $1`, [ID_OPEN]);
      expect(String(rows[0].net_paisa)).toBe('1000');
    });
    it.each(['buyer_name', 'invoice_no', 'issued_at', 'vat_paisa'])('UPDATE invoices.%s -> immutable_row', async (col) => {
      const v = col === 'buyer_name' ? `'X'` : col === 'invoice_no' ? `'INV-HACK'` : col === 'issued_at' ? 'now()' : '1';
      expect(await asApp(`UPDATE billing.invoices SET ${col} = ${v} WHERE id = $1`, [ID_OPEN])).toMatch(/^EP0001\|immutable_row/);
    });
    it('cancelled invoice back to issued -> guard error; cancellation columns frozen', async () => {
      expect(await asApp(`UPDATE billing.invoices SET status = 'issued', is_active = true WHERE id = $1`, [ID_CANCELLED])).toMatch(/^EP0001\|immutable_row/);
      expect(await asApp(`UPDATE billing.invoices SET cancel_reason_code = 'other' WHERE id = $1`, [ID_CANCELLED])).toMatch(/^EP0001\|immutable_row/);
    });
    it('print_count may grow by 1 only', async () => {
      expect(await asApp(`UPDATE billing.invoices SET print_count = print_count + 2 WHERE id = $1`, [ID_OPEN])).toMatch(/^EP0001\|immutable_row/);
      expect(await asApp(`UPDATE billing.invoices SET print_count = print_count + 1 WHERE id = $1`, [ID_OPEN])).toBe('n=1');
    });
    it('fiscal_counters: last_no + 2 and last_no - 1 -> guard error; + 1 allowed', async () => {
      const w = [TENANT, SER, FY];
      const where = `WHERE tenant_id = $1 AND series = $2 AND fiscal_year_bs = $3`;
      expect(await asApp(`UPDATE billing.fiscal_counters SET last_no = last_no + 2 ${where}`, w)).toMatch(/^EP0001\|immutable_row/);
      expect(await asApp(`UPDATE billing.fiscal_counters SET last_no = last_no - 1 ${where}`, w)).toMatch(/^EP0001\|immutable_row/);
      expect(await asApp(`UPDATE billing.fiscal_counters SET last_no = last_no + 1 ${where}`, w)).toBe('n=1');
    });
    it.each(['billing.invoices', 'billing.ledger_entries', 'billing.fiscal_counters', 'billing.credit_notes'])('DELETE FROM %s -> 42501 permission denied', async (t) => {
      expect(await asApp(`DELETE FROM ${t}`)).toMatch(/^E42501\|/);
    });
    it('UPDATE on an append-only table (ledger_entries.amount_paisa) -> 42501', async () => {
      expect(await asApp(`UPDATE billing.ledger_entries SET amount_paisa = 1 WHERE id = $1`, [ID_LEDGER])).toMatch(/^E42501\|/);
    });
    it('the ledger row and both invoices survived every attempt', async () => {
      const { rows } = await su.query(`SELECT (SELECT count(*) FROM billing.ledger_entries WHERE id = $1)::int AS l, (SELECT count(*) FROM billing.invoices WHERE tenant_id = $2 AND fiscal_year_bs = $3)::int AS i`, [ID_LEDGER, TENANT, FY]);
      expect(rows[0]).toEqual({ l: 1, i: 2 });
    });
  });

  describe('repositories through the request tx as lims_app', () => {
    it('bumpCounter returns last_no + 1 each call, strictly sequential, no gaps', async () => {
      const key = { tenantId: TENANT, series: SER_BUMP, fiscalYearBs: FY };
      const got: Array<number | undefined> = [];
      for (let i = 0; i < 3; i++) got.push(await requestTx((tx) => bumpCounter(tx, key)));
      expect(got).toEqual([1, 2, 3]);
    });
    it('bumpCounter on a missing counter -> undefined', async () => {
      expect(await requestTx((tx) => bumpCounter(tx, { tenantId: TENANT, series: 'INV:BLT03NONE', fiscalYearBs: FY }))).toBeUndefined();
    });
    it('markInvoicePrinted +1 per call on an issued invoice', async () => {
      const a = await requestTx((tx) => markInvoicePrinted(tx, { tenantId: TENANT, invoiceId: ID_OPEN, userId: SYS }));
      const b = await requestTx((tx) => markInvoicePrinted(tx, { tenantId: TENANT, invoiceId: ID_OPEN, userId: SYS }));
      expect(b).toBe((a as number) + 1);
    });
    it('a tx whose handler hits the immutable guard rolls back and surfaces a mapped error (no raw DB text)', async () => {
      const err: any = await requestTx((tx) => tx.query(`UPDATE billing.invoices SET net_paisa = 1 WHERE id = $1`, [ID_OPEN])).catch((e) => e);
      expect(err.code).toMatch(/^(common\.immutable_record|billing\.invoice_immutable)$/);
      expect(String(err.message)).not.toMatch(/immutable_row|billing\.invoices/);
    });
  });
});
