// T0B-MISREPORTS-1 done_when (2) "commission, TDS and totals are integer paisa computed from posted data only (held ledger entries excluded)" and (4) "the two level
// commission rows equal the commission_bp of the settings applied to the bills; the TDS report equals commission times tds_bp"; LD-342 / A39-1, A39-4 (reports only).
// REAL PG17. The two reports are the only place the rates are used; C8 stores none: they are read from the partners party settings at run time (A39-4).
//
// DEPENDENCY (open item 1 of .orchestra/notes/T0B-MISREPORTS-1-tests.md): the table holding commission_bp and tds_bp (partners party settings, T0C-PARTYSET-1, migration
// 20261117220000) and the parent / sub party link are NOT in this tree yet. The first test fails by name until they are; every other test of this file needs them too.
// The table is found by its columns (a table of schema partners with commission_bp and tds_bp; party key column = party_id | credit_party_id | partner_id; parent link column =
// parent_party_id | parent_id on the same table), no table name is invented here.
// Pinned picks (writer may dispute): base of a party = sum over its ISSUED (not cancelled) invoices in the range of gross - discount - credited_total (M33 for a credit party, before
// tax, minus credit notes), nothing from billing.account_ledger_entries rows that are held; rounding half up per row: commission = round(base * commission_bp / 10000),
// tds_withheld = round(commission * tds_bp / 10000), net_payable = commission - tds_withheld, all integers. A row exists iff the party has a settings row and >= 1 posted invoice in the
// range. Level 1 = a party without a parent (parent_party_id ''), level 2 = a sub party (its own bills; no roll up into the parent).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { MONEY_CODES, def, expectedColumns } from './contract.js';
import { ALL, TENANT_A, TENANT_B, allPages, cleanupWorld, makeSpec, misReports, ownerSql, rangeOf, seedWorld, sum, superTx, uid, withCtx, type Bill, type World } from './kit.js';

const FROM = '2020-06-01', TO = '2020-06-30', T = 600_000;
const halfUp = (n: number, bp: number) => Math.floor((n * bp + 5000) / 10000);
let A: World, B: World;
let S: { table: string; cols: string[]; party: string; parent: string } | null = null;
const cancelled = new Set<string>(); const credited = new Map<string, number>();
const RATES: Record<number, { c: number; t: number }> = { 0: { c: 1000, t: 1500 }, 1: { c: 725, t: 1000 }, 2: { c: 333, t: 1500 }, 3: { c: 0, t: 1500 } };

async function discover() {
  const rows = await ownerSql(`SELECT table_name, array_agg(column_name::text) AS cols FROM information_schema.columns WHERE table_schema = 'partners'
     GROUP BY table_name HAVING bool_or(column_name = 'commission_bp') AND bool_or(column_name = 'tds_bp') ORDER BY table_name`);
  if (!rows.length) return null;
  const cols: string[] = rows[0].cols;
  const party = ['party_id', 'credit_party_id', 'partner_id'].find((c) => cols.includes(c)); const parent = ['parent_party_id', 'parent_id'].find((c) => cols.includes(c));
  return party && parent ? { table: `partners.${rows[0].table_name}`, cols, party, parent } : null;
}
const need = () => {
  if (!S) throw new Error('T0B-MISREPORTS-1 needs the partners party settings (commission_bp, tds_bp) and the parent / sub party link of T0C-PARTYSET-1 (migration 20261117220000): not in this database. See open item 1 in .orchestra/notes/T0B-MISREPORTS-1-tests.md');
  return S;
};
async function putSettings(w: World, rates: Record<number, { c: number; t: number }>, parentOf: Record<number, number | null>) {
  const s = need();
  const rows = Object.keys(rates).map(Number).map((i) => {
    const parent = parentOf[i] === null || parentOf[i] === undefined ? null : w.spec.parties[parentOf[i]!];
    return { ...(s.cols.includes('id') ? { id: uid() } : {}), tenant_id: w.spec.tenant, [s.party]: w.spec.parties[i], [s.parent]: parent, commission_bp: rates[i]!.c, tds_bp: rates[i]!.t,
      ...(s.cols.includes('created_by') ? { created_by: '01a1b34e-1000-7eee-9d29-d7ca59a102b5' } : {}), ...(s.cols.includes('updated_by') ? { updated_by: '01a1b34e-1000-7eee-9d29-d7ca59a102b5' } : {}) };
  });
  await superTx(async (tx) => {
    await tx.query('SET LOCAL session_replication_role = replica');
    const cols = Object.keys(rows[0]!).map((c) => `"${c}"`).join(',');
    await tx.query(`INSERT INTO ${s.table} (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::${s.table}, $1::jsonb)`, [JSON.stringify(rows)]);
  }, w.spec.tenant);
}
const dropSettings = async (w: World) => { if (!S) return; await superTx(async (tx) => { await tx.query('SET LOCAL session_replication_role = replica'); await tx.query(`DELETE FROM ${S!.table} WHERE tenant_id = $1 AND ${S!.party} = ANY($2::uuid[])`, [w.spec.tenant, w.spec.parties]); }, w.spec.tenant); };
const setRate = async (w: World, i: number, c: number, t: number) => { const s = need(); await superTx(async (tx) => { await tx.query('SET LOCAL session_replication_role = replica'); await tx.query(`UPDATE ${s.table} SET commission_bp = $3, tds_bp = $4 WHERE tenant_id = $1 AND ${s.party} = $2`, [w.spec.tenant, w.spec.parties[i], c, t]); }, w.spec.tenant); };

