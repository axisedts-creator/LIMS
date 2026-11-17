// BL-T09 live-DB integration (parallel prints): the row lock + the +1-only guard + print_log UNIQUE/CHECK + access_log, against the real schema as lims_app.
// done_when: "Original/copy marks; concurrent prints distinct numbers; access_log invoice.print / credit_note.print" (03-APP-FLOW §2.10 step 2, §5 "Concurrent print").
// Gated exactly like invoice.issue.live.test.ts: skipped unless both URLs are set (needs `pg`, loaded dynamically).
//   LIMS_TEST_DATABASE_URL      superuser URL of a migrated + seeded DB (tenant 01a1a98a-ac40-7000-8000-00000000a001, branch ...a101, centre ...a201). Seeds/inspects/cleans.
//   LIMS_TEST_APP_DATABASE_URL  URL that logs in as / may SET ROLE lims_app; service + repo run through createDb().requestTx as lims_app.
// Fixtures: fiscal year 2098/99, series INV:BLT09 / CN:BLT09, synthetic ids 0190c409-...; invoices/credit notes/print_log/activity removed in afterAll (audit.access_log is append-only
// even for the superuser: its rows stay, tagged by those entity ids). Uses the real core ctx.audit.access (audit.access_log) — no fake of the access log here.
// ASSUMED API: as print.service.test.ts (createInvoiceService({ repo: billingRepo, counter, events }).print / .printCreditNote; ctx.ports.IdentityPort faked for assertRole / settings / branding).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access } from '../../../../core/audit/access.js';
import { createDb } from '../../../../core/db/tx.js';
import { billingRepo } from '../../repository/index.js';
import { createInvoiceService } from '../invoice.service.js';

