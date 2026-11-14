// C13 T17 — worker side of the projections: partners.sync_price_list, partners.sync_statements, consumer catalog.changed.v1 (CR-C13-006).
// 06-IMPLEMENTATION-PLAN row T17 done_when: "precedence partner > standard; no other party's prices projected (test with 3 credit parties); delete-insert atomic;
//   statement upsert + is_stale; outstanding = latest closing balance. catalog.changed.v1 consumer behind CR-C13-006".   ACs: US-11.1-11.4, US-12.1, (11.3 via the consumer).
// Spec: 02-TRD §7.2 (catalog.changed.v1 row), §8.1 (sync_price_list, sync_statements), §8.2 (cron fan-out, per_tenant), §6 (CatalogPort getTest/getPanel);
//       03-APP-FLOW §5.7 + lines 193/195 (delete-insert in one tx; upsert + is_stale); 05-SCHEMA price_list_items / price_list_syncs / statement_months;
//       03-INTERFACE-CATALOG v_pub_price_list_items / v_pub_test_directory / v_pub_credit_party_statement (08 A13 D-19); 07-SECURITY (partner financial data, tenant isolation).
// Interface (SEAM = not fixed by the spec; the writer follows it or raises a dispute). Handlers are reached ONLY through `manifest` of ../index.ts:
//   manifest.tasks['partners.sync_price_list'](payload, ctx) / ['partners.sync_statements'] and manifest.subscriptions['catalog.changed.v1'](event, ctx).
//   SEAM payload: {tenant_id, partner_id} = one partner; {tenant_id} only = the cron tick (TRD §8.2): sync_price_list then ENQUEUES one per-partner job per ACTIVE partner (writes nothing itself);
//        sync_statements then syncs EVERY partner of the tenant, suspended included (TRD §8.1).
//   SEAM ctx: JobContext (core/consumer.ts) — one tx per job (ctx.tx / ctx.db.tx), system actor, ctx.now(), ports via ctx.ports.CatalogPort (as analytics tasks use ctx.ports.*).
//   SEAM jobs: `SELECT app.enqueue_job($1, $2::jsonb, $3[, $4])`; payload {tenant_id, partner_id}; job_key pricelist:<partner_id>; run_at (consumer only) = 4th param, ctx.now() + 60 s (Date or ISO).
//   SEAM statements: window = period_month >= first day of the month 24 months before ctx.now() (2024-11-01 for 2026-11-13; tests use clear cases only: 2024-01 out, 2025-01 in).
//        A month in partners.statement_months that the view no longer returns for THIS partner is kept and set is_stale = true; a returned row is upserted with is_stale = false.
//   SEAM clock: synced_at / updated_at values are ctx.now() passed as bound parameters (not SQL now()), so one run carries one timestamp.
//   SEAM price_list_syncs: price_list_version = highest version among the partner-source rows (NULL when there are none), row_count = projected rows, last_error_code NULL on success.
//   The fake SQL subset is documented in the api __tests__/projection.world.ts header (bound $n parameters only; bigint columns are strings as with node-pg).
import { describe, expect, it } from 'vitest';
import { CP, NOW, NOW_ISO, O, P, PL, SYSTEM, T_A, T_B, id, makeWorld, runJob, seed, type Row, type World } from '../../../../../api/src/modules/partners/__tests__/projection.world.js';
import { manifest } from '../index.js';

const PRICE = 'partners.sync_price_list', STATEMENTS = 'partners.sync_statements';
const priceTask = manifest.tasks![PRICE]!, statementTask = manifest.tasks![STATEMENTS]!, onCatalogChanged = manifest.subscriptions!['catalog.changed.v1']!;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const items = (w: World, partner: string) => w.t['partners.price_list_items']!.filter((r) => r.partner_id === partner)
  .map((r) => ({ orderable_id: r.orderable_id, kind: r.kind, code: r.code, name: r.name, department_name: r.department_name ?? null, price: String(r.unit_price_paisa), source: r.source,
    price_list_id: r.price_list_id, price_list_version: r.price_list_version, effective_from: iso(r.effective_from), effective_to: iso(r.effective_to) }))
  .sort((a, b) => a.code.localeCompare(b.code));
