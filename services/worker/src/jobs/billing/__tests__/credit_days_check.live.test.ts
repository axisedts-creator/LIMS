// BL-T13 live-DB integration for billing.credit_days_check (done_when "lock job"; PRD US-BL-10.4; 02-TRD §10; 05-SCHEMA credit_accounts).
// Skipped unless LIMS_TEST_DATABASE_URL (superuser URL of a migrated + seeded DB; tenant 01a1a98a-ac40-7000-8000-00000000a001, branch ...a101) is set.
// Tasks run through a hand-built JobContext whose tx is a pg client in a transaction with system claims; ctx.now() is real time (invoice ages are relative to it, with margins of hours).
// ASSUMED (spec silent): age = now - invoices.issued_at in days, "older than credit_days" = strictly greater (exact-day boundary NOT tested: timezone ambiguity); credit_days NULL = no terms = never
//   auto-locked; "unpaid" = net - credited_total - Σ ledger_entries(invoice_id) > 0; locked_by = ctx.actor.id (system); version bumps by the DB guard; billing.settings.credit_days_auto_lock = false
//   switches the job off for the tenant. Fixtures: parties 0190c413-…, series INV:BLT13*, FY 2098/99; removed in afterAll; billing.settings restored.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SU = process.env['LIMS_TEST_DATABASE_URL'];
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', BRANCH = '01a1a98a-ac40-7000-8000-00000000a101';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const ID = 'billing.credit_days_check';
const FY = '2098/99', DAY = 86_400_000;
const uid = (n: number) => `0190c413-0000-7000-8000-${String(n).padStart(12, '0')}`;
const P = { overdue: uid(1), within: uid(2), paid: uid(3), noTerms: uid(4), manual: uid(5), partial: uid(6), relock: uid(7), cap: uid(8) };
const ALL_PARTIES = Object.values(P);

const account = (party: string, over: Record<string, unknown> = {}) => ({ tenant_id: TENANT, credit_party_id: party, party_code: `BLT13-${party.slice(-2)}`, party_display_name: 'Synthetic Corp (BLT13)',
  credit_days: 30, created_by: SYS, updated_by: SYS, ...over });
let seq = 0;
const periodic = (party: string, ageDays: number, over: Record<string, unknown> = {}) => {
  seq += 1;
  return { id: uid(100 + seq), tenant_id: TENANT, branch_id: BRANCH, centre_id: null, series: `INV:BLT13${seq}`, fiscal_year_bs: FY, invoice_seq: 1, invoice_no: `INV-BLT13-${seq}`, invoice_kind: 'tax_invoice',
    purpose: 'periodic_credit', order_id: null, patient_id: null, credit_party_id: party, is_periodic_credit_bill: true, period_month: '2026-10-01', buyer_name: 'Synthetic Corp (BLT13)',
    seller_name: 'Synthetic Lab', issued_at: new Date(Date.now() - ageDays * DAY - 3_600_000).toISOString(), invoice_date_bs: '2099-01-01', gross_paisa: 100000, discount_paisa: 0,
    exempt_paisa: 100000, taxable_paisa: 0, vat_paisa: 0, other_tax_paisa: 0, net_paisa: 100000, prices_include_tax: false, quote_fingerprint: 'b'.repeat(64), cbms_state: 'not_required',
    created_by: SYS, updated_by: SYS, ...over };
};
const payment = (n: number, invoiceId: string, party: string, amount: number) => ({ id: uid(300 + n), tenant_id: TENANT, branch_id: BRANCH, centre_id: null, order_id: null, invoice_id: invoiceId,
  credit_party_id: party, entry_kind: 'payment', capture_kind: 'gateway', method_code: 'esewa', amount_paisa: amount, gateway: 'esewa', gateway_txn_ref: `BLT13-TXN-${n}`, intent_id: uid(400 + n),
  fiscal_year_bs: FY, business_date: '2099-01-01', created_by: SYS });

