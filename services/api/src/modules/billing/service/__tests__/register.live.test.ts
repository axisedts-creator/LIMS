// BL-T15 live-DB integration: registers + export create over the real schema as lims_app (real SQL of billingRepo.listSalesRegister / listCancelledInvoices / listCreditNoteRegister / listAuditTrail /
// countExportRows / insertExportJob / enqueueExportRender, real audit.access_log). Gated exactly like print.live.test.ts: skipped unless LIMS_TEST_DATABASE_URL (superuser, migrated + seeded) AND
// LIMS_TEST_APP_DATABASE_URL (may SET ROLE lims_app) are set. Fixtures: fiscal year 2097/98, series INV:BLT15 / CN:BLT15, ids 0190c415-...; removed in afterAll (audit.access_log is append-only; its rows stay).
// Proves: B26 Σ net == Σ credit_notes.net_paisa for the same issued_at range + centre (periodic NULL-centre notes excluded by a centre filter), cancelled invoices listed and marked, ordering, row-level
// tenant scoping, B28 inserts a queued export_jobs row + a billing.export_render job + ONE data.export/create access_log row in the caller's tx, the PDF cap on the real count query.
// ASSUMED API: as register.service.test.ts / export.service.test.ts with repo = billingRepo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access } from '../../../../core/audit/access.js';
import { createDb } from '../../../../core/db/tx.js';
import { billingRepo } from '../../repository/index.js';
import { createExportService } from '../export.service.js';
import { createRegisterService } from '../register.service.js';