const stmts = (w: World, partner: string) => w.t['partners.statement_months']!.filter((r) => r.partner_id === partner)
  .sort((a, b) => String(a.period_month).localeCompare(String(b.period_month)) || a.fiscal_year_bs.localeCompare(b.fiscal_year_bs));
const month = (r: Row) => String(r.period_month instanceof Date ? r.period_month.toISOString() : r.period_month).slice(0, 10);
const syncPrice = (w: World, partner: string, over: Row = {}) => runJob(w, (ctx) => priceTask({ tenant_id: T_A, partner_id: partner }, ctx), T_A, over);
const syncStatements = (w: World, partner: string, over: Row = {}) => runJob(w, (ctx) => statementTask({ tenant_id: T_A, partner_id: partner }, ctx), T_A, over);
const fresh = () => { const w = makeWorld(); seed(w); return w; };

// expected projection for X (include_default_price_list defaults to true when partners.settings has no row, TRD §10.2)
const X_ITEMS = [
  { orderable_id: O.p1, kind: 'panel', code: 'SYN-P1', name: 'Synthetic Lipid Package', department_name: null, price: '90000', source: 'partner', price_list_id: PL.cp1, price_list_version: 3, effective_from: '2026-01-01T00:00:00.000Z', effective_to: null },
  { orderable_id: O.p2, kind: 'panel', code: 'SYN-P2', name: 'Synthetic Renal Package', department_name: null, price: '110000', source: 'standard', price_list_id: PL.dflt, price_list_version: 7, effective_from: '2026-01-01T00:00:00.000Z', effective_to: null },
  { orderable_id: O.t1, kind: 'test', code: 'SYN-T1', name: 'Synthetic Hemogram', department_name: 'Synthetic Haematology', price: '150000', source: 'partner', price_list_id: PL.cp1, price_list_version: 3, effective_from: '2026-01-01T00:00:00.000Z', effective_to: null },
  { orderable_id: O.t2, kind: 'test', code: 'SYN-T2', name: 'Synthetic Glucose', department_name: 'Synthetic Biochemistry', price: '60000', source: 'partner', price_list_id: PL.cp1, price_list_version: 3, effective_from: '2026-01-01T00:00:00.000Z', effective_to: '2027-01-01T00:00:00.000Z' },
  { orderable_id: O.t4, kind: 'test', code: 'SYN-T4', name: 'Synthetic Urea', department_name: 'Synthetic Biochemistry', price: '50000', source: 'standard', price_list_id: PL.dflt, price_list_version: 7, effective_from: '2026-01-01T00:00:00.000Z', effective_to: null },
];
const oldItem = (partner: string, orderable: string, code: string): Row => ({ tenant_id: T_A, partner_id: partner, orderable_id: orderable, kind: 'test', code, name: 'Stale Synthetic Row', department_name: null, unit_price_paisa: '1', source: 'partner',
  price_list_id: id(70), price_list_version: 1, effective_from: new Date('2025-01-01T00:00:00Z'), effective_to: null, synced_at: new Date('2026-11-01T00:00:00Z'), created_at: NOW, created_by: SYSTEM });

