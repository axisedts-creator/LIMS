// BL-T18 per-tenant export/restore (US-BL-15.1; 02-TRD §13, §7.2 row `billing.export_tenant`; 04 D16 / B17; 07-SECURITY storage + cross-tenant rows).
// done_when: "Checksums match; zero foreign rows; gapless continuation".
// US-BL-15.2 (no SEQUENCE in billing, tenant-leading indexes, UNIQUE (tenant_id,id)) is already asserted by db/tests/frontdesk_billing/T0B-10.C4_schema.test.sql and is not repeated.
//
// Part 1 (always runs): manifest wiring, tenant guard, runbook exists. Part 2 (live, SKIPPED unless both URLs are set):
//   LIMS_TEST_DATABASE_URL          superuser URL of a migrated + seeded DB (tenants ...a001 = tenant_a, ...b001 = tenant_b)
//   LIMS_TEST_RESTORE_DATABASE_URL  superuser URL of a SECOND database with the same DDL + seeds (the "fresh DB"). Tenant-scoped billing rows in it are purged
//                                   before and after (so it models an empty billing schema); core.* seed rows stay (billing FKs point at them).
// Fixtures: FY 2098/99 rows for both tenants, removed from the source in afterAll. Synthetic data only.
//
// ASSUMED CONTRACT (spec silent on archive format/key/restore entry point; writer: dispute if wrong):
//   services/worker/src/jobs/billing/tasks/export_tenant.ts exports
//     EXPORT_TENANT = 'billing.export_tenant';  exportTenant: TaskHandler   (payload {tenant_id}; reads only through ctx.tx; ctx.tenantId must equal payload.tenant_id,
//       otherwise it resolves without any query and without any storage.put, like integrity_check)
//     openArchive(bytes: Uint8Array, keyBase64: string) -> { manifest: { tenant_id, tables: Array<{ table, row_count, sha256 }> }, rows: Record<table, Array<Record<string, unknown>>> }
//       (throws on a wrong key or any modified byte)
//   exportTenant writes ONE object: ctx.storage.put('billing-exports', '<tenant_id>/<...>', bytes, { contentType, ifAbsent: true }); bytes are encrypted with the key
//   process.env.LIMS_BILLING_EXPORT_KEY (base64, 32 bytes). manifest.tables = EVERY billing table that has a tenant_id column (empty ones with row_count 0; g_cs_* excluded),
//   in FK order (parent before child; self-references ignored), sha256 = hex of the table's rows ordered by primary key (stable for unchanged data, changes when a row changes).
//   Rows are JSON objects keyed by column name (generated columns included or not, the test only inserts non-generated columns).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const SU = process.env['LIMS_TEST_DATABASE_URL'], RDB = process.env['LIMS_TEST_RESTORE_DATABASE_URL'];
const TA = '01a1a98a-ac40-7000-8000-00000000a001', BR_A = '01a1a98a-ac40-7000-8000-00000000a101', CEN_A = '01a1a98a-ac40-7000-8000-00000000a201';
const TB = '01a1a98a-ac40-7000-8000-00000000b001', BR_B = '01a1a98a-ac40-7000-8000-00000000b101', CEN_B = '01a1a98a-ac40-7000-8000-00000000b201';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const EXPORT = 'billing.export_tenant', CHECK = 'billing.integrity_check', METRIC = 'lims_billing_integrity_violations_total';
const FY = '2098/99', FPR = 'a'.repeat(64);
const KEY = randomBytes(32).toString('base64');
const uid = (p: string, n: number) => `${p}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REPO = resolve(import.meta.dirname, '../../../../../../..');
const WORKER = resolve(REPO, 'services/worker/src/jobs/billing');
const TASK_FILE = pathToFileURL(resolve(WORKER, 'tasks/export_tenant.ts')).href;
const WORKER_BILLING = pathToFileURL(resolve(WORKER, 'index.ts')).href;

const load = async (p: string): Promise<any> => import(/* @vite-ignore */ p);
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
function fakeCtx(over: Record<string, unknown> = {}) {
  const puts: any[] = [];
  const tx = { query: vi.fn(async () => { throw new Error('tx must not be used'); }) };
  const ctx: any = { tenantId: TA, tx, actor: { type: 'system', id: SYS }, requestId: uid('0190c418', 1), attempt: 1, maxAttempts: 1, jobId: '1', now: () => new Date().toISOString(),
    isNewer: () => true, events: {}, core: {}, files: {}, audit: {}, log: quiet, metrics: { inc() {}, set() {}, observe() {} },
    storage: { put: vi.fn(async (...a: any[]) => { puts.push(a); return { sha256: '0'.repeat(64), byteSize: 0 }; }) }, ...over };
  ctx.db = { tx: async (fn: any) => fn(ctx) };
  return { ctx, puts, tx };
}

describe('billing.export_tenant: wiring, tenant guard, runbook (always runs)', () => {
  it('is registered in the billing manifest as a manual task: maxAttempts 1 and NOT on the crontab', async () => {
    const m = (await load(WORKER_BILLING)).manifest;
    expect(typeof m.tasks[EXPORT]).toBe('function');
    expect(m.maxAttempts[EXPORT]).toBe(1);
    expect((m.crontab as any[]).filter((c) => c.identifier === EXPORT)).toHaveLength(0);
    const mod = await load(TASK_FILE);
    expect(mod.EXPORT_TENANT).toBe(EXPORT);
    expect(m.tasks[EXPORT]).toBe(mod.exportTenant);
  });

  it.each([
    ['payload tenant differs from ctx.tenantId (tenant_b id in a tenant_a job)', { tenant_id: TB }, {}],
    ['payload has no tenant_id', {}, {}],
    ['ctx has no tenant (platform scope)', { tenant_id: TA }, { tenantId: undefined }],
    ['payload tenant_id is not a string', { tenant_id: { $ne: null } }, {}],
  ])('exports nothing when %s: no query, no storage write', async (_n, payload, over) => {
    const { exportTenant } = await load(TASK_FILE);
    const { ctx, puts, tx } = fakeCtx(over);
    await expect(exportTenant(payload, ctx)).resolves.toBeUndefined();
    expect(tx.query).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it('runbook docs/manual/billing/tenant-export.md exists and names the task, the restore and the integrity check', () => {
    const p = resolve(REPO, 'docs/manual/billing/tenant-export.md');
    expect(existsSync(p)).toBe(true);
    const t = readFileSync(p, 'utf8');
    for (const needle of [EXPORT, CHECK, 'manifest', 'restore', 'gapless']) expect(t.toLowerCase()).toContain(needle.toLowerCase());
    expect(t).not.toMatch(/IRD[- ]approved|IRD[- ]certified|approved by IRD|commission/i);   // US-BL-16 text scan also covers manuals defensively
  });
});

describe.skipIf(!SU || !RDB)('export tenant_a from the source DB, restore into a fresh DB (US-BL-15.1)', () => {
  let src: any, dst: any, mod: any, billing: any;
  const q = async (pool: any, sql: string, v: unknown[] = []) => (await pool.query(sql, v)).rows;

  async function tx<T>(pool: any, fn: (c: any) => Promise<T>, o: { replica?: boolean; readOnly?: boolean } = {}): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query(o.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ tenant_id: TA, sub: SYS, actor_type: 'system' })]);
      if (o.replica) await c.query('SET LOCAL session_replication_role = replica');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }
  const ins = (table: string, row: object): [string, unknown[]] => {
    const cols = Object.keys(row).join(', ');
    return [`INSERT INTO billing.${table} (${cols}) SELECT ${cols} FROM jsonb_populate_record(NULL::billing.${table}, $1::jsonb)`, [JSON.stringify(row)]];
  };

  /** billing tables that carry tenant_id (g_cs_* have none) */
  const tenantTables = async (pool: any): Promise<string[]> => (await q(pool, `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'billing' AND c.relkind IN ('r','p') AND NOT c.relispartition
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) ORDER BY 1`)).map((r: any) => r.relname);

  /** table -> tenant -> "count|md5(rows)" ; independent of the archive's own checksum definition */
  async function fingerprint(pool: any): Promise<Record<string, Record<string, string>>> {
    const out: Record<string, Record<string, string>> = {};
    for (const t of await tenantTables(pool)) {
      const rows = await q(pool, `SELECT tenant_id::text AS tid, count(*)::int AS n, md5(string_agg(x::text, '|' ORDER BY x::text)) AS s FROM billing."${t}" x GROUP BY tenant_id`);
      out[t] = Object.fromEntries(rows.map((r: any) => [r.tid, `${r.n}|${r.s}`]));
    }
    return out;
  }
  const purge = (pool: any) => tx(pool, async (c) => {
    for (const t of await tenantTables(pool)) await c.query(`DELETE FROM billing."${t}" WHERE tenant_id = ANY($1::uuid[])`, [[TA, TB]]);
  }, { replica: true });

  const inv = (tenant: string, id: string, seq: number, buyer: string, minsAgo: number) => ({
    id, tenant_id: tenant, branch_id: tenant === TA ? BR_A : BR_B, centre_id: tenant === TA ? CEN_A : CEN_B, series: 'INV', fiscal_year_bs: FY, invoice_seq: seq,
    invoice_no: `INV-${FY}-00000${seq}`, invoice_kind: 'tax_invoice', purpose: 'registration', order_id: uid('0190c418', 100 + seq + (tenant === TA ? 0 : 50)),
    patient_id: uid('0190c418', 200 + seq + (tenant === TA ? 0 : 50)), buyer_name: buyer, seller_name: 'Synthetic Lab Seller',
    issued_at: new Date(Date.now() - minsAgo * 60_000).toISOString(), invoice_date_bs: '2098-04-01', gross_paisa: 10000, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: 10000,
    vat_paisa: 1300, other_tax_paisa: 0, net_paisa: 11300, prices_include_tax: false, quote_fingerprint: FPR, cbms_state: 'not_required', created_by: SYS, updated_by: SYS,
  });
  const line = (tenant: string, id: string, invoiceId: string) => ({
    id, tenant_id: tenant, invoice_id: invoiceId, centre_id: tenant === TA ? CEN_A : CEN_B, line_no: 1, line_kind: 'orderable', code: 'T1', name: 'Synthetic Test', unit_price_paisa: 10000,
    gross_paisa: 10000, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: 10000, vat_treatment: 'taxable', vat_rate_bp: 1300, vat_paisa: 1300, other_tax_paisa: 0, net_paisa: 11300, created_by: SYS,
  });
  const counter = (tenant: string, last_no: number) => ({ tenant_id: tenant, series: 'INV', fiscal_year_bs: FY, last_no, created_by: SYS, updated_by: SYS });
  const ledger = (tenant: string, id: string, invoiceId: string, order: string) => ({
    id, tenant_id: tenant, branch_id: tenant === TA ? BR_A : BR_B, order_id: order, invoice_id: invoiceId, entry_kind: 'payment', capture_kind: 'manual', method_code: 'cash', amount_paisa: 11300,
    fiscal_year_bs: FY, business_date: '2098-04-01', created_by: SYS,
  });
  const credit = (tenant: string, id: string, code: string, name: string) => ({ tenant_id: tenant, credit_party_id: id, party_code: code, party_display_name: name, created_by: SYS, updated_by: SYS });

  const A_INV = [1, 2, 3].map((n) => uid('a1a1a1a1', n)), B_INV = [1, 2].map((n) => uid('b1b1b1b1', n));
  async function seed() {
    await tx(src, async (c) => {
      for (const [t, r] of [
        ins('fiscal_counters', counter(TA, 3)), ins('fiscal_counters', counter(TB, 2)),
        ...[1, 2, 3].map((n) => ins('invoices', inv(TA, A_INV[n - 1]!, n, `Synthetic Buyer A${n}`, 40 - n))),
        ...[1, 2].map((n) => ins('invoices', inv(TB, B_INV[n - 1]!, n, 'B-SECRET-BUYER', 40 - n))),
        ins('invoice_lines', line(TA, uid('a2a2a2a2', 1), A_INV[0]!)), ins('invoice_lines', line(TB, uid('b2b2b2b2', 1), B_INV[0]!)),
        ins('ledger_entries', ledger(TA, uid('a5a5a5a5', 1), A_INV[0]!, uid('0190c418', 101))), ins('ledger_entries', ledger(TB, uid('b5b5b5b5', 1), B_INV[0]!, uid('0190c418', 151))),
        ins('credit_accounts', credit(TA, uid('dddddddd', 1), 'A-CREDIT-1', 'Synthetic Party A1')), ins('credit_accounts', credit(TB, uid('eeeeeeee', 1), 'B-SECRET-CREDIT', 'Synthetic Party B1')),
      ] as Array<[string, unknown[]]>) await c.query(t, r);
    }, { replica: true });   // FKs/immutability/numbering triggers are out of scope for SEEDING (T0B-11 precedent); CHECKs still apply
  }
  async function clearSource() {
    await tx(src, async (c) => {
      await c.query(`DELETE FROM billing.invoice_lines WHERE tenant_id = ANY($1::uuid[]) AND invoice_id = ANY($2::uuid[])`, [[TA, TB], [...A_INV, uid('a1a1a1a1', 4), ...B_INV]]);
      for (const t of ['ledger_entries', 'invoices', 'fiscal_counters']) await c.query(`DELETE FROM billing.${t} WHERE tenant_id = ANY($1::uuid[]) AND fiscal_year_bs = $2`, [[TA, TB], FY]);
      await c.query(`DELETE FROM billing.credit_accounts WHERE tenant_id = ANY($1::uuid[]) AND party_code IN ('A-CREDIT-1','B-SECRET-CREDIT')`, [[TA, TB]]);
    }, { replica: true });
  }

  /** runs exportTenant on the source under tenant claims (READ ONLY tx: a write would error) and returns what it stored */
  async function runExport(tenantId = TA) {
    const { ctx, puts } = fakeCtx();
    ctx.tenantId = tenantId;
    await tx(src, async (c) => { ctx.tx = c; await mod.exportTenant({ tenant_id: tenantId }, ctx); }, { readOnly: true });
    return puts;
  }
  const restoreInto = (opened: any) => tx(dst, async (c) => {
    for (const { table } of opened.manifest.tables) {
      const cols = (await c.query(`SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS cols FROM pg_attribute WHERE attrelid = format('billing.%I', $1::text)::regclass
        AND attnum > 0 AND NOT attisdropped AND attgenerated = ''`, [table])).rows[0].cols;
      for (const row of opened.rows[table] ?? [])
        await c.query(`INSERT INTO billing."${table}" (${cols}) SELECT ${cols} FROM jsonb_populate_record(NULL::billing."${table}", $1::jsonb)`, [JSON.stringify(row)]);
    }
  }, { replica: true });   // same as db/tools/export-tenant-billing.ts: replica role skips FK order + immutability/numbering triggers on load
  async function integrity(pool: any) {
    const inc: any[] = [];
    await tx(pool, async (c) => {
      const { ctx } = fakeCtx(); ctx.tx = c; ctx.metrics = { inc: (name: string, labels: any, by = 1) => { inc.push({ name, labels, by }); }, set() {}, observe() {} };
      await billing.manifest.tasks[CHECK]({ tenant_id: TA }, ctx);
    });
    return inc.filter((m) => m.name === METRIC && m.labels.tenant_id === TA);
  }

  let archive: Uint8Array, opened: any, srcFp: Record<string, Record<string, string>>;

  beforeAll(async () => {
    process.env['LIMS_BILLING_EXPORT_KEY'] = KEY;
    const pg: any = await import(['p', 'g'].join(''));
    const Pool = (pg.default ?? pg).Pool;
    src = new Pool({ connectionString: SU, max: 3 }); dst = new Pool({ connectionString: RDB, max: 3 });
    mod = await load(TASK_FILE); billing = await load(WORKER_BILLING);
    await clearSource(); await purge(dst);
    await seed();
    srcFp = await fingerprint(src);
  });
  afterAll(async () => { if (src) await clearSource().catch(() => undefined); if (dst) await purge(dst).catch(() => undefined); await src?.end(); await dst?.end(); });

  it('seed is non-vacuous: both tenants have rows in every seeded table, the restore target has none of tenant_a or tenant_b', async () => {
    for (const t of ['invoices', 'invoice_lines', 'fiscal_counters', 'ledger_entries', 'credit_accounts']) {
      expect(srcFp[t]?.[TA], `source ${t} tenant_a`).toBeDefined(); expect(srcFp[t]?.[TB], `source ${t} tenant_b`).toBeDefined();
    }
    const dstFp = await fingerprint(dst);
    for (const t of Object.keys(dstFp)) { expect(dstFp[t]![TA], `target ${t}`).toBeUndefined(); expect(dstFp[t]![TB], `target ${t}`).toBeUndefined(); }
  });

  it('stores one encrypted archive under billing-exports/<tenant_a>/ ; the source is read-only-untouched; no plaintext business data in the bytes', async () => {
    const before = await fingerprint(src);
    const puts = await runExport();
    expect(puts).toHaveLength(1);
    const [bucket, path, bytes, opts] = puts[0];
    expect(bucket).toBe('billing-exports');
    expect(String(path).split('/')[0]).toBe(TA);
    expect(opts).toMatchObject({ ifAbsent: true });
    archive = bytes;
    const raw = Buffer.from(bytes).toString('latin1');
    for (const needle of ['Synthetic Buyer A1', 'Synthetic Party A1', 'B-SECRET', 'buyer_name', 'invoice_no']) expect(raw).not.toContain(needle);
    expect(await fingerprint(src)).toEqual(before);
  });

  it('a wrong key and any single modified byte are rejected (no silent garbage)', async () => {
    expect(() => mod.openArchive(archive, randomBytes(32).toString('base64'))).toThrow();
    const tampered = Uint8Array.from(archive); tampered[Math.floor(tampered.length / 2)]! ^= 0x01;
    expect(() => mod.openArchive(tampered, KEY)).toThrow();
    const truncated = archive.slice(0, archive.length - 1);
    expect(() => mod.openArchive(truncated, KEY)).toThrow();
  });

  it('manifest covers every billing table with tenant_id in FK order, counts equal the source rows of tenant_a (US-BL-15.1)', async () => {
    opened = mod.openArchive(archive, KEY);
    expect(opened.manifest.tenant_id).toBe(TA);
    const names: string[] = opened.manifest.tables.map((t: any) => t.table);
    expect([...names].sort()).toEqual(await tenantTables(src));
    expect(new Set(names).size).toBe(names.length);
    for (const t of opened.manifest.tables) {
      expect(t.sha256, t.table).toMatch(/^[0-9a-f]{64}$/);
      const n = Number((await q(src, `SELECT count(*) AS n FROM billing."${t.table}" WHERE tenant_id = $1`, [TA]))[0].n);
      expect(t.row_count, `${t.table} manifest count`).toBe(n);
      expect((opened.rows[t.table] ?? []).length, `${t.table} archived rows`).toBe(n);
    }
    // parents before children (FKs between two different exported tables)
    const fks = await q(src, `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'billing'::regnamespace AND c.conrelid <> c.confrelid AND c.confrelid::regclass::text LIKE 'billing.%'`);
    for (const f of fks) {
      const ci = names.indexOf(String(f.child).replace('billing.', '')), pi = names.indexOf(String(f.parent).replace('billing.', ''));
      if (ci >= 0 && pi >= 0) expect(pi, `${f.parent} must precede ${f.child}`).toBeLessThan(ci);
    }
  });

  it('zero foreign rows in the archive: every row is tenant_a, tenant_b markers appear nowhere', () => {
    const all = Object.values(opened.rows).flat() as any[];
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) expect(r.tenant_id).toBe(TA);
    const text = JSON.stringify(opened.rows) + JSON.stringify(opened.manifest);
    for (const needle of [TB, 'B-SECRET', ...B_INV, BR_B, CEN_B]) expect(text).not.toContain(needle);
  });

  it('manifest checksums are stable for unchanged data and change when a row changes', async () => {
    const again = mod.openArchive((await runExport())[0][2], KEY);
    expect(again.manifest.tables).toEqual(opened.manifest.tables);
    await tx(src, (c) => c.query(`UPDATE billing.credit_accounts SET party_display_name = 'Synthetic Party A1 (changed)' WHERE tenant_id = $1 AND credit_party_id = $2`, [TA, uid('dddddddd', 1)]), { replica: true });
    try {
      const changed = mod.openArchive((await runExport())[0][2], KEY);
      const pick = (m: any, t: string) => m.manifest.tables.find((x: any) => x.table === t);
      expect(pick(changed, 'credit_accounts').sha256).not.toBe(pick(opened, 'credit_accounts').sha256);
      expect(pick(changed, 'invoices').sha256).toBe(pick(opened, 'invoices').sha256);
    } finally {
      await tx(src, (c) => c.query(`UPDATE billing.credit_accounts SET party_display_name = 'Synthetic Party A1' WHERE tenant_id = $1 AND credit_party_id = $2`, [TA, uid('dddddddd', 1)]), { replica: true });
    }
  });

  it('restore into the fresh DB: per-table row count + md5 equal tenant_a in the source, zero rows of any other tenant (checksums match, zero foreign rows)', async () => {
    await restoreInto(opened);
    const dstFp = await fingerprint(dst), now = await fingerprint(src);
    for (const t of Object.keys(now)) {
      expect(dstFp[t]?.[TA], `${t} tenant_a count|md5`).toBe(now[t]![TA]);
      expect(Object.keys(dstFp[t] ?? {}).filter((k) => k !== TA), `${t} foreign tenants in restored DB`).toEqual([]);
    }
    expect(dstFp['invoices']?.[TA]?.startsWith('3|')).toBe(true);
    expect((await q(dst, `SELECT 1 FROM billing.invoices WHERE buyer_name = 'B-SECRET-BUYER'`))).toHaveLength(0);
  });

  it('restored DB passes billing.integrity_check for tenant_a, then issuing the next invoice continues the series gaplessly (4, no gap, chronology accepted)', async () => {
    expect(await integrity(dst)).toEqual([]);
    expect(Number((await q(dst, `SELECT last_no FROM billing.fiscal_counters WHERE tenant_id = $1 AND series = 'INV' AND fiscal_year_bs = $2`, [TA, FY]))[0].last_no)).toBe(3);
    const next = await tx(dst, async (c) => {
      const no = (await c.query(`UPDATE billing.fiscal_counters SET last_no = last_no + 1 WHERE tenant_id = $1 AND series = 'INV' AND fiscal_year_bs = $2 RETURNING last_no`, [TA, FY])).rows[0].last_no;
      const row = { ...inv(TA, uid('a1a1a1a1', 4), no, 'Synthetic Buyer A4', 0), issued_at: new Date().toISOString() };
      const [sql, v] = ins('invoices', row); await c.query(sql, v);
      return no;
    });
    expect(next).toBe(4);
    expect((await q(dst, `SELECT invoice_seq FROM billing.invoices WHERE tenant_id = $1 AND series = 'INV' AND fiscal_year_bs = $2 ORDER BY invoice_seq`, [TA, FY])).map((r: any) => r.invoice_seq)).toEqual([1, 2, 3, 4]);
    expect(await integrity(dst)).toEqual([]);
    // the source's tenant_b series is untouched by any of this
    expect(Number((await q(src, `SELECT last_no FROM billing.fiscal_counters WHERE tenant_id = $1 AND series = 'INV' AND fiscal_year_bs = $2`, [TB, FY]))[0].last_no)).toBe(2);
  });

  it('a tenant_a job cannot export tenant_b even with the live source: nothing stored, no tenant_b rows read', async () => {
    const { ctx, puts } = fakeCtx();   // ctx.tenantId = TA, payload names TB
    await tx(src, async (c) => { ctx.tx = c; await mod.exportTenant({ tenant_id: TB }, ctx); }, { readOnly: true });
    expect(puts).toHaveLength(0);
  });
});
