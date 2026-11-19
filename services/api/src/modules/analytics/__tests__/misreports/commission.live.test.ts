// T0B-MISREPORTS-2 done_when (2) rates read from the partners party settings (C8 stores none, A39-4), ledger items on Hold excluded; (4) the commission report equals commission_bp of
// the settings applied to the net billed base of posted data (M33), the TDS report equals commission times tds_bp, every report returns its headers on an empty range; (5) cross tenant,
// paging and a statement count bound; LD-346 / A39-1, A39-4 (reports only). Re-added from .orchestra/notes/T0B-MISREPORTS-2-commission.live.test.ts.txt (moved out of
// T0B-MISREPORTS-1 by LD-346 (2)), ADAPTED to the real settings table: partners.party_commercial_setting (migration 20261117220000), keyed by (party_kind, party_id), columns
// commission_bp and tds_bp. It has NO parent party column and no other table links a party to a parent (CR .orchestra/cr/T0B-MISREPORTS-2.md), so the rule that makes a party level 2
// is NOT pinned here: only its shape is (level 1 or 2; level 1 -> parent '' ; level 2 -> a parent id other than the party). REAL PG17.
// Pinned picks (writer may dispute through the reviewer): base of a party = sum over its ISSUED (not cancelled) credit invoices in the range of gross - discount - credited_total
// (M33, before tax, minus credit notes); rounding half up per row: commission = round(base * commission_bp / 10000), tds_withheld = round(commission * tds_bp / 10000),
// net_payable = commission - tds_withheld, integers; a row exists iff the party has a settings row of party_kind credit_party and >= 1 posted invoice in the range; the figures of a
// row are the party's OWN bills (no roll up into a parent); a ledger entry on Hold (billing.account_ledger_entries.status = 'held') changes no figure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { MONEY_CODES, def, expectedColumns } from './contract.js';
import { ALL, TENANT_A, TENANT_B, allPages, cleanupWorld, makeSpec, misReports, ownerSql, rangeOf, seedWorld, sum, superTx, uid, withCtx, type Bill, type World } from './kit.js';

const FROM = '2020-06-01', TO = '2020-06-30', T = 600_000, ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5', SETTINGS = 'partners.party_commercial_setting';
const halfUp = (n: number, bp: number) => Math.floor((n * bp + 5000) / 10000);
let A: World, B: World;
const cancelled = new Set<string>(); const credited = new Map<string, number>(); const heldIds: string[] = [];
const RATES: Record<number, { c: number; t: number }> = { 0: { c: 1000, t: 1500 }, 1: { c: 725, t: 1000 }, 2: { c: 333, t: 1500 }, 3: { c: 0, t: 1500 } };

async function putSettings(w: World, rates: Record<number, { c: number; t: number }>) {
  const rows = Object.keys(rates).map(Number).map((i) => ({
    id: uid(), tenant_id: w.spec.tenant, party_kind: 'credit_party', party_id: w.spec.parties[i], auto_release_reports: false, whatsapp_enabled: false, insurance_enabled: false,
    print_exception: false, auto_block_overdue: false, billing_cycle: 'monthly', invoice_payment_days: 30, invoice_blocking_days: 60, invoice_warning_days: 45, interest_bp_per_day: 0,
    commission_bp: rates[i]!.c, tds_bp: rates[i]!.t, priority: 'P3', header_footer_mode: 'both', version: 1, created_at: '2020-06-01T00:00:00Z', updated_at: '2020-06-01T00:00:00Z', created_by: ACTOR, updated_by: ACTOR })); // jsonb_populate_recordset leaves omitted columns NULL, defaults do not apply
  await superTx(async (tx) => {
    await tx.query('SET LOCAL session_replication_role = replica');
    await tx.query(`INSERT INTO ${SETTINGS} SELECT * FROM jsonb_populate_recordset(NULL::${SETTINGS}, $1::jsonb)`, [JSON.stringify(rows)]);
  }, w.spec.tenant);
}
const dropSettings = (w: World) => superTx(async (tx) => { await tx.query('SET LOCAL session_replication_role = replica'); await tx.query(`DELETE FROM ${SETTINGS} WHERE tenant_id = $1 AND party_id = ANY($2::uuid[])`, [w.spec.tenant, w.spec.parties]); }, w.spec.tenant);
const setRate = (w: World, i: number, c: number, t: number) => superTx(async (tx) => { await tx.query('SET LOCAL session_replication_role = replica'); await tx.query(`UPDATE ${SETTINGS} SET commission_bp = $3, tds_bp = $4 WHERE tenant_id = $1 AND party_id = $2`, [w.spec.tenant, w.spec.parties[i], c, t]); }, w.spec.tenant);