describe('T17 partners.sync_price_list — US-11.1 / 11.2 precedence and classification', () => {
  it('projects partner-list rows (source partner) and default rows for orderables without a partner price (source standard); partner wins on overlap', async () => {
    const w = fresh();
    const r = await syncPrice(w, P.x);
    expect(r.error).toBeUndefined();
    expect(items(w, P.x)).toEqual(X_ITEMS);
    const t1 = items(w, P.x).filter((i) => i.orderable_id === O.t1);
    expect(t1).toHaveLength(1);
    expect(t1[0]!.price).toBe('150000'); // 150000 (partner) beats 200000 (tenant default)
    for (const row of w.t['partners.price_list_items']!.filter((x) => x.partner_id === P.x)) {
      expect(row.tenant_id).toBe(T_A);
      expect(iso(row.synced_at)).toBe(NOW_ISO);
      expect(row.created_by).toBe(SYSTEM); // system actor, never a request value
    }
  });

  it('only rows effective now: a future list (T3), an ended list (T4 partner price) and the superseded v2 (T1) are not projected; T4 falls to the standard rate', async () => {
    const w = fresh();
    await syncPrice(w, P.x);
    const rows = items(w, P.x);
    expect(rows.find((i) => i.orderable_id === O.t3)).toBeUndefined();                 // starts 2027
    expect(rows.find((i) => i.orderable_id === O.t4)).toMatchObject({ source: 'standard', price: '50000' }); // partner price 45000 ended 2026-01-01
    expect(rows.find((i) => i.orderable_id === O.t1)!.price_list_version).toBe(3);      // v2 (120000) ended
  });

  it('two rows effective now for the same orderable (a data glitch): the higher price_list_version wins and the sync does not die on the primary key', async () => {
    const w = fresh();
    w.t['catalog.v_pub_price_list_items']!.push({ tenant_id: T_A, price_list_id: PL.cp1old, price_list_version: 2, owner_kind: 'credit_party', owner_id: CP.one, orderable_id: O.t1,
      unit_price_paisa: '120000', effective_from: new Date('2025-01-01T00:00:00Z'), effective_to: null, falls_through: true });
    const r = await syncPrice(w, P.x);
    expect(r.error).toBeUndefined();
    expect(items(w, P.x).filter((i) => i.orderable_id === O.t1)).toEqual([expect.objectContaining({ price: '150000', price_list_version: 3 })]);
  });

  it('include_default_price_list = false: partner rows only (settings flag read for this tenant)', async () => {
    const w = fresh();
    w.t['partners.settings']!.push({ tenant_id: T_A, include_default_price_list: false });
    await syncPrice(w, P.x);
    expect(items(w, P.x).map((i) => i.orderable_id).sort()).toEqual([O.p1, O.t1, O.t2].sort());
    expect(items(w, P.x).every((i) => i.source === 'partner')).toBe(true);
  });

  it('falls_through = false on the partner\'s credit-party list: no standard rows (08 A13 D-19, C3 priceMatch); the partner rows stay', async () => {
    const w = fresh();
    for (const r of w.t['catalog.v_pub_price_list_items']!.filter((x) => x.tenant_id === T_A && x.owner_kind === 'credit_party' && x.owner_id === CP.two)) r.falls_through = false;
    const r = await syncPrice(w, P.y);
    expect(r.error).toBeUndefined();
    const rows = items(w, P.y);
    expect(rows.filter((i) => i.source === 'standard')).toEqual([]);
    expect(rows.map((i) => [i.orderable_id, i.price, i.source])).toEqual([[O.t1, '111000', 'partner'], [O.t3, '222000', 'partner']]); // sorted by code SYN-T1, SYN-T3
  });

  it('classification: tests come from v_pub_test_directory of THIS tenant (not tenant B\'s row for the same id), department from CatalogPort.getTest, panels from getPanel with NULL department; an id C3 cannot name is skipped', async () => {
    const w = fresh();
    const r = await syncPrice(w, P.x);
    expect(r.error).toBeUndefined();
    const rows = items(w, P.x);
    expect(rows.find((i) => i.orderable_id === O.t1)).toMatchObject({ kind: 'test', code: 'SYN-T1', name: 'Synthetic Hemogram', department_name: 'Synthetic Haematology' });
    expect(rows.find((i) => i.orderable_id === O.p1)).toMatchObject({ kind: 'panel', code: 'SYN-P1', department_name: null });
    expect(rows.find((i) => i.orderable_id === O.unknown)).toBeUndefined(); // default row for an id that is neither test nor panel
    expect(JSON.stringify(rows)).not.toMatch(/Foreign|FOREIGN/);
    const calls = w.portCalls;
    expect(calls.filter((c) => c.startsWith('getPanel:') && [O.t1, O.t2, O.t4].some((t) => c.endsWith(t)))).toEqual([]); // a directory test is never confirmed as a panel
    expect(new Set(calls).size).toBe(calls.length); // memoised: no id asked twice in one run
  });
});