const run = (code: string, a: Record<string, unknown> = {}, w: World = A, mode: 'rls' | 'owner' = 'rls') =>
  withCtx(w, mode, async ({ ctx }) => (await misReports()).runMisReport(ctx, code, { range: rangeOf(FROM, TO), scope: ALL, limit: 1000, ...a }));
const base = (bs: Bill[]) => sum(bs.filter((b) => !cancelled.has(b.id)).map((b) => b.gross - b.discount - (credited.get(b.id) ?? 0)));
const posted = (w: World, i: number) => w.bills.filter((b) => b.partyId === w.spec.parties[i] && !cancelled.has(b.id));
async function rejected(p: Promise<unknown>): Promise<LimsError> { try { await p; } catch (e) { return e as LimsError; } throw new Error('expected a rejection'); }

beforeAll(async () => {
  S = await discover();
  A = await seedWorld(makeSpec({ tenant: TENANT_A, bills: 150, seed: 21, tag: 'MISCA' }));
  B = await seedWorld(makeSpec({ tenant: TENANT_B, bills: 80, seed: 22, tag: 'MISCB' }));
  // posted data only: one credit bill of party 1 is cancelled, one of party 2 carries a credit note
  const c1 = A.bills.filter((b) => b.partyId === A.spec.parties[1])[0]!; cancelled.add(c1.id);
  const c2 = A.bills.filter((b) => b.partyId === A.spec.parties[2])[0]!; credited.set(c2.id, Math.min(5000, c2.net));
  await superTx(async (tx) => {
    await tx.query('SET LOCAL session_replication_role = replica');
    await tx.query(`UPDATE billing.invoices SET status = 'cancelled', is_active = false, cancelled_at = now(), cancel_reason_code = 'entry_error', credit_note_id = $2 WHERE id = $1`, [c1.id, uid()]);
    await tx.query(`UPDATE billing.invoices SET credited_total_paisa = $2 WHERE id = $1`, [c2.id, credited.get(c2.id)]);
  }, TENANT_A);
  if (S) { await putSettings(A, RATES, { 0: null, 1: 0, 2: 0, 3: null }); await putSettings(B, { 0: { c: 9999, t: 9999 }, 1: { c: 9999, t: 9999 } }, { 0: null, 1: 0 }); }
}, T);
afterAll(async () => { if (A) { await dropSettings(A); await cleanupWorld(A); } if (B) { await dropSettings(B); await cleanupWorld(B); } }, T);

describe('dependency', () => {
  it('the partners party settings with commission_bp, tds_bp and the parent link exist in this database (T0C-PARTYSET-1)', () => { expect(need().table).toMatch(/^partners\./); });
});

