// BL-T06 live-DB integration (review item 2): the SQL behind invoice issue + balance has never run against the real schema in the fake-tx suites.
// Covers TOTALS_SQL, upsertOrderBalance (ON CONFLICT ... WHERE b.balance_version = EXCLUDED.balance_version - 1) + order_balances__guard,
// the insertInvoice column list, insertInvoiceLines, insertActivity ($13::jsonb, activity_log__action__ck) and app.enqueue_job (billing.cbms_sync).
// done_when: balance_version strictly increasing; one balance event per change (US-FD-03.1, US-BL-01.2, US-BL-13.1).
// Gated exactly like counter.live.test.ts / immutability.live.test.ts: skipped unless both URLs are set (needs `pg`, loaded dynamically).
//   LIMS_TEST_DATABASE_URL      superuser URL of a migrated + seeded DB (tenant 01a1a98a-ac40-7000-8000-00000000a001, branch ...a101, centre ...a201). Seeds/inspects/cleans.
//   LIMS_TEST_APP_DATABASE_URL  URL that logs in as / may SET ROLE lims_app; the service + repo run through createDb().requestTx as lims_app.
// Fixtures: fiscal year 2098/99, series INV:BLT06, synthetic orders 0190c406-...; all removed in afterAll. The graphile job for the issued invoice is left to the queue.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../../../core/db/tx.js';
import { billingRepo } from '../../repository/index.js';
import { createBalanceService } from '../balance.service.js';