describe('T17 partners.sync_price_list — US-11.4 no other party\'s prices are projected (3 credit parties, 2 tenants)', () => {
  it('X, Y and Z each get only their own credit party\'s list + the tenant default; nothing from the other two parties, referrer/centre lists or tenant B', async () => {
    const w = fresh();
    w.t['partners.partners']!.find((p) => p.id === P.z)!.status = 'active'; // Z is a normal partner for this test
    for (const p of [P.x, P.y, P.z]) expect((await syncPrice(w, p)).error).toBeUndefined();
    const own: Record<string, string[]> = { [P.x]: [PL.cp1, PL.dflt], [P.y]: [PL.cp2, PL.dflt], [P.z]: [PL.cp3, PL.dflt] };
    for (const p of [P.x, P.y, P.z]) {
      const rows = items(w, p);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(own[p]).toContain(row.price_list_id);
    }
    expect(items(w, P.y).find((i) => i.orderable_id === O.t1)).toMatchObject({ price: '111000', source: 'partner' });
    expect(items(w, P.z).find((i) => i.orderable_id === O.t2)).toMatchObject({ price: '333000', source: 'partner' });
    const everything = JSON.stringify(items(w, P.x));
    for (const leak of ['111000', '222000', '333000', '444000', '777000', '666000', '99999', '88888', PL.cp2, PL.cp3, PL.b, id(46), id(47), id(48)]) expect(everything).not.toContain(leak);
    expect(items(w, P.x).find((i) => i.orderable_id === O.t3)).toBeUndefined(); // the referrer list with owner_id = CP1 is not CP1's list
    expect(w.t['partners.price_list_items']!.filter((r) => r.partner_id === P.b)).toEqual([]); // tenant B untouched
    expect(w.t['partners.price_list_items']!.every((r) => r.tenant_id === T_A)).toBe(true);
  });

  it('syncing X leaves the rows of Y and of tenant B\'s partner exactly as they were; the DELETE is scoped by tenant_id and partner_id', async () => {
    const w = fresh();
    w.t['partners.price_list_items']!.push(oldItem(P.y, O.t3, 'SYN-T3'), { ...oldItem(P.b, O.t1, 'B-T1'), tenant_id: T_B });
    const before = structuredClone(w.t['partners.price_list_items']!);
    await syncPrice(w, P.x);
    const after = w.t['partners.price_list_items']!;
    expect(after.filter((r) => r.partner_id !== P.x)).toEqual(before);
    const del = w.sqlOf(/^\s*DELETE\s+FROM\s+partners\.price_list_items/i);
    expect(del.length).toBeGreaterThan(0);
    for (const q of del) { expect(q.values).toContain(T_A); expect(q.values).toContain(P.x); expect(q.values).not.toContain(P.y); }
  });
});

describe('T17 partners.sync_price_list — replace-in-one-transaction, sync state (03-APP-FLOW line 193)', () => {
  it('replaces the partner\'s old rows (stale row gone) and upserts exactly one price_list_syncs row; a second run changes nothing', async () => {
    const w = fresh();
    w.t['partners.price_list_items']!.push(oldItem(P.x, O.t3, 'SYN-T3'));
    w.t['partners.price_list_syncs']!.push({ tenant_id: T_A, partner_id: P.x, synced_at: new Date('2026-11-01T00:00:00Z'), price_list_version: 1, row_count: 1, last_error_code: 'common.internal', created_at: NOW, created_by: SYSTEM, updated_at: NOW, updated_by: SYSTEM });
    await syncPrice(w, P.x);
    expect(items(w, P.x)).toEqual(X_ITEMS);
    const syncs = w.t['partners.price_list_syncs']!.filter((s) => s.partner_id === P.x);
    expect(syncs).toHaveLength(1);
    expect(syncs[0]).toMatchObject({ tenant_id: T_A, price_list_version: 3, row_count: 5, last_error_code: null, updated_by: SYSTEM });
    expect(iso(syncs[0]!.synced_at)).toBe(NOW_ISO);
    await syncPrice(w, P.x);
    expect(items(w, P.x)).toEqual(X_ITEMS);
    expect(w.t['partners.price_list_syncs']!.filter((s) => s.partner_id === P.x)).toHaveLength(1);
  });

  it('a list that became empty empties the partner\'s projection (no stale price survives) and records row_count 0 / version NULL', async () => {
    const w = fresh();
    w.t['partners.settings']!.push({ tenant_id: T_A, include_default_price_list: false });
    w.t['partners.price_list_items']!.push(oldItem(P.y, O.t1, 'SYN-T1'));
    w.t['catalog.v_pub_price_list_items'] = w.t['catalog.v_pub_price_list_items']!.filter((r) => r.owner_id !== CP.two);
    await syncPrice(w, P.y);
    expect(items(w, P.y)).toEqual([]);
    expect(w.t['partners.price_list_syncs']!.find((s) => s.partner_id === P.y)).toMatchObject({ row_count: 0, price_list_version: null, last_error_code: null });
  });

  it('delete-insert is atomic: if the INSERT fails after the DELETE, the old rows and the old sync state are all still there and the job fails (retry)', async () => {
    const w = fresh();
    w.t['partners.price_list_items']!.push(oldItem(P.x, O.t3, 'SYN-T3'));
    const old = structuredClone(w.t['partners.price_list_items']!);
    w.failNext(/^\s*INSERT\s+INTO\s+partners\.price_list_items/i);
    const r = await syncPrice(w, P.x);
    expect(r.ok).toBe(false);
    expect(w.t['partners.price_list_items']).toEqual(old);
    expect(w.t['partners.price_list_syncs']).toEqual([]);
    const del = w.sqlOf(/^\s*DELETE\s+FROM\s+partners\.price_list_items/i).length;
    const ins = w.sqlOf(/^\s*INSERT\s+INTO\s+partners\.price_list_items/i).length;
    expect(del).toBeGreaterThan(0); expect(ins).toBeGreaterThan(0); // the failure really happened after the delete
  });

  it('a CatalogPort outage (not "not found") fails the job and leaves the previous projection untouched, never a half list', async () => {
    const w = fresh();
    w.t['partners.price_list_items']!.push(oldItem(P.x, O.t3, 'SYN-T3'));
    const old = structuredClone(w.t['partners.price_list_items']!);
    const r = await syncPrice(w, P.x, { catalog: { getTest: () => new Error('catalog unavailable') } });
    expect(r.ok).toBe(false);
    expect(w.t['partners.price_list_items']).toEqual(old);
  });
});