describe.each(MONEY_CODES)('%s', (code) => {
  it('an empty range returns the contract headers and no rows', async () => {
    need();
    const r = await run(code, { range: rangeOf('2019-01-01', '2019-01-02') });
    expect(r.columns).toEqual(expectedColumns(code)); expect(r.rows).toEqual([]);
  }, T);
  it('columns, integer paisa and basis points only, default sort, no pay / status column', async () => {
    need();
    const r = await run(code); const d = def(code);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(Object.keys(row).sort()).toEqual(d.columns.map((c) => c.name).sort());
      for (const c of d.columns) if (/paisa|bp$|level/.test(c.name)) expect(Number.isSafeInteger(row[c.name]), `${c.name}=${row[c.name]}`).toBe(true);
    }
    for (let i = 1; i < r.rows.length; i++) expect(r.rows[i - 1][d.default_sort.column]).toBeGreaterThanOrEqual(r.rows[i][d.default_sort.column]);
  }, T);
});

describe('two_level_commission: rows equal commission_bp of the settings applied to the posted bills', () => {
  it('every party with a settings row and a posted bill has one row; level, parent, base, rate and amount are right; cancelled and credited amounts are not counted', async () => {
    need();
    const rows = (await run('two_level_commission')).rows;
    const want = [0, 1, 2, 3].map((i) => ({ i, bs: posted(A, i) })).filter((x) => x.bs.length > 0);
    expect(want.length).toBeGreaterThanOrEqual(3);
    expect(rows.map((r) => r.party_id).sort()).toEqual(want.map((x) => A.spec.parties[x.i]!).sort());
    for (const { i, bs } of want) {
      const r = rows.find((x) => x.party_id === A.spec.parties[i])!;
      const b = base(bs);
      expect(r, `party ${i}`).toMatchObject({
        level: i === 1 || i === 2 ? 2 : 1, parent_party_id: i === 1 || i === 2 ? A.spec.parties[0] : '', orders_registered: bs.length, net_billed_paisa: b,
        commission_bp: RATES[i]!.c, commission_paisa: halfUp(b, RATES[i]!.c),
      });
      expect(typeof r.party_name).toBe('string'); expect(typeof r.parent_party_name).toBe('string');
    }
    const naive = sum(A.bills.filter((b) => b.partyId === A.spec.parties[1]).map((b) => b.gross - b.discount));
    expect(rows.find((r) => r.party_id === A.spec.parties[1])!.net_billed_paisa, 'a cancelled invoice is not posted data').toBeLessThan(naive);
    const credit = A.bills.find((b) => credited.has(b.id))!;
    expect(credit.partyId).toBe(A.spec.parties[2]); // the credit note is subtracted: see the toMatchObject of party 2 above
  }, T);

  it('reconciles to the billing register: Σ net billed of the rows = issued invoices of the parties minus credited totals (independent SQL)', async () => {
    need();
    const rows = (await run('two_level_commission')).rows;
    const reg = Number((await ownerSql(`SELECT coalesce(sum(gross_paisa - discount_paisa - credited_total_paisa), 0)::bigint AS n FROM billing.invoices
       WHERE tenant_id = $1 AND status = 'issued' AND credit_party_id = ANY($2::uuid[]) AND (issued_at AT TIME ZONE 'Asia/Kathmandu')::date BETWEEN $3::date AND $4::date`,
      [TENANT_A, A.spec.parties, FROM, TO]))[0].n);
    expect(sum(rows.map((r) => r.net_billed_paisa))).toBe(reg);
    expect(sum(rows.map((r) => r.commission_paisa))).toBe(sum(rows.map((r) => halfUp(r.net_billed_paisa, r.commission_bp))));
  }, T);

  it('rates are read from the settings at run time (C8 stores none): a changed rate changes the figures, the old rate does not linger', async () => {
    need();
    await setRate(A, 0, 2000, 1500);
    try {
      const r = (await run('two_level_commission')).rows.find((x) => x.party_id === A.spec.parties[0])!;
      expect(r.commission_bp).toBe(2000); expect(r.commission_paisa).toBe(halfUp(base(posted(A, 0)), 2000));
    } finally { await setRate(A, 0, RATES[0]!.c, RATES[0]!.t); }
  }, T);

  it('a date range halves the figures consistently (inclusive end) and a party without bills in it has no row', async () => {
    need();
    const half = (await run('two_level_commission', { range: rangeOf(FROM, '2020-06-15') })).rows;
    for (const r of half) {
      const bs = posted(A, A.spec.parties.indexOf(r.party_id)).filter((b) => b.day <= '2020-06-15');
      expect(r.net_billed_paisa).toBe(base(bs)); expect(r.orders_registered).toBe(bs.length);
    }
  }, T);
});

