// BL-T14 live-DB integration for billing.cbms_sync / billing.cbms_sweep (done_when "stub never marks synced; retry/sweep for all three document kinds"; tests "integration with a test client
// returning each outcome"; PRD US-BL-13.1/.2/.4; 02-TRD §9). Skipped unless LIMS_TEST_DATABASE_URL (superuser URL of a migrated + seeded DB; tenant 01a1a98a-ac40-7000-8000-00000000a001,
// branch ...a101) is set. Needs billing.cbms_sync + billing.cbms_sweep rows in core.g_task_registry (registry-sync from the manifest) because the sweep enqueues through app.enqueue_job.
// Tasks run through a hand-built JobContext whose tx is a pg client in a transaction with system claims (as credit_days_check.live.test.ts). Client = a scripted test client injected with
// createCbmsSync({ client }). Fixtures: FY 2097/98, parties 0190c414-…, series INV:BLT14*, CN; removed in afterAll (jobs removed by key).
// ASSUMED (spec silent): the sweep treats "older than min(2^attempts min, 6 h)" as strictly older than at ctx.now(); a pending document NEVER attempted is not asserted either way; the sweep
//   sets gauge lims_billing_cbms_pending_documents{tenant_id,state} (label values free) through ctx.metrics.set; cbms_sync increments lims_billing_cbms_submissions_total{outcome} per attempt.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SU = process.env['LIMS_TEST_DATABASE_URL'];
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', BRANCH = '01a1a98a-ac40-7000-8000-00000000a101';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const SYNC = 'billing.cbms_sync', SWEEP = 'billing.cbms_sweep';
const FY = '2097/98', MIN = 60_000, H = 60 * MIN;
const uid = (n: number) => `0190c414-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

// one periodic invoice per party (fixture shape of credit_days_check.live.test.ts)
const I = { pending: 1, cancelled: 2, notRequired: 3, synced: 4, failed: 5, due: 6, fresh: 7, capped: 8, cappedFresh: 9 };
const invId = (n: number) => uid(100 + n), partyOf = (n: number) => uid(10 + n), CN1 = uid(200);
const account = (n: number) => ({ tenant_id: TENANT, credit_party_id: partyOf(n), party_code: `BLT14-${n}`, party_display_name: 'Synthetic Corp (BLT14)', credit_days: 30, created_by: SYS, updated_by: SYS });
const invoice = (n: number, over: Record<string, unknown> = {}) => ({
  id: invId(n), tenant_id: TENANT, branch_id: BRANCH, centre_id: null, series: `INV:BLT14${n}`, fiscal_year_bs: FY, invoice_seq: 1, invoice_no: `INV-BLT14-${n}`, invoice_kind: 'tax_invoice',
  purpose: 'periodic_credit', order_id: null, patient_id: null, credit_party_id: partyOf(n), is_periodic_credit_bill: true, period_month: '2026-10-01', buyer_name: 'Synthetic Corp (BLT14)',
  seller_name: 'Synthetic Lab', issued_at: ago(30 * H), invoice_date_bs: '2098-01-01', gross_paisa: 100000, discount_paisa: 0, exempt_paisa: 100000, taxable_paisa: 0, vat_paisa: 0,
  other_tax_paisa: 0, net_paisa: 100000, prices_include_tax: false, quote_fingerprint: 'b'.repeat(64), cbms_state: 'pending', created_by: SYS, updated_by: SYS, ...over });
const creditNote = (over: Record<string, unknown> = {}) => ({
  id: CN1, tenant_id: TENANT, branch_id: BRANCH, centre_id: null, series: 'CN', fiscal_year_bs: FY, credit_note_seq: 1, credit_note_no: 'CN-BLT14-1', kind: 'cancellation',
  invoice_id: invId(I.cancelled), invoice_no: `INV-BLT14-${I.cancelled}`, invoice_fiscal_year_bs: FY, credit_party_id: partyOf(I.cancelled), buyer_name: 'Synthetic Corp (BLT14)', issued_at: ago(29 * H),
  credit_note_date_bs: '2098-01-01', reason_code: 'billing_error', gross_paisa: 100000, discount_paisa: 0, exempt_paisa: 100000, taxable_paisa: 0, vat_paisa: 0, other_tax_paisa: 0,
  net_paisa: 100000, is_active: true, print_count: 0, cbms_state: 'pending', cbms_attempts: 0, created_by: SYS, updated_by: SYS, ...over });
const KEYS = [['invoice', I.pending], ['invoice_cancellation', I.cancelled], ['invoice', I.notRequired], ['invoice', I.synced], ['invoice', I.failed], ['invoice', I.due], ['invoice', I.fresh],
  ['invoice', I.capped], ['invoice', I.cappedFresh]].map(([k, n]) => `cbms:${k}:${invId(n as number)}`).concat(`cbms:credit_note:${CN1}`, `cbms:invoice_cancellation:${invId(I.cancelled)}`);

const scripted = (outcome: string, calls: unknown[] = []) => ({ calls, mode: 'live' as const, async submit(i: unknown) {
  calls.push(i);
  if (outcome === 'throw') throw new Error('connect ECONNREFUSED SECRET-TOKEN-123');
  return outcome === 'accepted' ? { outcome, externalRef: 'EXT-BLT14' } : { outcome, rawStatusRedacted: 'status' };
} });

describe.skipIf(!SU)('billing.cbms_sync / billing.cbms_sweep over a real DB', () => {
  let su: any, manifest: any, createCbmsSync: any, RecordingStub: any;

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
  const plantInvoice = (n: number, over: Record<string, unknown> = {}): Array<[string, unknown[]?]> => [
    ins('billing.credit_accounts', account(n)),
    ins('billing.fiscal_counters', { tenant_id: TENANT, series: `INV:BLT14${n}`, fiscal_year_bs: FY, last_no: 1, created_by: SYS, updated_by: SYS }),
    ins('billing.invoices', invoice(n, over))];
  const setAttempts = (n: number, attempts: number, lastAttemptMsAgo: number | null) => asSystem([[`UPDATE billing.invoices SET cbms_attempts = $3, cbms_last_attempt_at = $4 WHERE tenant_id = $1 AND id = $2`,
    [TENANT, invId(n), attempts, lastAttemptMsAgo === null ? null : ago(lastAttemptMsAgo)]]]);

  async function inTask(fn: (ctx: any) => Promise<void>, now = new Date().toISOString(), extra: Record<string, unknown> = {}) {
    const c = await su.connect(); const metrics: any[] = [];
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      const ctx: any = {
        tenantId: TENANT, tx: c, actor: { type: 'system', id: SYS }, requestId: uid(900), attempt: 1, maxAttempts: 10, jobId: '1', now: () => now, isNewer: () => true,
        events: {}, core: {}, storage: {}, files: {}, audit: {}, log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
        metrics: { inc: (name: string, labels: any) => metrics.push({ kind: 'inc', name, labels }), set: (name: string, value: number, labels: any) => metrics.push({ kind: 'set', name, value, labels }), observe() {} }, ...extra,
      };
      ctx.db = { tx: async (f: any) => f(ctx) };
      await fn(ctx);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    return metrics;
  }
  const sync = (client: unknown, kind: string, id: string) => inTask((ctx) => createCbmsSync({ client })({ tenant_id: TENANT, document_kind: kind, document_id: id }, ctx));
  const sweep = (now?: string) => inTask((ctx) => manifest.tasks[SWEEP]({ tenant_id: TENANT }, ctx), now);
  const inv = async (n: number) => (await su.query(`SELECT * FROM billing.invoices WHERE tenant_id = $1 AND id = $2`, [TENANT, invId(n)])).rows[0];
  const cn = async () => (await su.query(`SELECT * FROM billing.credit_notes WHERE tenant_id = $1 AND id = $2`, [TENANT, CN1])).rows[0];
  const subs = async (kind: string, id: string) => (await su.query(`SELECT * FROM billing.cbms_submissions WHERE tenant_id = $1 AND document_kind = $2 AND document_id = $3 ORDER BY attempt_no`, [TENANT, kind, id])).rows;
  const jobKeys = async () => (await su.query(`SELECT key, task_identifier, payload FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key`, [KEYS])).rows;

  async function cleanup() {
    for (const k of KEYS) await su.query(`SELECT graphile_worker.remove_job($1)`, [k]).catch(() => undefined);
    await asSystem([
      [`DELETE FROM billing.cbms_submissions WHERE tenant_id = $1 AND document_id = ANY($2::uuid[])`, [TENANT, [...Object.values(I).map(invId), CN1]]],
      [`DELETE FROM billing.credit_notes WHERE tenant_id = $1 AND id = $2`, [TENANT, CN1]],
      [`DELETE FROM billing.invoices WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
      [`DELETE FROM billing.fiscal_counters WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
      [`DELETE FROM billing.credit_accounts WHERE tenant_id = $1 AND credit_party_id = ANY($2::uuid[])`, [TENANT, Object.values(I).map(partyOf)]],
    ]);
  }
  /** I.pending pending; I.cancelled cancelled (cbms_state not_required, cancellation doc pending) + CN1 pending; not_required; synced; failed_permanent; + sweep-age fixtures. */
  async function plantAll() {
    await cleanup();
    await asSystem([
      ...plantInvoice(I.pending), ...plantInvoice(I.cancelled, { cbms_state: 'not_required' }),
      ins('billing.fiscal_counters', { tenant_id: TENANT, series: 'CN', fiscal_year_bs: FY, last_no: 1, created_by: SYS, updated_by: SYS }), ins('billing.credit_notes', creditNote()),
      [`UPDATE billing.invoices SET status = 'cancelled', is_active = false, cancelled_at = $3, cancelled_by = $4, cancel_reason_code = 'billing_error', credit_note_id = $5,
          credited_total_paisa = net_paisa, cbms_cancel_state = 'pending' WHERE tenant_id = $1 AND id = $2`, [TENANT, invId(I.cancelled), ago(29 * H), SYS, CN1]],
      ...plantInvoice(I.notRequired, { cbms_state: 'not_required' }), ...plantInvoice(I.synced, { cbms_state: 'synced' }), ...plantInvoice(I.failed, { cbms_state: 'failed_permanent' }),
      ...plantInvoice(I.due), ...plantInvoice(I.fresh), ...plantInvoice(I.capped), ...plantInvoice(I.cappedFresh),
    ]);
  }

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    su = new (pg.default ?? pg).Pool({ connectionString: SU, max: 3 });
    manifest = (await import('../index.js')).manifest;
    createCbmsSync = (await import('../tasks/cbms_sync.js')).createCbmsSync;
    RecordingStub = (await import('../../../../../api/src/modules/billing/cbms/RecordingStubCbmsClient.js')).RecordingStubCbmsClient;
    await plantAll();
  });
  afterAll(async () => { if (!su) return; await cleanup().catch(() => undefined); await su.end(); });

  describe('cbms_sync with the recording stub (US-BL-13.1)', () => {
    it('stub_recorded: one submission row (client_mode stub), state stays pending, attempts 1, cbms_synced_at null — for the invoice, the cancellation document and the credit note', async () => {
      for (const [kind, id] of [['invoice', invId(I.pending)], ['invoice_cancellation', invId(I.cancelled)], ['credit_note', CN1]] as const) {
        const metrics = await inTask((ctx) => createCbmsSync({ client: new RecordingStub() })({ tenant_id: TENANT, document_kind: kind, document_id: id }, ctx));
        expect(await subs(kind, id), kind).toEqual([expect.objectContaining({ attempt_no: 1, client_mode: 'stub', outcome: 'stub_recorded', external_ref: null })]);
        expect(metrics.some((m) => m.kind === 'inc' && m.name === 'lims_billing_cbms_submissions_total' && m.labels?.outcome === 'stub_recorded'), kind).toBe(true);
      }
      expect(await inv(I.pending)).toMatchObject({ cbms_state: 'pending', cbms_attempts: 1, cbms_synced_at: null, cbms_external_ref: null });
      expect(await cn()).toMatchObject({ cbms_state: 'pending', cbms_attempts: 1, cbms_synced_at: null });
    });
    it('the cancellation document writes cbms_cancel_* and leaves the invoice\'s own cbms_* alone', async () => {
      expect(await inv(I.cancelled)).toMatchObject({ cbms_cancel_state: 'pending', cbms_cancel_attempts: 1, cbms_state: 'not_required', cbms_attempts: 0 });
      expect((await inv(I.cancelled)).cbms_cancel_last_attempt_at).toBeTruthy();
    });
    it('a second run adds attempt 2 — still pending, never synced', async () => {
      await sync(new RecordingStub(), 'invoice', invId(I.pending));
      expect((await subs('invoice', invId(I.pending))).map((s: any) => s.attempt_no)).toEqual([1, 2]);
      expect(await inv(I.pending)).toMatchObject({ cbms_state: 'pending', cbms_attempts: 2, cbms_synced_at: null });
    });
  });

  describe('cbms_sync with a test client returning each outcome (US-BL-13.2)', () => {
    it('retryable_error x10: the task never throws, attempts reach 12 (2 + 10), the document is still pending', async () => {
      for (let n = 0; n < 10; n++) await sync(scripted('retryable_error'), 'invoice', invId(I.pending));
      expect(await inv(I.pending)).toMatchObject({ cbms_state: 'pending', cbms_attempts: 12 });
      expect((await subs('invoice', invId(I.pending))).at(-1)).toMatchObject({ attempt_no: 12, outcome: 'retryable_error', client_mode: 'live' });
    });
    it('a client that throws is recorded as retryable_error; the error text is stored nowhere', async () => {
      await sync(scripted('throw'), 'invoice', invId(I.pending));
      const rows = await subs('invoice', invId(I.pending));
      expect(rows.at(-1)).toMatchObject({ attempt_no: 13, outcome: 'retryable_error' });
      expect(JSON.stringify(rows)).not.toContain('SECRET-TOKEN-123');
    });
    it('rejected_permanent -> failed_permanent on the cancellation document only; later runs do not call the client', async () => {
      const calls: unknown[] = [];
      await sync(scripted('rejected_permanent', calls), 'invoice_cancellation', invId(I.cancelled));
      expect(await inv(I.cancelled)).toMatchObject({ cbms_cancel_state: 'failed_permanent', cbms_cancel_attempts: 2, cbms_state: 'not_required' });
      await sync(scripted('accepted', calls), 'invoice_cancellation', invId(I.cancelled));
      expect(calls).toHaveLength(1);
    });
    it('accepted -> synced with synced_at and external_ref (credit note); terminal: a re-run adds no row', async () => {
      const calls: unknown[] = [];
      await sync(scripted('accepted', calls), 'credit_note', CN1);
      expect(await cn()).toMatchObject({ cbms_state: 'synced', cbms_attempts: 2, cbms_external_ref: 'EXT-BLT14' });
      expect((await cn()).cbms_synced_at).toBeTruthy();
      const before = (await subs('credit_note', CN1)).length;
      await sync(scripted('accepted', calls), 'credit_note', CN1);
      expect((await subs('credit_note', CN1)).length).toBe(before); expect(calls).toHaveLength(1);
    });
    it('not_required / synced / failed_permanent / unknown documents: client not called, no row', async () => {
      const calls: unknown[] = [];
      for (const n of [I.notRequired, I.synced, I.failed]) await sync(scripted('accepted', calls), 'invoice', invId(n));
      await sync(scripted('accepted', calls), 'invoice', uid(999));
      expect(calls).toEqual([]);
      for (const n of [I.notRequired, I.synced, I.failed]) expect(await subs('invoice', invId(n))).toEqual([]);
    });
    it('the client receives the fiscal projection of the stored invoice (no test names) and idempotencyKey `<kind>:<id>`', async () => {
      const calls: any[] = [];
      await sync(scripted('retryable_error', calls), 'invoice', invId(I.pending));
      expect(calls[0]).toMatchObject({ tenantId: TENANT, idempotencyKey: `invoice:${invId(I.pending)}`, document: { kind: 'invoice', documentId: invId(I.pending), documentNo: `INV-BLT14-${I.pending}`, totals: { gross: 100000, net: 100000 } } });
    });
  });

  describe('cbms_sweep (US-BL-13.2, TRD §9: pending and last attempt older than min(2^attempts min, 6 h))', () => {
    it('enqueues exactly the due pending documents of all three kinds under job_key cbms:<kind>:<id>; not the fresh, capped-fresh, not_required, synced or failed_permanent ones', async () => {
      await plantAll();
      await setAttempts(I.pending, 2, 10 * MIN);        // 2^2 = 4 min < 10 min      -> due
      await setAttempts(I.due, 5, 40 * MIN);            // 32 min < 40 min           -> due
      await setAttempts(I.fresh, 2, 1 * MIN);           // 4 min > 1 min             -> not due
      await setAttempts(I.capped, 12, 7 * H);           // cap 6 h < 7 h             -> due
      await setAttempts(I.cappedFresh, 12, 5 * H);      // cap 6 h > 5 h             -> not due
      await asSystem([
        [`UPDATE billing.invoices SET cbms_cancel_attempts = 1, cbms_cancel_last_attempt_at = $3 WHERE tenant_id = $1 AND id = $2`, [TENANT, invId(I.cancelled), ago(5 * MIN)]], // 2 min < 5 min -> due
        [`UPDATE billing.credit_notes SET cbms_attempts = 3, cbms_last_attempt_at = $3 WHERE tenant_id = $1 AND id = $2`, [TENANT, CN1, ago(20 * MIN)]],                      // 8 min < 20 min -> due
        ...[I.notRequired, I.synced, I.failed].map((n): [string, unknown[]] => [`UPDATE billing.invoices SET cbms_attempts = 1, cbms_last_attempt_at = $3 WHERE tenant_id = $1 AND id = $2`, [TENANT, invId(n), ago(10 * H)]]),
      ]);
      const before = [await inv(I.pending), await inv(I.cancelled), await cn()];
      await sweep();
      const jobs = await jobKeys();
      expect(jobs.map((j: any) => j.key).sort()).toEqual([
        `cbms:credit_note:${CN1}`, `cbms:invoice:${invId(I.pending)}`, `cbms:invoice:${invId(I.due)}`, `cbms:invoice:${invId(I.capped)}`, `cbms:invoice_cancellation:${invId(I.cancelled)}`].sort());
      for (const j of jobs) expect(j.task_identifier).toBe(SYNC);
      const credit = jobs.find((j: any) => j.key === `cbms:credit_note:${CN1}`);
      expect(credit.payload).toEqual({ tenant_id: TENANT, document_kind: 'credit_note', document_id: CN1 });
      expect(jobs.find((j: any) => j.key.startsWith('cbms:invoice_cancellation:')).payload).toEqual({ tenant_id: TENANT, document_kind: 'invoice_cancellation', document_id: invId(I.cancelled) });
      // read-only on the documents
      expect([await inv(I.pending), await inv(I.cancelled), await cn()]).toEqual(before);
    });
    it('idempotent: a second sweep leaves one job per key (job_key dedupe), and the pending-documents gauge is set for this tenant', async () => {
      const metrics = await sweep();
      expect((await jobKeys()).length).toBe(5);
      const g = metrics.filter((m) => m.kind === 'set' && m.name === 'lims_billing_cbms_pending_documents');
      expect(g.length).toBeGreaterThan(0);
      for (const m of g) { expect(m.labels?.tenant_id).toBe(TENANT); expect(typeof m.labels?.state).toBe('string'); expect(Number.isInteger(m.value) && m.value >= 0).toBe(true); }
    });
    it('a document that keeps failing is swept forever: 12 attempts and 7 h old is still enqueued (never marked failed by the sweep)', async () => {
      expect(await inv(I.capped)).toMatchObject({ cbms_state: 'pending', cbms_attempts: 12 });
    });
  });

  describe('stale_1h gauge (page alert): live mode only, aged from created_at not from the last attempt', () => {
    const staleOf = async (mode: string) => {
      const prev = process.env['LIMS_BILLING_CBMS_MODE']; process.env['LIMS_BILLING_CBMS_MODE'] = mode;
      try { return (await sweep()).find((m) => m.kind === 'set' && m.name === 'lims_billing_cbms_pending_documents' && m.labels?.state === 'stale_1h')?.value; }
      finally { if (prev === undefined) delete process.env['LIMS_BILLING_CBMS_MODE']; else process.env['LIMS_BILLING_CBMS_MODE'] = prev; }
    };
    it('doc created 2 h ago whose last attempt was 5 min ago: stub -> 0, live -> 1; a doc created 10 min ago is not stale', async () => {
      await cleanup();
      try {
        await asSystem([...plantInvoice(I.pending, { created_at: ago(2 * H), issued_at: ago(2 * H), cbms_attempts: 3, cbms_last_attempt_at: ago(5 * MIN) }),
          ...plantInvoice(I.fresh, { created_at: ago(10 * MIN), issued_at: ago(10 * MIN) })]);
        expect(await staleOf('stub')).toBe(0);
        expect(await staleOf('live')).toBe(1);
      } finally { await plantAll(); }
    });
  });

  it('B31 end state the sync job must accept: a failed_permanent document moved back to pending by the DB guard is submitted again with the next attempt number', async () => {
    await asSystem([[`UPDATE billing.invoices SET cbms_state = 'pending' WHERE tenant_id = $1 AND id = $2`, [TENANT, invId(I.failed)]]]);
    await sync(new RecordingStub(), 'invoice', invId(I.failed));
    expect(await subs('invoice', invId(I.failed))).toEqual([expect.objectContaining({ attempt_no: 1, outcome: 'stub_recorded' })]);
    expect(await inv(I.failed)).toMatchObject({ cbms_state: 'pending', cbms_attempts: 1 });
  });
});