describe('T17 partners.sync_price_list — scope, fan-out and input guards', () => {
  it('cron tick ({tenant_id} only): enqueues one pricelist:<partner_id> job per ACTIVE partner of that tenant, writes no projection itself', async () => {
    const w = fresh();
    const r = await runJob(w, (ctx) => priceTask({ tenant_id: T_A }, ctx));
    expect(r.error).toBeUndefined();
    expect(w.jobs.map((j) => j.jobKey).sort()).toEqual([`pricelist:${P.x}`, `pricelist:${P.y}`].sort()); // Z suspended, B other tenant
    for (const j of w.jobs) expect(j).toMatchObject({ identifier: PRICE, payload: { tenant_id: T_A, partner_id: expect.stringMatching(UUID_LIKE) } });
    expect(w.t['partners.price_list_items']).toEqual([]);
  });

  it('cron tick for a tenant without active partners is a no-op', async () => {
    const w = fresh();
    for (const p of w.t['partners.partners']!) p.status = 'suspended';
    const r = await runJob(w, (ctx) => priceTask({ tenant_id: T_A }, ctx));
    expect(r.error).toBeUndefined();
    expect(w.jobs).toEqual([]);
  });

  it('a partner of another tenant, a payload tenant different from the job tenant, and a non-uuid partner id write nothing', async () => {
    for (const payload of [{ tenant_id: T_A, partner_id: P.b }, { tenant_id: T_B, partner_id: P.x }, { tenant_id: T_A, partner_id: "x'; DROP TABLE partners.price_list_items; --" }]) {
      const w = fresh();
      await runJob(w, (ctx) => priceTask(payload as any, ctx), T_A); // may resolve (no-op) or reject; must not write
      expect(w.writes()).toEqual([]);
      expect(w.t['partners.price_list_items']).toEqual([]);
      expect(w.t['partners.price_list_syncs']).toEqual([]);
    }
  });

  it('every statement binds values as parameters: no id, price or name from the data appears inside SQL text', async () => {
    const w = fresh();
    await syncPrice(w, P.x);
    expect(w.log.length).toBeGreaterThan(0); // the handler really queried
    for (const q of w.log) for (const needle of [P.x, T_A, CP.one, 'Synthetic', '150000']) expect(q.text).not.toContain(needle);
  });
});