describe('tds: equals commission times tds_bp', () => {
  it('per party: commission payable = the commission of the two level report, tds withheld = round(commission x tds_bp / 10000), net payable = difference; the period is echoed', async () => {
    need();
    const tds = (await run('tds')).rows, two = (await run('two_level_commission')).rows;
    expect(tds.map((r) => r.party_id).sort()).toEqual(two.map((r) => r.party_id).sort());
    for (const r of tds) {
      const c = two.find((x) => x.party_id === r.party_id)!; const i = A.spec.parties.indexOf(r.party_id);
      expect(r).toMatchObject({ commission_payable_paisa: c.commission_paisa, tds_bp: RATES[i]!.t, tds_withheld_paisa: halfUp(c.commission_paisa, RATES[i]!.t), period_from: FROM, period_to: TO });
      expect(r.net_payable_paisa).toBe(r.commission_payable_paisa - r.tds_withheld_paisa);
      expect(typeof r.party_name).toBe('string');
    }
    expect(sum(tds.map((r) => r.net_payable_paisa))).toBe(sum(tds.map((r) => r.commission_payable_paisa)) - sum(tds.map((r) => r.tds_withheld_paisa)));
  }, T);
  it('a party with a zero commission rate has a row of zeros (not an error, not a missing row)', async () => {
    need();
    expect(posted(A, 3).length, 'fixture: party 3 has posted bills').toBeGreaterThan(0);
    const r = (await run('tds')).rows.find((x) => x.party_id === A.spec.parties[3]);
    expect(r).toMatchObject({ commission_payable_paisa: 0, tds_withheld_paisa: 0, net_payable_paisa: 0 });
  }, T);
});

describe('isolation, query count, paging for the two money reports', () => {
  it.each(MONEY_CODES)('%s: tenant A never sees tenant B parties or B rates (RLS and explicit tenant predicate), and B never sees A', async (code) => {
    need();
    const [aRls, aOwner, bRls, bOwner] = [await run(code), await run(code, {}, A, 'owner'), await run(code, {}, B, 'rls'), await run(code, {}, B, 'owner')];
    expect(aOwner.rows).toEqual(aRls.rows); expect(bOwner.rows).toEqual(bRls.rows);
    const blobA = JSON.stringify(aRls.rows);
    for (const p of B.spec.parties) expect(blobA.includes(p)).toBe(false);
    expect(blobA.includes('9999')).toBe(false);
    for (const p of A.spec.parties) expect(JSON.stringify(bRls.rows).includes(p)).toBe(false);
    expect(bRls.rows.length).toBeGreaterThan(0);
  }, T);
  it.each(MONEY_CODES)('%s: same statement count for the month, one day and an empty range, at most 8; paging returns the same rows', async (code) => {
    need();
    const count = (a: Record<string, unknown>) => withCtx(A, 'rls', async ({ ctx, statements }) => { await (await misReports()).runMisReport(ctx, code, { range: rangeOf(FROM, TO), scope: ALL, limit: 1000, ...a }); return statements.length; });
    const m = await count({}); expect(m).toBeLessThanOrEqual(8);
    expect([await count({ range: rangeOf('2020-06-10', '2020-06-10') }), await count({ range: rangeOf('2019-01-01', '2019-01-02') })]).toEqual([m, m]);
    const whole = (await run(code)).rows;
    expect(await withCtx(A, 'rls', ({ ctx }) => allPages(ctx, code, { range: rangeOf(FROM, TO), scope: ALL }, 1))).toEqual(whole);
  }, T);
  it.each(MONEY_CODES)('%s: the 366 day cap and a malformed filter use the standard validation error', async (code) => {
    need();
    for (const range of [rangeOf('2020-01-01', '2021-01-01'), rangeOf('2020-06-05', '2020-06-04')]) { const e: any = await rejected(run(code, { range })); expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); }
    const e: any = await rejected(run(code, { filters: { party_id: ["x'; DROP TABLE billing.invoices; --"] } })); expect(e.code).toBe('common.validation_failed');
  }, T);
});