const SU = process.env['LIMS_TEST_DATABASE_URL'], APP = process.env['LIMS_TEST_APP_DATABASE_URL'];
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', BRANCH = '01a1a98a-ac40-7000-8000-00000000a101', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const OTHER_TENANT = '01a1a98a-ac40-7000-8000-00000000b001';
const CLAIMS = { actor_type: 'user', tenant_id: TENANT, sub: SYS, membership_id: MEMBERSHIP };
const uid = (n: number) => `0190c409-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FY = '2098/99';
const INV1 = uid(11), INV2 = uid(12), INV_C = uid(13), CN1 = uid(21), O1 = uid(1), O2 = uid(2), O3 = uid(3), PATIENT = uid(40);
const COPY_MARK = 'Copy of Original / प्रतिलिपि';
const N = 6;

const invoice = (id: string, seq: number, orderId: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, series: 'INV:BLT09', fiscal_year_bs: FY, invoice_seq: seq, invoice_no: `INV-BLT09-${seq}`,
  invoice_kind: 'tax_invoice', purpose: 'registration', order_id: orderId, patient_id: PATIENT, buyer_name: 'Test Patient (SYNTHETIC)', seller_name: 'Synthetic Lab',
  issued_at: new Date(Date.now() - (10 - seq) * 60_000).toISOString(), invoice_date_bs: '2098-01-01', gross_paisa: 1000, discount_paisa: 0, exempt_paisa: 1000, taxable_paisa: 0,
  vat_paisa: 0, other_tax_paisa: 0, net_paisa: 1000, prices_include_tax: false, quote_fingerprint: 'c'.repeat(64), status: 'issued', is_active: true, print_count: 0,
  cbms_state: 'pending', cbms_attempts: 0, version: 1, created_by: SYS, updated_by: SYS, ...over,
});
const creditNote = (id: string, seq: number, invoiceId: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, series: 'CN:BLT09', fiscal_year_bs: FY, credit_note_seq: seq, credit_note_no: `CN-BLT09-${seq}`, kind: 'cancellation',
  invoice_id: invoiceId, invoice_no: 'INV-BLT09-3', invoice_fiscal_year_bs: FY, buyer_name: 'Test Patient (SYNTHETIC)', issued_at: new Date().toISOString(), credit_note_date_bs: '2098-01-01',
  reason_code: 'billing_error', gross_paisa: 1000, discount_paisa: 0, exempt_paisa: 1000, taxable_paisa: 0, vat_paisa: 0, other_tax_paisa: 0, net_paisa: 1000, is_active: true,
  print_count: 0, cbms_state: 'pending', cbms_attempts: 0, created_by: SYS, updated_by: SYS, ...over,
});

describe.skipIf(!SU || !APP)('print over a real DB (lims_app): parallel prints', () => {
  let su: any, app: any, db: ReturnType<typeof createDb>;
  let reqN = 0;
  const svc = createInvoiceService({ repo: billingRepo, counter: { allocate: async () => { throw new Error('print must never allocate'); } } as never, events: {} as never }) as any;
  const identity = {
    async assertRole() { /* the permission itself is the pipeline's; denial is covered in print.service.test.ts */ },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu', branding: { legalName: 'Synthetic Lab', displayName: 'Synthetic Lab', addressLines: [], phones: [] } }; },
    async readBrandingAsset() { throw new Error('no assets in this fixture'); },
  };
  const requestTx = <T>(fn: Parameters<typeof db.requestTx<T>>[1], claims: object = CLAIMS) =>
    db.requestTx({ claims: claims as never, requestId: uid(900 + ++reqN), clientIp: '203.0.113.7', operation: { module: 'billing', operationId: 'BL-T09.live' } }, fn);
  const ctxOf = (tx: unknown, tenantId = TENANT) => {
    const c: any = { tenantId, requestId: uid(900 + reqN), actor: { type: 'user', id: SYS, membershipId: MEMBERSHIP }, tx, now: () => new Date().toISOString(), ports: { IdentityPort: identity } };
    c.audit = { access: (e: never) => access(c, e) };
    return c;
  };
  const printInv = (invoiceId: string, reasonCode?: string) => requestTx((tx) => svc.print(ctxOf(tx), { invoiceId, ...(reasonCode ? { reasonCode } : {}) }));
  const printCn = (creditNoteId: string) => requestTx((tx) => svc.printCreditNote(ctxOf(tx), { creditNoteId }));

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
    [`DELETE FROM billing.activity_log WHERE tenant_id = $1 AND document_id = ANY($2::uuid[])`, [TENANT, [INV1, INV2, INV_C, CN1]]],
    [`DELETE FROM billing.print_log WHERE tenant_id = $1 AND document_id = ANY($2::uuid[])`, [TENANT, [INV1, INV2, INV_C, CN1]]],
    [`DELETE FROM billing.credit_notes WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
    [`DELETE FROM billing.invoices WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]],
  ]);
  const one = async (sql: string, v: unknown[]) => (await su.query(sql, v)).rows;

  beforeAll(async () => {
    const pg: any = await import(['p', 'g'].join(''));
    const Pool = (pg.default ?? pg).Pool;
    su = new Pool({ connectionString: SU, max: 3 }); app = new Pool({ connectionString: APP, max: 16 });
    db = createDb({ pool: app, identitySystemActorId: SYS });
    await cleanup().catch(() => undefined);
    await asSystem([ins('billing.invoices', invoice(INV1, 1, O1)), ins('billing.invoices', invoice(INV2, 2, O2)),
      ins('billing.invoices', invoice(INV_C, 3, O3, { status: 'cancelled', is_active: false, cancelled_at: new Date().toISOString(), cancel_reason_code: 'billing_error', credit_note_id: CN1 }))]);
  });
  afterAll(async () => { if (su) await cleanup().catch(() => undefined); await su?.end(); await app?.end(); });

  it(`${N} parallel prints of one invoice -> print_no 1..${N} each once, one original + ${N - 1} copies, ${N} unique print_log rows, print_count ${N}, ${N} activity + ${N} invoice.print access rows`, async () => {
    const res: any[] = await Promise.all(Array.from({ length: N }, () => printInv(INV1)));
    expect(res.map((r) => r.print_no).sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(res.filter((r) => r.copy_mark === undefined).map((r) => r.print_no)).toEqual([1]);
    expect(res.filter((r) => r.copy_mark === COPY_MARK)).toHaveLength(N - 1);
    const log = await one(`SELECT print_no, is_copy, created_by FROM billing.print_log WHERE tenant_id = $1 AND document_kind = 'invoice' AND document_id = $2 ORDER BY print_no`, [TENANT, INV1]);
    expect(log.map((r: any) => r.print_no)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(log.map((r: any) => r.is_copy)).toEqual(log.map((r: any) => r.print_no > 1));
    expect(log.every((r: any) => r.created_by === SYS)).toBe(true);
    expect((await one(`SELECT print_count, last_printed_at FROM billing.invoices WHERE tenant_id = $1 AND id = $2`, [TENANT, INV1]))[0]).toMatchObject({ print_count: N });
    // 03-APP-FLOW §2.10 step 2: each print bumps version (fixture starts at 1), so optimistic concurrency sees prints.
    expect((await one(`SELECT version FROM billing.invoices WHERE tenant_id = $1 AND id = $2`, [TENANT, INV1]))[0].version).toBe(1 + N);
    expect(await one(`SELECT 1 FROM billing.activity_log WHERE tenant_id = $1 AND document_id = $2 AND action = 'invoice_printed'`, [TENANT, INV1])).toHaveLength(N);
    expect(await one(`SELECT 1 FROM audit.access_log WHERE tenant_id = $1 AND action = 'invoice.print' AND entity_type = 'invoice' AND entity_id = $2 AND outcome = 'allowed'`, [TENANT, INV1])).toHaveLength(N);
  });

  it('a failing transaction after the number is taken rolls back the count and the log: the next print takes that number (no gap)', async () => {
    await expect(requestTx(async (tx) => { await svc.print(ctxOf(tx), { invoiceId: INV2 }); throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await one(`SELECT print_count FROM billing.invoices WHERE tenant_id = $1 AND id = $2`, [TENANT, INV2]))[0].print_count).toBe(0);
    expect(await one(`SELECT 1 FROM billing.print_log WHERE tenant_id = $1 AND document_id = $2`, [TENANT, INV2])).toHaveLength(0);
    const r: any = await printInv(INV2, 'first_print');
    expect(r.print_no).toBe(1);
    expect('copy_mark' in r).toBe(false);
  });

  it('cancelled invoice: parallel prints still count (banner + distinct numbers); its credit note prints in its own series with credit_note.print access rows', async () => {
    await asSystem([ins('billing.credit_notes', creditNote(CN1, 1, INV_C))]);
    const inv: any[] = await Promise.all([printInv(INV_C), printInv(INV_C), printInv(INV_C)]);
    expect(inv.map((r) => r.print_no).sort()).toEqual([1, 2, 3]);
    expect(inv.every((r) => /CANCELLED/.test(r.document.cancelled_banner))).toBe(true);
    const cn: any[] = await Promise.all([printCn(CN1), printCn(CN1)]);
    expect(cn.map((r) => r.print_no).sort()).toEqual([1, 2]);
    expect((await one(`SELECT print_count FROM billing.credit_notes WHERE tenant_id = $1 AND id = $2`, [TENANT, CN1]))[0].print_count).toBe(2);
    expect((await one(`SELECT print_count FROM billing.invoices WHERE tenant_id = $1 AND id = $2`, [TENANT, INV_C]))[0].print_count).toBe(3);
    expect(await one(`SELECT 1 FROM billing.print_log WHERE tenant_id = $1 AND document_kind = 'credit_note' AND document_id = $2`, [TENANT, CN1])).toHaveLength(2);
    expect(await one(`SELECT 1 FROM audit.access_log WHERE tenant_id = $1 AND action = 'credit_note.print' AND entity_type = 'credit_note' AND entity_id = $2`, [TENANT, CN1])).toHaveLength(2);
  });

  it('tenancy (RLS): another tenant\'s claims cannot print tenant A\'s invoice (common.not_found) and the count does not move', async () => {
    const before = (await one(`SELECT print_count FROM billing.invoices WHERE tenant_id = $1 AND id = $2`, [TENANT, INV1]))[0].print_count;
    const other = { actor_type: 'user', tenant_id: OTHER_TENANT, sub: SYS };
    await expect(requestTx((tx) => svc.print(ctxOf(tx, OTHER_TENANT), { invoiceId: INV1 }), other)).rejects.toMatchObject({ code: 'common.not_found' });
    expect((await one(`SELECT print_count FROM billing.invoices WHERE tenant_id = $1 AND id = $2`, [TENANT, INV1]))[0].print_count).toBe(before);
  });
});