// ------------------------------------------------------------------------------------------------ statements
describe('T17 partners.sync_statements — US-12.1 upsert from billing.v_pub_credit_party_statement', () => {
  it('projects one row per (A.D. month, B.S. fiscal year) of X\'s credit party for the last 24 months, amounts as stored, synced_at = run time, is_stale false', async () => {
    const w = fresh();
    const r = await syncStatements(w, P.x);
    expect(r.error).toBeUndefined();
    const rows = stmts(w, P.x);
    expect(rows.map((x) => `${month(x)}|${x.fiscal_year_bs}`)).toEqual(['2025-01-01|2081/82', '2026-07-01|2082/83', '2026-07-01|2083/84', '2026-08-01|2083/84', '2026-09-01|2083/84', '2026-10-01|2083/84']);
    expect(rows.find((x) => month(x) === '2024-01-01')).toBeUndefined(); // older than 24 months
    const oct = rows.find((x) => month(x) === '2026-10-01')!;
    expect([oct.invoiced_paisa, oct.paid_paisa, oct.credited_paisa, oct.closing_balance_paisa].map(String)).toEqual(['900000', '200000', '0', '1325000']);
    const sep = rows.find((x) => month(x) === '2026-09-01')!;
    expect([sep.invoiced_paisa, sep.paid_paisa, sep.credited_paisa, sep.closing_balance_paisa].map(String)).toEqual(['125000', '25000', '5000', '625000']);
    for (const x of rows) {
      expect(x).toMatchObject({ tenant_id: T_A, partner_id: P.x, credit_party_id: CP.one, is_stale: false, created_by: SYSTEM, updated_by: SYSTEM });
      expect(iso(x.synced_at)).toBe(NOW_ISO);
    }
  });

  it('never projects another credit party\'s or tenant B\'s rows (same credit party id in tenant B, CP2, CP3)', async () => {
    const w = fresh();
    await syncStatements(w, P.x);
    const all = JSON.stringify(stmts(w, P.x));
    for (const leak of ['424242', '333333', '5550000', '123456']) expect(all).not.toContain(leak);
    expect(w.t['partners.statement_months']!.every((x) => x.tenant_id === T_A && x.partner_id === P.x)).toBe(true);
  });

  it('upsert: a second run with a changed closing balance updates in place (no duplicate key, no error) and advances synced_at', async () => {
    const w = fresh();
    await syncStatements(w, P.x);
    w.t['billing.v_pub_credit_party_statement']!.find((r) => r.tenant_id === T_A && r.credit_party_id === CP.one && r.period_month === '2026-10-01')!.closing_balance_paisa = '1500000';
    const later = '2026-11-13T01:00:00.000Z';
    const r = await syncStatements(w, P.x, { ctx: { now: () => later } });
    expect(r.error).toBeUndefined();
    expect(stmts(w, P.x)).toHaveLength(6);
    const oct = stmts(w, P.x).find((x) => month(x) === '2026-10-01')!;
    expect(String(oct.closing_balance_paisa)).toBe('1500000');
    expect(iso(oct.synced_at)).toBe(later);
  });

  it('is_stale: a stored month the view no longer returns for THIS partner is kept (amounts unchanged) and flagged; returning rows are not; Y\'s rows are not touched by X\'s run; the month coming back clears the flag', async () => {
    const w = fresh();
    const mk = (partner: string, cp: string, m: string): Row => ({ tenant_id: T_A, partner_id: partner, credit_party_id: cp, period_month: m, fiscal_year_bs: '2082/83', invoiced_paisa: '700', paid_paisa: '0', credited_paisa: '0',
      closing_balance_paisa: '700', synced_at: new Date('2026-11-01T00:00:00Z'), is_stale: false, created_at: NOW, created_by: SYSTEM, updated_at: NOW, updated_by: SYSTEM });
    w.t['partners.statement_months']!.push(mk(P.x, CP.one, '2026-03-01'), mk(P.y, CP.two, '2026-03-01'));
    await syncStatements(w, P.x);
    const gone = stmts(w, P.x).find((x) => month(x) === '2026-03-01')!;
    expect(gone).toMatchObject({ is_stale: true });
    expect([gone.invoiced_paisa, gone.closing_balance_paisa].map(String)).toEqual(['700', '700']);
    expect(iso(gone.synced_at)).toBe('2026-11-01T00:00:00.000Z');
    expect(stmts(w, P.x).filter((x) => month(x) !== '2026-03-01').every((x) => x.is_stale === false)).toBe(true);
    expect(stmts(w, P.y).find((x) => month(x) === '2026-03-01')).toMatchObject({ is_stale: false }); // Y not synced in this run
    w.t['billing.v_pub_credit_party_statement']!.push({ tenant_id: T_A, credit_party_id: CP.one, period_month: '2026-03-01', fiscal_year_bs: '2082/83', invoiced_paisa: '800', paid_paisa: '0', credited_paisa: '0', closing_balance_paisa: '800' });
    await syncStatements(w, P.x);
    expect(stmts(w, P.x).find((x) => month(x) === '2026-03-01')).toMatchObject({ is_stale: false, closing_balance_paisa: '800' });
  });

  it('bigint amounts stay exact and a negative closing balance (credit position) is stored as is', async () => {
    const w = fresh();
    const v = w.t['billing.v_pub_credit_party_statement']!;
    v.find((r) => r.tenant_id === T_A && r.credit_party_id === CP.one && r.period_month === '2026-10-01')!.closing_balance_paisa = '9007199254740991';
    v.find((r) => r.tenant_id === T_A && r.credit_party_id === CP.one && r.period_month === '2026-09-01')!.closing_balance_paisa = '-250000';
    await syncStatements(w, P.x);
    expect(stmts(w, P.x).map((x) => String(x.closing_balance_paisa))).toEqual(expect.arrayContaining(['9007199254740991', '-250000']));
  });

  it('a credit party without billing rows: no rows, no error', async () => {
    const w = fresh();
    w.t['billing.v_pub_credit_party_statement'] = [];
    const r = await syncStatements(w, P.x);
    expect(r.error).toBeUndefined();
    expect(stmts(w, P.x)).toEqual([]);
  });

  it('a database failure during the upsert fails the job (retry) instead of being swallowed', async () => {
    const w = fresh();
    w.failNext(/^\s*INSERT\s+INTO\s+partners\.statement_months/i);
    expect((await syncStatements(w, P.x)).ok).toBe(false);
  });
});