const SU = process.env['LIMS_TEST_DATABASE_URL'], APP = process.env['LIMS_TEST_APP_DATABASE_URL'];
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', BRANCH = '01a1a98a-ac40-7000-8000-00000000a101', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const OTHER_TENANT = '01a1a98a-ac40-7000-8000-00000000b001'; // not seeded: RLS must show it nothing of tenant A
const CLAIMS = { actor_type: 'system', tenant_id: TENANT, sub: SYS, membership_id: MEMBERSHIP };
const uid = (n: number) => `0190c406-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FY = '2098/99', SER = 'INV:BLT06';
const O1 = uid(1), O2 = uid(2), O3 = uid(3);                 // O1: full flow, O2: concurrency, O3: rollback
const INV1 = uid(11), INV2 = uid(12), INV3 = uid(13), LINE1 = uid(21), ACT1 = uid(31);
const PATIENT = uid(40);

const invoice = (id: string, seq: number, orderId: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, series: SER, fiscal_year_bs: FY, invoice_seq: seq, invoice_no: `INV-BLT06-${seq}`,
  invoice_kind: 'tax_invoice', purpose: 'registration', order_id: orderId, patient_id: PATIENT, buyer_name: 'Test Patient (SYNTHETIC)', seller_name: 'Synthetic Lab',
  issued_at: new Date(Date.now() - (10 - seq) * 60_000).toISOString(), invoice_date_bs: '2098-01-01', gross_paisa: 1000, discount_paisa: 0, exempt_paisa: 1000, taxable_paisa: 0,
  vat_paisa: 0, other_tax_paisa: 0, net_paisa: 1000, prices_include_tax: false, quote_fingerprint: 'b'.repeat(64), status: 'issued', is_active: true, print_count: 0,
  cbms_state: 'pending', cbms_attempts: 0, created_by: SYS, updated_by: SYS, ...over,
});
const payment = (id: string, orderId: string, invoiceId: string, paisa: number) => ({
  id, tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, order_id: orderId, invoice_id: invoiceId, entry_kind: 'payment', capture_kind: 'manual', method_code: 'cash',
  amount_paisa: paisa, fiscal_year_bs: FY, collected_by_membership_id: MEMBERSHIP, business_date: new Date().toISOString().slice(0, 10), created_by: SYS, updated_by: SYS,
});

describe.skipIf(!SU || !APP)('invoice issue + balance SQL over a real DB (lims_app)', () => {
  let su: any, app: any, db: ReturnType<typeof createDb>;
  let reqN = 0;
  const published: Array<Record<string, any>> = [];
  const events = {
    balanceChanged: async (_ctx: unknown, p: Record<string, any>) => { published.push(p); return { eventId: 'e', duplicate: false }; },
    invoiceIssued: async () => ({ eventId: 'e', duplicate: false }),
  };
  const mkSvc = (repo: any = billingRepo) => createBalanceService({ repo, events: events as never });
  const eventsFor = (orderId: string) => published.filter((p) => p['order_id'] === orderId);

  const requestTx = <T>(fn: Parameters<typeof db.requestTx<T>>[1]) =>
    db.requestTx({ claims: CLAIMS as never, requestId: uid(900 + ++reqN), clientIp: '203.0.113.7', operation: { module: 'billing', operationId: 'BL-T06.live' } }, fn);
  const ctxOf = (tx: unknown) => ({ tenantId: TENANT, requestId: uid(900 + reqN), actor: { type: 'system', id: SYS, membershipId: MEMBERSHIP }, tx, now: () => new Date().toISOString() });
  const change = (orderId: string, cause = 'payment_recorded', svc = mkSvc()) => requestTx((tx) => svc.applyChange(ctxOf(tx) as never, { orderId, cause }));
  const balanceRow = async (orderId: string) =>
    (await su.query(`SELECT * FROM billing.order_balances WHERE tenant_id = $1 AND order_id = $2`, [TENANT, orderId])).rows[0];

  async function asSystem(stmts: Array<[string, unknown[]?]>) {
    const c = await su.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      for (const [t, v] of stmts) await c.query(t, v);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  const ins = (table: string, row: object): [string, unknown[]] => [`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)]];
  const cleanup = () => asSystem([
    [`DELETE FROM billing.ledger_entries WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`, [TENANT, [O1, O2, O3]]],
    [`DELETE FROM billing.order_balances WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`, [TENANT, [O1, O2, O3]]],
    [`DELETE FROM billing.invoice_lines WHERE tenant_id = $1 AND invoice_id = ANY($2::uuid[])`, [TENANT, [INV1, INV2, INV3]]],
    [`DELETE FROM billing.activity_log WHERE tenant_id = $1 AND id = $2`, [TENANT, ACT1]],
    [`DELETE FROM billing.invoices WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
    [`DELETE FROM billing.fiscal_counters WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
  ]);

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    const Pool = (pg.default ?? pg).Pool;
    su = new Pool({ connectionString: SU, max: 3 }); app = new Pool({ connectionString: APP, max: 8 });
    db = createDb({ pool: app, identitySystemActorId: SYS });
    await cleanup();
    await asSystem([
      ins('billing.fiscal_counters', { tenant_id: TENANT, series: SER, fiscal_year_bs: FY, last_no: 3, created_by: SYS, updated_by: SYS }),
      ins('billing.invoices', invoice(INV2, 2, O2)), ins('billing.invoices', invoice(INV3, 3, O3)),
    ]);
  });
  afterAll(async () => { if (su) await cleanup().catch(() => undefined); await su?.end(); await app?.end(); });

  describe('issue -> first balance (US-BL-01.2, US-FD-03.1)', () => {
    it('invoice + lines + activity + cbms job insert as lims_app with the real column lists; balance row is created at balance_version 1 with release_basis set', async () => {
      const out = await requestTx(async (tx) => {
        const inv = await billingRepo.insertInvoice(tx, invoice(INV1, 1, O1));
        await billingRepo.insertInvoiceLines(tx, [{
          id: LINE1, tenant_id: TENANT, invoice_id: INV1, centre_id: CENTRE, line_no: 1, line_kind: 'orderable', orderable_id: uid(50), orderable_kind: 'test', code: 'T-1', name: 'Synthetic test',
          quantity: 1, unit_price_paisa: 1000, gross_paisa: 1000, discount_paisa: 0, exempt_paisa: 1000, taxable_paisa: 0, vat_treatment: 'exempt', vat_paisa: 0, other_tax_paisa: 0,
          net_paisa: 1000, created_by: SYS }]);
        await billingRepo.insertActivity(tx, { id: ACT1, tenant_id: TENANT, centre_id: CENTRE, action: 'invoice_issued', document_kind: 'invoice', document_id: INV1, document_no: 'INV-BLT06-1',
          actor_id: SYS, actor_membership_id: MEMBERSHIP, actor_type: 'system', occurred_at: new Date().toISOString(), request_id: uid(900 + reqN),
          details: { entry_mode: 'downtime_backentry', occurred_at: '2098-01-01T00:00:00.000Z', downtime_ref: 'P-0042' }, created_by: SYS });
        await billingRepo.enqueueCbmsSync(tx, { tenantId: TENANT, documentKind: 'invoice', documentId: INV1 });
        const bal = await mkSvc().applyChange(ctxOf(tx) as never, { orderId: O1, cause: 'invoice_issued' });
        return { inv, bal };
      });
      expect(out.bal).toEqual({ changed: true, balanceVersion: 1 });
      const row = await balanceRow(O1);
      expect(row).toMatchObject({ billing_mode: 'cash', balance_version: 1, release_basis: 'due_outstanding', centre_id: CENTRE });
      expect([row.invoiced_paisa, row.paid_paisa, row.credited_paisa, row.balance_due_paisa].map(String)).toEqual(['1000', '0', '0', '1000']);
      expect(eventsFor(O1).map((p) => p['balance_version'])).toEqual([1]);
      expect(eventsFor(O1)[0]).toMatchObject({ cause: 'invoice_issued', release_eligible: false, release_basis: 'due_outstanding' });

      const act = (await su.query(`SELECT details, actor_type FROM billing.activity_log WHERE tenant_id = $1 AND id = $2`, [TENANT, ACT1])).rows[0];
      expect(act.details).toEqual({ entry_mode: 'downtime_backentry', occurred_at: '2098-01-01T00:00:00.000Z', downtime_ref: 'P-0042' });
      const lines = await su.query(`SELECT count(*)::int AS n FROM billing.invoice_lines WHERE tenant_id = $1 AND invoice_id = $2`, [TENANT, INV1]);
      expect(lines.rows[0].n).toBe(1);
      // outbox: the job is queued in the issuing transaction, keyed by document; nothing is marked synced (US-BL-13.1). Needs billing.cbms_sync in core.g_task_registry.
      const job = await su.query(`SELECT task_identifier, payload FROM graphile_worker.jobs WHERE key = $1`, [`cbms:invoice:${INV1}`]);
      expect(job.rows).toHaveLength(1);
      expect(job.rows[0].task_identifier).toBe('billing.cbms_sync');
      expect(job.rows[0].payload).toEqual({ tenant_id: TENANT, document_kind: 'invoice', document_id: INV1 });
      expect((await su.query(`SELECT cbms_state FROM billing.invoices WHERE id = $1`, [INV1])).rows[0].cbms_state).toBe('pending');
    });

    it('a transaction that fails after applyChange leaves no order_balances row', async () => {
      await expect(requestTx(async (tx) => { await mkSvc().applyChange(ctxOf(tx) as never, { orderId: O3, cause: 'invoice_issued' }); throw new Error('boom'); })).rejects.toThrow('boom');
      expect(await balanceRow(O3)).toBeUndefined();
    });
  });

  describe('balance_version strictly increasing, one event per change (done_when)', () => {
    it('unchanged recompute -> no write (row version and balance_version untouched), no event', async () => {
      const before = await balanceRow(O1), n = eventsFor(O1).length;
      await expect(change(O1)).resolves.toEqual({ changed: false, balanceVersion: 1 });
      const after = await balanceRow(O1);
      expect([after.balance_version, after.version, String(after.updated_at)]).toEqual([before.balance_version, before.version, String(before.updated_at)]);
      expect(eventsFor(O1)).toHaveLength(n);
    });

    it('each real change -> version 2, 3 (paid_in_full when the due reaches 0), exactly one event each, ledger summed by TOTALS_SQL', async () => {
      await asSystem([ins('billing.ledger_entries', payment(uid(61), O1, INV1, 400))]);
      await expect(change(O1)).resolves.toEqual({ changed: true, balanceVersion: 2 });
      expect(await balanceRow(O1)).toMatchObject({ balance_version: 2, release_basis: 'due_outstanding' });
      await asSystem([ins('billing.ledger_entries', payment(uid(62), O1, INV1, 600))]);
      await expect(change(O1)).resolves.toEqual({ changed: true, balanceVersion: 3 });
      const row = await balanceRow(O1);
      expect(row).toMatchObject({ balance_version: 3, release_basis: 'paid_in_full' });
      expect([row.paid_paisa, row.balance_due_paisa].map(String)).toEqual(['1000', '0']);
      const ev = eventsFor(O1);
      expect(ev.map((p) => p['balance_version'])).toEqual([1, 2, 3]);
      expect(ev[2]).toMatchObject({ release_eligible: true, release_basis: 'paid_in_full', cause: 'payment_recorded' });
    });
  });

  describe('concurrency + guard (optimistic write)', () => {
    it('two applyChange calls on the same order read the same version -> exactly one wins, the other gets common.version_conflict, version moves once, one event', async () => {
      await asSystem([ins('billing.order_balances', { tenant_id: TENANT, order_id: O2, centre_id: CENTRE, billing_mode: 'cash', invoiced_paisa: 1000, paid_paisa: 0, credited_paisa: 0,
        balance_version: 1, release_basis: 'due_outstanding', created_by: SYS, updated_by: SYS })]);
      await asSystem([ins('billing.ledger_entries', payment(uid(63), O2, INV2, 300))]);
      let readers = 0, release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const gated = { ...billingRepo, getOrderBalance: async (tx: any, a: any) => { const r = await billingRepo.getOrderBalance(tx, a); if (++readers === 2) release(); await gate; return r; } };
      const n = eventsFor(O2).length;
      const res = await Promise.allSettled([change(O2, 'payment_recorded', mkSvc(gated)), change(O2, 'payment_recorded', mkSvc(gated))]);
      expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: 'common.version_conflict' });
      expect(await balanceRow(O2)).toMatchObject({ balance_version: 2 });
      expect(eventsFor(O2).slice(n).map((p) => p['balance_version'])).toEqual([2]);
    });

    it('a stale or skipping balance_version write is refused by the WHERE and writes nothing', async () => {
      const w = (balanceVersion: number) => ({ tenantId: TENANT, orderId: O2, centreId: CENTRE, billingMode: 'cash' as const, invoicedPaisa: 1000, paidPaisa: 900, creditedPaisa: 0,
        balanceVersion, releaseBasis: 'due_outstanding', userId: SYS });
      expect(await requestTx((tx) => billingRepo.upsertOrderBalance(tx, w(2)))).toBeUndefined(); // stale: 2 is already stored
      expect(await requestTx((tx) => billingRepo.upsertOrderBalance(tx, w(1)))).toBeUndefined(); // behind
      expect(await requestTx((tx) => billingRepo.upsertOrderBalance(tx, w(5)))).toBeUndefined(); // skipping ahead
      expect(await balanceRow(O2)).toMatchObject({ balance_version: 2 });
      expect(String((await balanceRow(O2)).paid_paisa)).toBe('300');
    });

    it('order_balances__guard: version up without an amount change, version down, or amounts changed without a bump -> P0001 immutable_row', async () => {
      const run = async (set: string) => {
        const c = await app.connect();
        try {
          await c.query('BEGIN'); await c.query('SET LOCAL ROLE lims_app');
          await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(CLAIMS)]);
          await c.query(`UPDATE billing.order_balances SET ${set} WHERE tenant_id = $1 AND order_id = $2`, [TENANT, O2]);
          return 'ok';
        } catch (e: any) { return `E${e.code}|${e.message}`; } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
      };
      expect(await run('balance_version = balance_version + 1')).toMatch(/^EP0001\|immutable_row/);
      expect(await run('balance_version = balance_version - 1')).toMatch(/^EP0001\|immutable_row/);
      expect(await run('paid_paisa = paid_paisa + 1')).toMatch(/^EP0001\|immutable_row/);
      expect(await run('paid_paisa = paid_paisa + 1, balance_version = balance_version + 1')).toBe('ok');
    });
  });

  describe('tenancy (RLS)', () => {
    const rowsAs = async (claims: object, sql: string, v: unknown[]) => {
      const c = await app.connect();
      try {
        await c.query('BEGIN'); await c.query('SET LOCAL ROLE lims_app');
        await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        return (await c.query(sql, v)).rows;
      } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    };
    it('tenant B sees none of tenant A\'s order_balances / invoices / ledger rows, even with no tenant filter in the statement; tenant A sees its own', async () => {
      const other = { actor_type: 'system', tenant_id: OTHER_TENANT, sub: SYS };
      for (const t of ['order_balances', 'invoices', 'ledger_entries']) {
        expect(await rowsAs(other, `SELECT 1 FROM billing.${t} WHERE order_id = ANY($1::uuid[])`, [[O1, O2]])).toEqual([]);
        expect((await rowsAs(CLAIMS, `SELECT 1 FROM billing.${t} WHERE order_id = ANY($1::uuid[])`, [[O1, O2]])).length).toBeGreaterThan(0);
      }
    });
    it('the repo called with tenant A\'s id under tenant B claims reads nothing (a wrong tenantId argument cannot cross tenants)', async () => {
      const c = await app.connect();
      try {
        await c.query('BEGIN'); await c.query('SET LOCAL ROLE lims_app');
        await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ actor_type: 'system', tenant_id: OTHER_TENANT, sub: SYS })]);
        expect(await billingRepo.getOrderBalance(c, { tenantId: TENANT, orderId: O1 })).toBeUndefined();
        expect(await billingRepo.readOrderTotals(c, { tenantId: TENANT, orderId: O1 })).toBeUndefined();
      } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    });
  });
});
