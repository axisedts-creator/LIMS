// T0B-PRINTCFG-1 done_when (4): the print record stores the style; a reprint of an old bill keeps its ORIGINAL style (print_no 1) unless the caller chooses another (LD-316). Real PG17, lims_api under RLS.
// DB: tests/reporting/T0B-PRINTCFG-1.pg.sh exports LIMS_TEST_APP_URL (lims_api) and LIMS_TEST_SUPER_URL (superuser). Missing database = FAILURE (never a skip). Fixtures: fiscal year 2097/98, series INV:PCFG / CN:PCFG.
// PINNED: "original style" = the style of the print_log row with print_no 1; rows printed before the column existed read `full`; a reprint with an explicit style stores that style and does not change the original.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access } from '../../../../core/audit/access.js';
import { createDb } from '../../../../core/db/tx.js';
import { billingRepo } from '../../repository/index.js';
import { createInvoiceService } from '../invoice.service.js';

const APP = process.env['LIMS_TEST_APP_URL'], SU = process.env['LIMS_TEST_SUPER_URL'];
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', BRANCH = '01a1a98a-ac40-7000-8000-00000000a101', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const OTHER = '01a1a98a-ac40-7000-8000-00000000b001';
const MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500', SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const uid = (n: number) => `0190c501-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FY = '2097/98'; const INV_PLAIN = uid(11), INV_FULL = uid(12), INV_OLD = uid(13), CN1 = uid(21), O1 = uid(1), O2 = uid(2), O3 = uid(3), PATIENT = uid(40);
const invoice = (id: string, seq: number, orderId: string, over: Record<string, unknown> = {}) => ({
  id, tenant_id: TENANT, branch_id: BRANCH, centre_id: CENTRE, series: 'INV:PCFG', fiscal_year_bs: FY, invoice_seq: seq, invoice_no: `INV-PCFG-${seq}`, invoice_kind: 'tax_invoice', purpose: 'registration',
  order_id: orderId, patient_id: PATIENT, buyer_name: 'Test Patient (SYNTHETIC)', seller_name: 'Synthetic Lab', issued_at: new Date(Date.now() - 60_000).toISOString(), invoice_date_bs: '2097-01-01',
  gross_paisa: 1000, discount_paisa: 0, exempt_paisa: 1000, taxable_paisa: 0, vat_paisa: 0, other_tax_paisa: 0, net_paisa: 1000, prices_include_tax: false, quote_fingerprint: 'c'.repeat(64),
  status: 'issued', is_active: true, print_count: 0, cbms_state: 'pending', cbms_attempts: 0, version: 1, created_by: SYS, updated_by: SYS, ...over });