describe('T17 partners.sync_statements — scope (TRD §8.1: every partner, active or suspended)', () => {
  it('cron tick ({tenant_id}): syncs X, Y and the suspended Z, each with its own credit party only; tenant B\'s partner is not touched', async () => {
    const w = fresh();
    const r = await runJob(w, (ctx) => statementTask({ tenant_id: T_A }, ctx));
    expect(r.error).toBeUndefined();
    expect(stmts(w, P.x)).toHaveLength(6);
    expect(stmts(w, P.y).map((x) => String(x.closing_balance_paisa))).toEqual(['424242']);
    expect(stmts(w, P.z).map((x) => String(x.closing_balance_paisa))).toEqual(['333333']); // suspended partners are still synced
    expect(stmts(w, P.b)).toEqual([]);
    expect(w.t['partners.statement_months']!.every((x) => x.tenant_id === T_A)).toBe(true);
  });

  it('a payload with partner_id syncs only that partner', async () => {
    const w = fresh();
    await syncStatements(w, P.y);
    expect(stmts(w, P.y)).toHaveLength(1);
    expect(stmts(w, P.x)).toEqual([]);
    expect(stmts(w, P.z)).toEqual([]);
  });

  it('a partner of another tenant, a payload tenant different from the job tenant, and a non-uuid partner id write nothing', async () => {
    for (const payload of [{ tenant_id: T_A, partner_id: P.b }, { tenant_id: T_B, partner_id: P.x }, { tenant_id: T_A, partner_id: "x' OR '1'='1" }]) {
      const w = fresh();
      await runJob(w, (ctx) => statementTask(payload as any, ctx), T_A);
      expect(w.writes()).toEqual([]);
      expect(w.t['partners.statement_months']).toEqual([]);
    }
  });

  it('statements are read with bound parameters only', async () => {
    const w = fresh();
    await syncStatements(w, P.x);
    expect(w.log.length).toBeGreaterThan(0); // the handler really queried
    for (const q of w.log) for (const needle of [P.x, T_A, CP.one, '2026-10', '1325000']) expect(q.text).not.toContain(needle);
  });
});