const run = (code: string, a: Record<string, unknown> = {}, w: World = A, mode: 'rls' | 'owner' = 'rls') =>
  withCtx(w, mode, async ({ ctx }) => (await misReports()).runMisReport(ctx, code, { range: rangeOf(FROM, TO), scope: ALL, limit: 1000, ...a }));
const base = (bs: Bill[]) => sum(bs.filter((b) => !cancelled.has(b.id)).map((b) => b.gross - b.discount - (credited.get(b.id) ?? 0)));
const posted = (w: World, i: number) => w.bills.filter((b) => b.partyId === w.spec.parties[i] && !cancelled.has(b.id));
async function rejected(p: Promise<unknown>): Promise<LimsError> { try { await p; } catch (e) { return e as LimsError; } throw new Error('expected a rejection'); }

beforeAll(async () => {
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
  await putSettings(A, RATES); await putSettings(B, { 0: { c: 9999, t: 9999 }, 1: { c: 9999, t: 9999 } });
}, T);
afterAll(async () => {
  if (heldIds.length) await superTx(async (tx) => { await tx.query('SET LOCAL session_replication_role = replica'); await tx.query('DELETE FROM billing.account_ledger_entries WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [TENANT_A, heldIds]); }, TENANT_A);
  if (A) { await dropSettings(A); await cleanupWorld(A); } if (B) { await dropSettings(B); await cleanupWorld(B); }
}, T);

describe('dependency: the rates live in the partners party settings, nowhere in C8', () => {
  it('partners.party_commercial_setting has commission_bp and tds_bp (T0C-PARTYSET-1) and the analytics schema stores no rate column', async () => {
    const own = await ownerSql(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'partners' AND table_name = 'party_commercial_setting' AND column_name IN ('commission_bp','tds_bp')`);
    expect(own.map((r) => r.column_name).sort()).toEqual(['commission_bp', 'tds_bp']);
    const c8 = await ownerSql(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'analytics' AND (column_name ~ 'commission|tds')`);
    expect(c8, 'C8 stores none (A39-4)').toEqual([]);
  });
});

describe.each(MONEY_CODES)('%s', (code) => {
  it('an empty range returns the contract headers and no rows', async () => {
    const r = await run(code, { range: rangeOf('2019-01-01', '2019-01-02') });
    expect(r.columns).toEqual(expectedColumns(code)); expect(r.rows).toEqual([]);
  }, T);
  it('columns, integer paisa and basis points only, default sort, no pay / status column', async () => {
    const r = await run(code); const d = def(code);
    expect(r.columns).toEqual(expectedColumns(code));
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(Object.keys(row).sort()).toEqual(d.columns.map((c) => c.name).sort());
      for (const c of d.columns) if (/paisa|bp$|level/.test(c.name)) expect(Number.isSafeInteger(row[c.name]), `${c.name}=${row[c.name]}`).toBe(true);
    }
    for (let i = 1; i < r.rows.length; i++) expect(r.rows[i - 1][d.default_sort.column]).toBeGreaterThanOrEqual(r.rows[i][d.default_sort.column]);
  }, T);
});

describe('two_level_commission: rows equal commission_bp of the settings applied to the posted bills', () => {
  it('every party with a settings row and a posted bill has one row; base, rate and amount are right; cancelled and credited amounts are not counted', async () => {
    const rows = (await run('two_level_commission')).rows;
    const want = [0, 1, 2, 3].map((i) => ({ i, bs: posted(A, i) })).filter((x) => x.bs.length > 0);
    expect(want.length).toBeGreaterThanOrEqual(3);
    expect(rows.map((r) => r.party_id).sort()).toEqual(want.map((x) => A.spec.parties[x.i]!).sort());
    for (const { i, bs } of want) {
      const r = rows.find((x) => x.party_id === A.spec.parties[i])!;
      const b = base(bs);
      expect(r, `party ${i}`).toMatchObject({ orders_registered: bs.length, net_billed_paisa: b, commission_bp: RATES[i]!.c, commission_paisa: halfUp(b, RATES[i]!.c) });
      expect(typeof r.party_name).toBe('string'); expect(typeof r.parent_party_name).toBe('string');
    }
    const naive = sum(A.bills.filter((b) => b.partyId === A.spec.parties[1]).map((b) => b.gross - b.discount));
    expect(rows.find((r) => r.party_id === A.spec.parties[1])!.net_billed_paisa, 'a cancelled invoice is not posted data').toBeLessThan(naive);
    const credit = A.bills.find((b) => credited.has(b.id))!;
    expect(credit.partyId).toBe(A.spec.parties[2]); // the credit note is subtracted: see the toMatchObject of party 2 above
  }, T);

  it('level / parent shape (the rule that makes a party level 2 is open: CR T0B-MISREPORTS-2): level 1 or 2; level 1 has no parent; level 2 names a parent other than itself', async () => {
    for (const r of (await run('two_level_commission')).rows) {
      expect([1, 2], `level of ${r.party_id}`).toContain(r.level);
      if (r.level === 1) { expect(r.parent_party_id).toBe(''); expect(r.parent_party_name).toBe(''); }
      else { expect(r.parent_party_id).toMatch(/^[0-9a-f-]{36}$/); expect(r.parent_party_id).not.toBe(r.party_id); expect(r.parent_party_name.length).toBeGreaterThan(0); }
    }
  }, T);

  it('reconciles to the billing register: Σ net billed of the rows = issued invoices of the parties minus credited totals (independent SQL)', async () => {
    const rows = (await run('two_level_commission')).rows;
    const reg = Number((await ownerSql(`SELECT coalesce(sum(gross_paisa - discount_paisa - credited_total_paisa), 0)::bigint AS n FROM billing.invoices
       WHERE tenant_id = $1 AND status = 'issued' AND credit_party_id = ANY($2::uuid[]) AND (issued_at AT TIME ZONE 'Asia/Kathmandu')::date BETWEEN $3::date AND $4::date`,
      [TENANT_A, A.spec.parties, FROM, TO]))[0].n);
    expect(sum(rows.map((r) => r.net_billed_paisa))).toBe(reg);
    expect(sum(rows.map((r) => r.commission_paisa))).toBe(sum(rows.map((r) => halfUp(r.net_billed_paisa, r.commission_bp))));
  }, T);

  it('rates are read from the party settings at run time (C8 stores none): a changed rate changes the figures, the old rate does not linger', async () => {
    await setRate(A, 0, 2000, 1500);
    try {
      const r = (await run('two_level_commission')).rows.find((x) => x.party_id === A.spec.parties[0])!;
      expect(r.commission_bp).toBe(2000); expect(r.commission_paisa).toBe(halfUp(base(posted(A, 0)), 2000));
    } finally { await setRate(A, 0, RATES[0]!.c, RATES[0]!.t); }
  }, T);

  it('a party without a settings row has no row in either report (pick), the others are unchanged', async () => {
    await superTx(async (tx) => { await tx.query('SET LOCAL session_replication_role = replica'); await tx.query(`UPDATE ${SETTINGS} SET party_kind = 'partner' WHERE tenant_id = $1 AND party_id = $2`, [TENANT_A, A.spec.parties[2]]); }, TENANT_A);
    try {
      for (const code of MONEY_CODES) {
        const ids = (await run(code)).rows.map((r) => r.party_id);
        expect(ids).not.toContain(A.spec.parties[2]); expect(ids).toContain(A.spec.parties[0]);
      }
    } finally { await superTx(async (tx) => { await tx.query('SET LOCAL session_replication_role = replica'); await tx.query(`UPDATE ${SETTINGS} SET party_kind = 'credit_party' WHERE tenant_id = $1 AND party_id = $2`, [TENANT_A, A.spec.parties[2]]); }, TENANT_A); }
  }, T);

  it('a date range narrows the figures consistently (inclusive end)', async () => {
    const half = (await run('two_level_commission', { range: rangeOf(FROM, '2020-06-15') })).rows;
    expect(half.length).toBeGreaterThan(0);
    for (const r of half) {
      const bs = posted(A, A.spec.parties.indexOf(r.party_id)).filter((b) => b.day <= '2020-06-15');
      expect(r.net_billed_paisa).toBe(base(bs)); expect(r.orders_registered).toBe(bs.length);
    }
  }, T);

  it('ledger entries on Hold are excluded: holding a ledger entry of a party (and a plain submitted one) changes no figure of either report', async () => {
    const before = [await run('two_level_commission'), await run('tds')].map((r) => r.rows);
    const mk = (status: 'held' | 'submitted', n: number) => {
      const id = uid(); heldIds.push(id);
      return { id, tenant_id: TENANT_A, centre_id: A.spec.centres[0], party_kind: 'credit_party', party_id: A.spec.parties[0], entry_date: '2020-06-10', account_particular_id: uid(), entry_type: 'debit',
        amount_paisa: 7_000_000 + n, payment_mode: 'cash', status, receipt_no: `HOLDTEST-${id}`, receipt_seq: 900_000_000 + Math.floor(Math.random() * 90_000_000) + n, created_by: ACTOR, last_modified_by: ACTOR, created_at: '2020-06-10T00:00:00Z', updated_at: '2020-06-10T00:00:00Z',
        ...(status === 'held' ? { held_reason: 'synthetic hold', held_by: ACTOR, held_at: '2020-06-11T00:00:00Z' } : {}) };
    };
    await superTx(async (tx) => {
      await tx.query('SET LOCAL session_replication_role = replica');
      await tx.query('INSERT INTO billing.account_ledger_entries SELECT * FROM jsonb_populate_recordset(NULL::billing.account_ledger_entries, $1::jsonb)', [JSON.stringify([mk('held', 1), mk('submitted', 2)])]);
    }, TENANT_A);
    const after = [await run('two_level_commission'), await run('tds')].map((r) => r.rows);
    expect(after).toEqual(before);
  }, T);
});

describe('tds: equals commission times tds_bp', () => {
  it('per party: commission payable = the commission of the two level report, tds withheld = round(commission x tds_bp / 10000), net payable = difference; the period is echoed', async () => {
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
    expect(posted(A, 3).length, 'fixture: party 3 has posted bills').toBeGreaterThan(0);
    const r = (await run('tds')).rows.find((x) => x.party_id === A.spec.parties[3]);
    expect(r).toMatchObject({ commission_payable_paisa: 0, tds_withheld_paisa: 0, net_payable_paisa: 0 });
  }, T);
  it('a changed tds_bp changes only the TDS figures, the commission payable stays', async () => {
    const was = (await run('tds')).rows.find((x) => x.party_id === A.spec.parties[0])!;
    await setRate(A, 0, RATES[0]!.c, 0);
    try {
      const r = (await run('tds')).rows.find((x) => x.party_id === A.spec.parties[0])!;
      expect(r).toMatchObject({ commission_payable_paisa: was.commission_payable_paisa, tds_bp: 0, tds_withheld_paisa: 0, net_payable_paisa: was.commission_payable_paisa });
    } finally { await setRate(A, 0, RATES[0]!.c, RATES[0]!.t); }
  }, T);
});

describe('isolation, query count, paging for the two money reports', () => {
  it.each(MONEY_CODES)('%s: tenant A never sees tenant B parties or B rates (RLS and explicit tenant predicate), and B never sees A', async (code) => {
    const [aRls, aOwner, bRls, bOwner] = [await run(code), await run(code, {}, A, 'owner'), await run(code, {}, B, 'rls'), await run(code, {}, B, 'owner')];
    expect(aOwner.rows).toEqual(aRls.rows); expect(bOwner.rows).toEqual(bRls.rows);
    const blobA = JSON.stringify(aRls.rows);
    for (const p of B.spec.parties) expect(blobA.includes(p)).toBe(false);
    expect(blobA.includes('9999')).toBe(false);
    for (const p of A.spec.parties) expect(JSON.stringify(bRls.rows).includes(p)).toBe(false);
    expect(bRls.rows.length).toBeGreaterThan(0);
  }, T);
  it.each(MONEY_CODES)('%s: same statement count for the month, one day and an empty range, at most 8; paging returns the same rows', async (code) => {
    const count = (a: Record<string, unknown>) => withCtx(A, 'rls', async ({ ctx, statements }) => { await (await misReports()).runMisReport(ctx, code, { range: rangeOf(FROM, TO), scope: ALL, limit: 1000, ...a }); return statements.length; });
    const m = await count({}); expect(m).toBeLessThanOrEqual(8);
    expect([await count({ range: rangeOf('2020-06-10', '2020-06-10') }), await count({ range: rangeOf('2019-01-01', '2019-01-02') })]).toEqual([m, m]);
    const whole = (await run(code)).rows;
    expect(await withCtx(A, 'rls', ({ ctx }) => allPages(ctx, code, { range: rangeOf(FROM, TO), scope: ALL }, 1))).toEqual(whole);
  }, T);
  it.each(MONEY_CODES)('%s: the 366 day cap and a malformed filter use the standard validation error', async (code) => {
    for (const range of [rangeOf('2020-01-01', '2021-01-01'), rangeOf('2020-06-05', '2020-06-04')]) { const e: any = await rejected(run(code, { range })); expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); }
    const e: any = await rejected(run(code, { filters: { party_id: ["x'; DROP TABLE billing.invoices; --"] } })); expect(e.code).toBe('common.validation_failed');
  }, T);
  it.each(MONEY_CODES)('%s: a party_id filter narrows to that party (a parent may show with its sub parties: open rule) and cannot reach another tenant', async (code) => {
    const mine = (await run(code, { filters: { party_id: [A.spec.parties[0]] } })).rows;
    expect(mine.map((r) => r.party_id)).toContain(A.spec.parties[0]);
    expect(mine.map((r) => r.party_id)).not.toContain(A.spec.parties[3]); // party 3 has no relation to party 0 under any rule
    const foreign = (await run(code, { filters: { party_id: [B.spec.parties[0]] } })).rows;
    expect(foreign).toEqual([]);
  }, T);
});