describe('print style over a real database', () => {
  let su: any, db: ReturnType<typeof createDb>; let reqN = 0;
  const svc = createInvoiceService({ repo: billingRepo, counter: { allocate: async () => { throw new Error('print must never allocate'); } } as never, events: {} as never }) as any;
  const identity = { async assertRole() { /* gate is the pipeline's */ }, async getTenantSettings() { return { timezone: 'Asia/Kathmandu', branding: { legalName: 'Synthetic Lab', displayName: 'Synthetic Lab', addressLines: [], phones: [] } }; },
    async readBrandingAsset() { throw new Error('no assets in this fixture'); } };
  const run = <T>(fn: (ctx: any) => Promise<T>, tenant = TENANT) => db.requestTx({ claims: { actor_type: 'user', tenant_id: tenant, sub: SYS, membership_id: MEMBERSHIP } as never, requestId: uid(900 + ++reqN), clientIp: '203.0.113.7',
    operation: { module: 'billing', operationId: 'T0B-PRINTCFG-1.live' } }, async (tx) => {
    const c: any = { tenantId: tenant, requestId: uid(900 + reqN), actor: { type: 'user', id: SYS, membershipId: MEMBERSHIP }, tx, now: () => new Date().toISOString(), ports: { IdentityPort: identity } };
    c.audit = { access: (e: never) => access(c, e) }; return fn(c);
  });
  const print = (invoiceId: string, extra: Record<string, unknown> = {}) => run((c) => svc.print(c, { invoiceId, ...extra }));
  const asSystem = async (stmts: Array<[string, unknown[]?]>) => { const c = await su.connect(); try { await c.query('BEGIN'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TENANT, sub: SYS, actor_type: 'system' })]);
    for (const [t, v] of stmts) await c.query(t, v); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); } };
  const ins = (table: string, row: object): [string, unknown[]] => [`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, [JSON.stringify(row)]];
  const cleanup = () => asSystem([[`DELETE FROM billing.activity_log WHERE tenant_id = $1 AND document_id = ANY($2::uuid[])`, [TENANT, [INV_PLAIN, INV_FULL, INV_OLD, CN1]]],
    [`DELETE FROM billing.print_log WHERE tenant_id = $1 AND document_id = ANY($2::uuid[])`, [TENANT, [INV_PLAIN, INV_FULL, INV_OLD, CN1]]], [`DELETE FROM billing.invoices WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]], [`DELETE FROM billing.fiscal_counters WHERE tenant_id = $1 AND fiscal_year_bs = $2`, [TENANT, FY]]]);
  const styles = async (id: string) => (await su.query(`SELECT print_no, style FROM billing.print_log WHERE tenant_id = $1 AND document_id = $2 ORDER BY print_no`, [TENANT, id])).rows.map((r: any) => [r.print_no, r.style]);

  beforeAll(async () => {
    if (!APP || !SU) throw new Error('LIMS_TEST_APP_URL and LIMS_TEST_SUPER_URL are required (run tests/reporting/T0B-PRINTCFG-1.pg.sh)');
    const pg: any = await import(['p', 'g'].join('')); const Pool = (pg.default ?? pg).Pool;
    su = new Pool({ connectionString: SU, max: 3 }); db = createDb({ pool: new Pool({ connectionString: APP, max: 8 }), identitySystemActorId: SYS });
    await cleanup().catch(() => undefined);
    // chronology trigger (spec'd, not under test): billing.fiscal_counters.last_no must equal invoice_seq before each invoice insert; a counter only rises by 1 per UPDATE
    const bump = (n: number): [string, unknown[]] => [`UPDATE billing.fiscal_counters SET last_no = $3 WHERE tenant_id = $1 AND series = 'INV:PCFG' AND fiscal_year_bs = $2`, [TENANT, FY, n]];
    await asSystem([ins('billing.fiscal_counters', { tenant_id: TENANT, series: 'INV:PCFG', fiscal_year_bs: FY, last_no: 1, created_by: SYS, updated_by: SYS }), ins('billing.invoices', invoice(INV_PLAIN, 1, O1)),
      bump(2), ins('billing.invoices', invoice(INV_FULL, 2, O2)), bump(3), ins('billing.invoices', invoice(INV_OLD, 3, O3, { print_count: 1 })),
      // the legacy row is inserted WITHOUT the style column so the DB default (full) is what is read back
      [`INSERT INTO billing.print_log (id, tenant_id, centre_id, document_kind, document_id, document_no, print_no, is_copy, printed_at, created_by) VALUES ($1,$2,$3,'invoice',$4,'INV-PCFG-3',1,false,now(),$5)`, [uid(500), TENANT, CENTRE, INV_OLD, SYS]]]);
  });
  afterAll(async () => { if (su) await cleanup().catch(() => undefined); await su?.end(); });

  it('plain_bw first print stores plain_bw; a reprint WITHOUT a style keeps plain_bw; a reprint with style full stores full; the next reprint without a style still follows the ORIGINAL (plain_bw)', async () => {
    const p1: any = await print(INV_PLAIN, { style: 'plain_bw' }); expect(p1.style).toBe('plain_bw');
    const p2: any = await print(INV_PLAIN, { reasonCode: 'reprint' }); expect(p2).toMatchObject({ print_no: 2, style: 'plain_bw' }); expect(p2.document.branding.images).toEqual([]);
    const p3: any = await print(INV_PLAIN, { style: 'full', reasonCode: 'customer_copy' }); expect(p3).toMatchObject({ print_no: 3, style: 'full' });
    const p4: any = await print(INV_PLAIN); expect(p4).toMatchObject({ print_no: 4, style: 'plain_bw' });
    expect(await styles(INV_PLAIN)).toEqual([[1, 'plain_bw'], [2, 'plain_bw'], [3, 'full'], [4, 'plain_bw']]);
  });
  it('a first print without a style is full and its reprints stay full; an explicit plain_bw copy of a full bill is allowed and does not change the original', async () => {
    expect(((await print(INV_FULL)) as any).style).toBe('full');
    expect(((await print(INV_FULL)) as any).style).toBe('full');
    expect(((await print(INV_FULL, { style: 'plain_bw' })) as any).style).toBe('plain_bw');
    expect(((await print(INV_FULL)) as any).style).toBe('full');
    expect(await styles(INV_FULL)).toEqual([[1, 'full'], [2, 'full'], [3, 'plain_bw'], [4, 'full']]);
  });
  it('a bill printed before the style column existed (print_no 1 row without a style) reads full and its reprint is full', async () => {
    expect(await styles(INV_OLD)).toEqual([[1, 'full']]);
    expect(((await print(INV_OLD)) as any)).toMatchObject({ print_no: 2, style: 'full' });
  });
  it('an unknown style is refused (common.validation_failed) and writes nothing; another tenant cannot print or read the bill (common.not_found)', async () => {
    const before = await styles(INV_PLAIN);
    await expect(print(INV_PLAIN, { style: 'sepia' })).rejects.toMatchObject({ code: 'common.validation_failed' });
    expect(await styles(INV_PLAIN)).toEqual(before);
    await expect(run((c) => svc.print(c, { invoiceId: INV_PLAIN, style: 'plain_bw' }), OTHER)).rejects.toMatchObject({ code: 'common.not_found' });
    expect(await styles(INV_PLAIN)).toEqual(before);
  });
  it('parallel prints with mixed styles keep one row per print_no and every style valid', async () => {
    const out: any[] = await Promise.all([print(INV_PLAIN, { style: 'plain_bw' }), print(INV_PLAIN, { style: 'full' }), print(INV_PLAIN), print(INV_PLAIN, { style: 'plain_bw' })]);
    expect(new Set(out.map((r) => r.print_no)).size).toBe(4);
    for (const r of out) expect(['full', 'plain_bw']).toContain(r.style);
    const rows = await styles(INV_PLAIN); expect(rows.map((r: any) => r[0])).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
  });
});