// ------------------------------------------------------------------------------------------------ consumer
const event = (entity: string, over: Row = {}) => ({
  event_id: id(80), event_type: 'catalog.changed.v1', tenant_id: T_A, producer: 'catalog', occurred_at: NOW_ISO,
  payload: { catalog_revision: 5, entity_type: entity, entity_id: id(81), change_kind: 'updated', effective_from: NOW_ISO, ...over },
});
const consume = (w: World, ev: Row, tenant: string = T_A) => runJob(w, (ctx) => onCatalogChanged(ev, ctx), tenant);
const runAtMs = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

describe('T17 consumer catalog.changed.v1 (CR-C13-006, TRD §7.2) — US-11.3', () => {
  for (const entity of ['price_list', 'credit_party', 'test', 'panel', 'global_reference']) {
    it(`entity_type ${entity}: enqueues partners.sync_price_list for every ACTIVE partner of the tenant, job_key pricelist:<partner_id>, run_at = now + 60 s`, async () => {
      const w = fresh();
      const r = await consume(w, event(entity));
      expect(r.error).toBeUndefined();
      expect(w.jobs.map((j) => j.jobKey).sort()).toEqual([`pricelist:${P.x}`, `pricelist:${P.y}`].sort()); // Z suspended, B other tenant
      for (const j of w.jobs) {
        expect(j.identifier).toBe(PRICE);
        expect(j.payload).toEqual({ tenant_id: T_A, partner_id: expect.stringMatching(UUID_LIKE) });
        expect(runAtMs(j.runAt) - NOW.getTime()).toBe(60_000);
      }
    });
  }

  it('an entity_type unknown to C13 (x-extensible) invalidates everything: same enqueue', async () => {
    const w = fresh();
    await consume(w, event('sample_kit'));
    expect(w.jobs.map((j) => j.jobKey).sort()).toEqual([`pricelist:${P.x}`, `pricelist:${P.y}`].sort());
  });

  for (const entity of ['department', 'specimen_type', 'doctor', 'tax_rule', 'tat_target']) {
    it(`other known entity_type ${entity}: nothing enqueued, nothing written, no error`, async () => {
      const w = fresh();
      const r = await consume(w, event(entity));
      expect(r.error).toBeUndefined();
      expect(w.jobs).toEqual([]);
      expect(w.writes()).toEqual([]);
    });
  }

  it('debounce: a burst of events leaves one pending job per partner (same job_key replaces)', async () => {
    const w = fresh();
    await consume(w, event('price_list'));
    await consume(w, { ...event('test'), event_id: id(82) });
    await consume(w, event('price_list')); // redelivery of the first
    expect(w.jobs).toHaveLength(2);
  });

  it('ignores unknown extra payload fields (consumer tolerance, 02-CV §7.2)', async () => {
    const w = fresh();
    const r = await consume(w, event('price_list', { brand_new_field: { nested: true } }));
    expect(r.error).toBeUndefined();
    expect(w.jobs).toHaveLength(2);
  });

  it('tenant scoping: an event of tenant B reaches only tenant B\'s active partners; an event whose tenant differs from the job tenant enqueues nothing for the job tenant', async () => {
    const w = fresh();
    await consume(w, { ...event('price_list'), tenant_id: T_B }, T_B);
    expect(w.jobs.map((j) => j.jobKey)).toEqual([`pricelist:${P.b}`]);
    expect(w.jobs[0]!.payload.tenant_id).toBe(T_B);
    const w2 = fresh();
    await consume(w2, { ...event('price_list'), tenant_id: T_B }, T_A); // may resolve or reject
    expect(w2.jobs.filter((j) => j.payload.tenant_id === T_A)).toEqual([]);
  });

  it('a tenant without active partners: no-op', async () => {
    const w = fresh();
    for (const p of w.t['partners.partners']!) p.status = 'suspended';
    const r = await consume(w, event('price_list'));
    expect(r.error).toBeUndefined();
    expect(w.jobs).toEqual([]);
  });

  it('the partner lookup and the enqueue use bound parameters only', async () => {
    const w = fresh();
    await consume(w, event('price_list'));
    expect(w.log.length).toBeGreaterThan(0); // the handler really queried
    for (const q of w.log) for (const needle of [P.x, T_A, 'updated']) expect(q.text).not.toContain(needle);
  });
});