describe.skipIf(!SU)('billing.credit_days_check over a real DB', () => {
  let su: any;
  let manifest: any;
  let settingsBefore: any;

  async function asSystem(stmts: Array<[string, unknown[]?]>) {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      for (const [t, v] of stmts) await c.query(t, v);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  const ins = (table: string, row: object): [string, unknown[]] => {
    const cols = Object.keys(row).join(', ');
    return [`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)]];
  };
  /** account + (optional) overdue periodic invoice with its counter row (the counter guard wants last_no to match). */
  const plant = (party: string, ageDays: number | null, acct: Record<string, unknown> = {}, inv: Record<string, unknown> = {}): Array<[string, unknown[]?]> => {
    const out: Array<[string, unknown[]?]> = [ins('billing.credit_accounts', account(party, acct))];
    if (ageDays !== null) {
      const i = periodic(party, ageDays, inv);
      out.push(ins('billing.fiscal_counters', { tenant_id: TENANT, series: i.series, fiscal_year_bs: FY, last_no: 1, created_by: SYS, updated_by: SYS }), ins('billing.invoices', i));
    }
    return out;
  };
  async function run(now = new Date().toISOString()) {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      const ctx: any = {
        tenantId: TENANT, tx: c, actor: { type: 'system', id: SYS }, requestId: uid(900), attempt: 1, maxAttempts: 3, jobId: '1', now: () => now, isNewer: () => true,
        events: {}, core: {}, storage: {}, files: {}, audit: {}, log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, metrics: { inc() {}, set() {}, observe() {} },
      };
      ctx.db = { tx: async (fn: any) => fn(ctx) };
      await manifest.tasks[ID]({ tenant_id: TENANT }, ctx);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  const acc = async (party: string) => (await su.query(`SELECT * FROM billing.credit_accounts WHERE tenant_id = $1 AND credit_party_id = $2`, [TENANT, party])).rows[0];

  async function cleanup() {
    await asSystem([
      [`DELETE FROM billing.ledger_entries WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
      [`DELETE FROM billing.invoices WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
      [`DELETE FROM billing.fiscal_counters WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
      [`DELETE FROM billing.credit_accounts WHERE tenant_id = $1 AND credit_party_id = ANY($2::uuid[])`, [TENANT, ALL_PARTIES]],
    ]);
  }
  const setAutoLock = (v: boolean) => asSystem([[`INSERT INTO billing.settings (tenant_id, credit_days_auto_lock, created_by, updated_by) VALUES ($1, $2, $3, $3)
    ON CONFLICT (tenant_id) DO UPDATE SET credit_days_auto_lock = EXCLUDED.credit_days_auto_lock`, [TENANT, v, SYS]]]);

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    su = new (pg.default ?? pg).Pool({ connectionString: SU, max: 3 });
    manifest = (await import('../index.js')).manifest;
    settingsBefore = (await su.query(`SELECT credit_days_auto_lock FROM billing.settings WHERE tenant_id = $1`, [TENANT])).rows[0];
    await cleanup();
  });
  afterAll(async () => {
    if (!su) return;
    await cleanup().catch(() => undefined);
    if (settingsBefore) await setAutoLock(settingsBefore.credit_days_auto_lock).catch(() => undefined);
    else await asSystem([[`DELETE FROM billing.settings WHERE tenant_id = $1`, [TENANT]]]).catch(() => undefined);
    await su.end();
  });

  it('US-BL-10.4: unpaid periodic invoice older than credit_days locks the account (is_locked, credit_days_exceeded, locked_at, locked_by = system, version +1); within terms / no terms / paid stay open', async () => {
    await cleanup(); await setAutoLock(true);
    const paidInv = periodic(P.paid, 45);
    await asSystem([
      ...plant(P.overdue, 31), ...plant(P.within, 10), ...plant(P.noTerms, 90, { credit_days: null }),
      ins('billing.credit_accounts', account(P.paid)),
      ins('billing.fiscal_counters', { tenant_id: TENANT, series: paidInv.series, fiscal_year_bs: FY, last_no: 1, created_by: SYS, updated_by: SYS }), ins('billing.invoices', paidInv),
      ins('billing.ledger_entries', payment(1, paidInv.id, P.paid, 100000)),
    ]);
    const v0 = (await acc(P.overdue)).version;
    await run();
    const a = await acc(P.overdue);
    expect(a).toMatchObject({ is_locked: true, lock_reason_code: 'credit_days_exceeded', locked_by: SYS, version: v0 + 1 });
    expect(a.locked_at).toBeTruthy();
    for (const p of [P.within, P.noTerms, P.paid]) expect(await acc(p), p).toMatchObject({ is_locked: false, lock_reason_code: null });
  });

  it('a partial payment does not save an overdue invoice; the account locks', async () => {
    const i = periodic(P.partial, 40);
    await asSystem([ins('billing.credit_accounts', account(P.partial)),
      ins('billing.fiscal_counters', { tenant_id: TENANT, series: i.series, fiscal_year_bs: FY, last_no: 1, created_by: SYS, updated_by: SYS }), ins('billing.invoices', i),
      ins('billing.ledger_entries', payment(2, i.id, P.partial, 99999))]);
    await run();
    expect(await acc(P.partial)).toMatchObject({ is_locked: true, lock_reason_code: 'credit_days_exceeded' });
  });

  it('idempotent: a second run changes nothing (locked_at and version stay)', async () => {
    const before = await acc(P.overdue);
    await run();
    const after = await acc(P.overdue);
    expect([after.locked_at.toISOString(), after.version]).toEqual([before.locked_at.toISOString(), before.version]);
  });

  it('a manually locked account (reason manual) is left exactly as it is — the job never rewrites a lock reason', async () => {
    await asSystem(plant(P.manual, 50, { is_locked: true, lock_reason_code: 'manual', locked_at: new Date(Date.now() - 5 * DAY).toISOString(), locked_by: SYS }));
    const before = await acc(P.manual);
    await run();
    const after = await acc(P.manual);
    expect(after).toMatchObject({ is_locked: true, lock_reason_code: 'manual', version: before.version });
  });

  it('NEVER auto-unlocks: once the overdue invoice is fully paid the account stays locked', async () => {
    const i = (await su.query(`SELECT id FROM billing.invoices WHERE tenant_id = $1 AND credit_party_id = $2`, [TENANT, P.overdue])).rows[0];
    await asSystem([ins('billing.ledger_entries', payment(3, i.id, P.overdue, 100000))]);
    await run();
    expect(await acc(P.overdue)).toMatchObject({ is_locked: true, lock_reason_code: 'credit_days_exceeded' });
  });

  it('tenant setting credit_days_auto_lock = false switches the job off: an overdue account stays open', async () => {
    await setAutoLock(false);
    await asSystem(plant(P.cap, 60));
    await run();
    expect(await acc(P.cap)).toMatchObject({ is_locked: false, lock_reason_code: null });
    await setAutoLock(true);
    await run();
    expect(await acc(P.cap)).toMatchObject({ is_locked: true, lock_reason_code: 'credit_days_exceeded' });
  });

  it('after the lock, new credit registrations are refused: the account row says locked, which BillingCommandPort.checkCredit reads (is_locked = true)', async () => {
    const rows = (await su.query(`SELECT credit_party_id, is_locked FROM billing.credit_accounts WHERE tenant_id = $1 AND credit_party_id = ANY($2::uuid[]) AND lock_reason_code = 'credit_days_exceeded'`, [TENANT, ALL_PARTIES])).rows;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r: any) => r.is_locked === true)).toBe(true);
  });
});