const SU = process.env['LIMS_TEST_DATABASE_URL'], APP = process.env['LIMS_TEST_APP_DATABASE_URL'];
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', BRANCH = '01a1a98a-ac40-7000-8000-00000000a101', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const CLAIMS = { actor_type: 'user', tenant_id: TENANT, sub: SYS, membership_id: MEMBERSHIP };
const uid = (n: number) => `0190c415-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FY = '2097/98', FROM = '2097-01-01T00:00:00.000Z', TO = '2097-12-31T00:00:00.000Z', AT = '2097-06-01T06:00:00.000Z';
const INV = [uid(11), uid(12), uid(13)], CNS = [uid(21), uid(22), uid(23)];

const invoice = (id: string, seq: number, over: Record<string, unknown> = {}) => ({
  id, tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, series: 'INV:BLT15', fiscal_year_bs: FY, invoice_seq: seq, invoice_no: `INV-BLT15-${seq}`, invoice_kind: 'tax_invoice', purpose: 'registration',
  order_id: uid(100 + seq), patient_id: uid(40), buyer_name: 'Test Patient (SYNTHETIC)', seller_name: 'Synthetic Lab', issued_at: AT, invoice_date_bs: '2097-01-01', gross_paisa: 1000, discount_paisa: 0, exempt_paisa: 1000,
  taxable_paisa: 0, vat_paisa: 0, other_tax_paisa: 0, net_paisa: 1000, prices_include_tax: false, quote_fingerprint: 'c'.repeat(64), status: 'issued', is_active: true, print_count: 0, cbms_state: 'pending',
  cbms_attempts: 0, version: 1, created_by: SYS, updated_by: SYS, ...over,
});
const creditNote = (id: string, seq: number, invoiceId: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, series: 'CN:BLT15', fiscal_year_bs: FY, credit_note_seq: seq, credit_note_no: `CN-BLT15-${seq}`, kind: 'partial', invoice_id: invoiceId, invoice_no: 'INV-BLT15-1',
  invoice_fiscal_year_bs: FY, buyer_name: 'Test Patient (SYNTHETIC)', issued_at: AT, credit_note_date_bs: '2097-01-01', reason_code: 'billing_error', gross_paisa: 500, discount_paisa: 0, exempt_paisa: 500, taxable_paisa: 0,
  vat_paisa: 0, other_tax_paisa: 0, net_paisa: 500, is_active: true, print_count: 0, cbms_state: 'pending', cbms_attempts: 0, created_by: SYS, updated_by: SYS, ...over,
});

describe.skipIf(!SU || !APP)('registers + exports over a real DB (lims_app)', () => {
  let su: any, app: any, db: ReturnType<typeof createDb>; let reqN = 0;
  const repo = billingRepo as never;
  const registers = createRegisterService({ repo }) as any;
  const exportsOf = (config: object) => createExportService({ repo, config: config as never }) as any;
  const identity = { async assertRole() { /* permission itself is the pipeline's */ } };
  const requestTx = <T>(fn: Parameters<typeof db.requestTx<T>>[1]) =>
    db.requestTx({ claims: CLAIMS as never, requestId: uid(900 + ++reqN), clientIp: '203.0.113.7', operation: { module: 'billing', operationId: 'BL-T15.live' } }, fn);
  const ctxOf = (tx: unknown) => { const c: any = { tenantId: TENANT, requestId: uid(900 + reqN), actor: { type: 'user', id: SYS, membershipId: MEMBERSHIP }, tx, now: () => new Date().toISOString(), ports: { IdentityPort: identity } };
    c.audit = { access: (e: never) => access(c, e) }; return c; };
  async function asSystem(stmts: Array<[string, unknown[]?]>) {
    const c = await su.connect();
    try {
      await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
      for (const [t, v] of stmts) await c.query(t, v);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  const ins = (table: string, row: object): [string, unknown[]] => [`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)]];
  const cleanup = () => asSystem([
    [`DELETE FROM billing.export_jobs WHERE tenant_id = $1 AND requested_by_membership_id = $2 AND created_at > now() - interval '1 day' AND filters->>'fiscal_year_bs' = $3`, [TENANT, MEMBERSHIP, FY]],
    [`DELETE FROM billing.activity_log WHERE tenant_id = $1 AND document_no LIKE 'INV-BLT15-%'`, [TENANT]],
    [`DELETE FROM billing.credit_notes WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
    [`DELETE FROM billing.invoices WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
  ]);
  const one = async (sql: string, v: unknown[]) => (await su.query(sql, v)).rows;

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    const Pool = (pg.default ?? pg).Pool;
    su = new Pool({ connectionString: SU, max: 3 }); app = new Pool({ connectionString: APP, max: 8 }); db = createDb({ pool: app, identitySystemActorId: SYS });
    await cleanup().catch(() => undefined);
    await asSystem([
      ins('billing.invoices', invoice(INV[0]!, 1)), ins('billing.invoices', invoice(INV[1]!, 2)),
      ins('billing.invoices', invoice(INV[2]!, 3, { status: 'cancelled', is_active: false, cancelled_at: AT, cancel_reason_code: 'billing_error', credit_note_id: CNS[2] })),
      ins('billing.credit_notes', creditNote(CNS[0]!, 1, INV[0]!, { kind: 'partial', net_paisa: 500, exempt_paisa: 500, gross_paisa: 500 })),
      ins('billing.credit_notes', creditNote(CNS[1]!, 2, INV[1]!, { kind: 'partial', net_paisa: 300, exempt_paisa: 300, gross_paisa: 300, centre_id: null })), // periodic-style: no centre
      ins('billing.credit_notes', creditNote(CNS[2]!, 3, INV[2]!, { kind: 'cancellation', net_paisa: 1000, exempt_paisa: 1000, gross_paisa: 1000 })),
    ]);
  });
  afterAll(async () => { if (su) await cleanup().catch(() => undefined); await su?.end(); await app?.end(); });

  it('B24: three invoices in FY order, cancelled one present and marked, SN 1..3, dates and money as integers', async () => {
    const r = await requestTx((tx) => registers.sales(ctxOf(tx), { fiscalYearBs: FY, issuedAtFrom: FROM, issuedAtTo: TO }));
    expect(r.data.map((x: any) => [x.sn, x.invoice_no, x.status])).toEqual([[1, 'INV-BLT15-1', 'issued'], [2, 'INV-BLT15-2', 'issued'], [3, 'INV-BLT15-3', 'cancelled']]);
    expect(r.data[0].total).toEqual({ amount_paisa: 1000, currency: 'NPR' });
  });
  it('B25 lists exactly the cancelled invoice with its reason', async () => {
    const r = await requestTx((tx) => registers.cancelled(ctxOf(tx), { fiscalYearBs: FY, issuedAtFrom: FROM, issuedAtTo: TO }));
    expect(r.data.map((x: any) => [x.invoice_no, x.reason_code])).toEqual([['INV-BLT15-3', 'billing_error']]);
  });
  it('B26: Σ net == Σ billing.credit_notes.net_paisa for the range (all centres: 1800) and for the centre filter (NULL-centre note excluded: 1500); ordered by credit_note_seq; both kinds', async () => {
    const all = await requestTx((tx) => registers.creditNotes(ctxOf(tx), { fiscalYearBs: FY, issuedAtFrom: FROM, issuedAtTo: TO }));
    const db1 = await one(`SELECT sum(net_paisa)::bigint AS s FROM billing.credit_notes WHERE tenant_id = $1 AND fiscal_year_bs = $2 AND issued_at BETWEEN $3 AND $4`, [TENANT, FY, FROM, TO]);
    expect(all.data.reduce((t: number, x: any) => t + x.net.amount_paisa, 0)).toBe(Number(db1[0].s)); expect(Number(db1[0].s)).toBe(1800);
    expect(all.data.map((x: any) => x.credit_note_no)).toEqual(['CN-BLT15-1', 'CN-BLT15-2', 'CN-BLT15-3']); expect(new Set(all.data.map((x: any) => x.kind))).toEqual(new Set(['partial', 'cancellation']));
    const centre = await requestTx((tx) => registers.creditNotes(ctxOf(tx), { fiscalYearBs: FY, issuedAtFrom: FROM, issuedAtTo: TO, centreId: CENTRE }));
    expect(centre.data.reduce((t: number, x: any) => t + x.net.amount_paisa, 0)).toBe(1500); expect(centre.data.map((x: any) => x.credit_note_no)).not.toContain('CN-BLT15-2');
  });
  it('range edges: issued_at outside the range yields nothing', async () => {
    const r = await requestTx((tx) => registers.creditNotes(ctxOf(tx), { issuedAtFrom: '2098-01-01T00:00:00.000Z', issuedAtTo: '2098-12-31T00:00:00.000Z', fiscalYearBs: FY }));
    expect(r.data).toEqual([]);
  });
  it('B28 over the real DB: queued export_jobs row, billing.export_render job, exactly one data.export/create access_log row, ExportJob without storage fields', async () => {
    const svc = exportsOf({ exportMaxRows: 100000, exportPdfMaxRows: 5000, exportTtlHours: 24 });
    const job = await requestTx((tx) => svc.create(ctxOf(tx), { kind: 'sales_register', format: 'xml', filters: { fiscal_year_bs: FY, from: FROM, to: TO } }));
    expect(job).toMatchObject({ kind: 'sales_register', format: 'xml', status: 'queued' }); expect('object_path' in job).toBe(false);
    const row = (await one(`SELECT status, requested_by_membership_id, bucket, object_path FROM billing.export_jobs WHERE tenant_id = $1 AND id = $2`, [TENANT, job.id]))[0];
    expect(row).toMatchObject({ status: 'queued', requested_by_membership_id: MEMBERSHIP, bucket: null, object_path: null });
    expect(await one(`SELECT 1 FROM audit.access_log WHERE tenant_id = $1 AND action = 'data.export' AND entity_type = 'billing_export' AND entity_id = $2 AND outcome = 'allowed' AND detail->>'stage' = 'create'`, [TENANT, job.id])).toHaveLength(1);
    expect(await one(`SELECT 1 FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'billing.export_render' AND j.payload->>'export_id' = $1`, [job.id])).toHaveLength(1);
  });
  it('PDF cap on the real count query: a cap of 2 rows rejects the 3-invoice register (422 billing.export_too_large) and writes no export_jobs row', async () => {
    const svc = exportsOf({ exportMaxRows: 100000, exportPdfMaxRows: 2, exportTtlHours: 24 });
    const before = Number((await one(`SELECT count(*) AS c FROM billing.export_jobs WHERE tenant_id = $1`, [TENANT]))[0].c);
    await expect(requestTx((tx) => svc.create(ctxOf(tx), { kind: 'sales_register', format: 'pdf', filters: { fiscal_year_bs: FY, from: FROM, to: TO } }))).rejects.toMatchObject({ code: 'billing.export_too_large' });
    expect(Number((await one(`SELECT count(*) AS c FROM billing.export_jobs WHERE tenant_id = $1`, [TENANT]))[0].c)).toBe(before);
  });
});
