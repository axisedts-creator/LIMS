// T0B-MISREPORTS-1 done_when (2) one parameterised SQL query per report with paging, tenant isolation, 366 day cap, no per row queries; (4) RECONCILIATION tests;
// (5) cross tenant isolation. REAL PG17 (lims_api under RLS, and the superuser with RLS bypassed so that the explicit tenant predicate is proven too); synthetic data.
// The reports are called as runMisReport / streamMisReport of service/misReports.service.ts (pinned in kit.ts). Expectations are computed here in plain JS from the
// generated bills and, for the registers, with independent SQL over the base tables (billing.invoices, billing.ledger_entries): never with the writer's own queries.
// Pinned picks (writer may dispute through the reviewer):
//   bill_of_the_day: one row per issued invoice of the range, paid = payments net of reversals (billing.ledger_entries), due = net - paid, party_id '' for a cash bill; newest first.
//   sales_representative: only the parties assigned to the representative, on the days inside the assignment window (inclusive); no roll up of the sub tree.
//   consultant: one row per (referrer, department); orders without a referrer (SELF) are not consultant rows; net_billed = sum of invoice_lines.net_paisa of the department.
//   collection_boy: collected_paisa = sum of ledger payments by collected_by_membership_id on business_date in range, reversals netted; collections_count = applied homecollection.collections.
//   repeated_patient: patients with >= min_repeat_count (default 2) registered orders in the range. repeated_test: tests ordered >= min_repeat_count times by the same patient.
//   party_billing / ipd_opd: per credit party / per (business_date, centre, visit_type). Text that is absent is '' and numbers are safe integers.
//   limit 1..1000 (default 100); a cursor of one report is opaque (garbage -> 400 common.invalid_cursor). A restricted scope wins over a centre filter outside it (empty, not an error).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { DEFS, PLAIN_CODES, def, expectedColumns } from './contract.js';
import {
  ALL, TENANT_A, TENANT_B, allPages, cleanupWorld, makeSpec, misReports, ownerSql, rangeOf, seedSales, seedWorld, sum, superTx, uid, withCtx,
  type Bill, type World,
} from './kit.js';

const FROM = '2020-06-01', TO = '2020-06-30', MID = '2020-06-16';
const T = 600_000;
let A: World, B: World, mid = '';
const inR = (b: Bill, from = FROM, to = TO) => b.day >= from && b.day <= to;
const run = (code: string, a: Record<string, unknown> = {}, w: World = A, mode: 'rls' | 'owner' = 'rls') =>
  withCtx(w, mode, async ({ ctx }) => (await misReports()).runMisReport(ctx, code, { range: rangeOf(FROM, TO), scope: ALL, limit: 1000, ...a }));
const rowsOf = async (code: string, a: Record<string, unknown> = {}, w: World = A, mode: 'rls' | 'owner' = 'rls'): Promise<any[]> => (await run(code, a, w, mode)).rows;
async function rejected(p: Promise<unknown>): Promise<LimsError> { try { await p; } catch (e) { return e as LimsError; } throw new Error('expected a rejection'); }
const std = (e: any) => { expect(e?.code, e?.message).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(Array.isArray(e.errors) && e.errors.length > 0).toBe(true); };
const group = <K>(bs: Bill[], key: (b: Bill) => K) => { const m = new Map<K, Bill[]>(); for (const b of bs) m.set(key(b), [...(m.get(key(b)) ?? []), b]); return m; };
const num = (v: unknown) => { expect(Number.isSafeInteger(v), String(v)).toBe(true); return v as number; };

beforeAll(async () => {
  A = await seedWorld(makeSpec({ tenant: TENANT_A, bills: 120, seed: 7, tag: 'MISA' }));
  B = await seedWorld(makeSpec({ tenant: TENANT_B, bills: 70, seed: 11, tag: 'MISB' }));
  ({ mid } = await seedSales(A));
  // one payment of tenant A is reversed in full (the reversal copies the payment's collector, order, invoice, centre and business date: billing.ledger_reversal_guard)
  const b = A.bills.find((x) => x.payId && x.collectorId)!;
  const rid = uid();
  await superTx(async (tx) => {
    await tx.query('SET LOCAL session_replication_role = replica');
    await tx.query(
      `INSERT INTO billing.ledger_entries (id, tenant_id, branch_id, centre_id, order_id, invoice_id, entry_kind, capture_kind, method_code, amount_paisa, reverses_entry_id, reason_code,
         fiscal_year_bs, collected_by_membership_id, business_date, created_by)
       SELECT $1, tenant_id, branch_id, centre_id, order_id, invoice_id, 'reversal', capture_kind, method_code, -amount_paisa, id, 'entry_error', fiscal_year_bs,
              collected_by_membership_id, business_date, created_by FROM billing.ledger_entries WHERE id = $2`, [rid, b.payId]);
  }, TENANT_A);
  A.ids.ledger!.push(rid); b.paid = 0;
}, T);
afterAll(async () => { if (A) await cleanupWorld(A); if (B) await cleanupWorld(B); }, T);

// =============================================================================================== headers, shape, paging
describe('every plain report: shape, empty range, ordering, paging, limits', () => {
  it.each(PLAIN_CODES)('%s: an empty range still returns the contract headers (keys, labels, kinds in contract order) and no rows', async (code) => {
    const r = await run(code, { range: rangeOf('2019-01-01', '2019-01-02') });
    expect(r.columns).toEqual(expectedColumns(code));
    expect(r.rows).toEqual([]);
    expect(r.next_cursor).toBeUndefined();
  }, T);

  it.each(PLAIN_CODES)('%s: columns as contract; each row has exactly the contract keys (no extra, no patient name / phone); numbers are safe integers; rows follow default_sort', async (code) => {
    const r = await run(code);
    expect(r.columns).toEqual(expectedColumns(code));
    const d = def(code); const names = d.columns.map((c) => c.name);
    for (const row of r.rows) {
      expect(Object.keys(row).sort(), code).toEqual([...names].sort());
      for (const c of d.columns) { if (c.type === 'integer' || c.type === 'integer_paisa' || c.type === 'basis_points') num(row[c.name]); else expect(typeof row[c.name], `${code}.${c.name}`).toBe('string'); }
    }
    const col = d.default_sort.column; const sign = d.default_sort.direction === 'desc' ? -1 : 1;
    for (let i = 1; i < r.rows.length; i++) {
      const [p, q] = [r.rows[i - 1][col], r.rows[i][col]];
      expect(typeof p === 'number' ? (p - q) * sign : String(p).localeCompare(String(q)) * sign, `${code} order at ${i}`).toBeLessThanOrEqual(0);
    }
    expect(r.rows.length, `${code} fixture produces rows`).toBeGreaterThan(code === 'outsource' ? -1 : 0);
  }, T);

  it('paging by cursor returns every row exactly once, in the same order as one big page; the last page has no cursor', async () => {
    for (const code of ['bill_of_the_day', 'party_billing', 'ipd_opd', 'consultant']) {
      const whole = await rowsOf(code);
      const paged = await withCtx(A, 'rls', ({ ctx }) => allPages(ctx, code, { range: rangeOf(FROM, TO), scope: ALL }, 7));
      expect(paged, code).toEqual(whole);
      expect(whole.length, code).toBeGreaterThan(7);
    }
    const last = await withCtx(A, 'rls', async ({ ctx }) => (await misReports()).runMisReport(ctx, 'bill_of_the_day', { range: rangeOf(FROM, TO), scope: ALL, limit: 1000 }));
    expect(last.next_cursor).toBeUndefined();
  }, T);

  it('limit outside 1..1000 or not an integer -> 400 standard error; a garbage cursor -> 400 common.invalid_cursor', async () => {
    for (const limit of [0, -1, 1001, 1.5, '7']) std(await rejected(run('bill_of_the_day', { limit })));
    const e: any = await rejected(run('bill_of_the_day', { cursor: 'not-a-cursor' }));
    expect(e.code).toBe('common.invalid_cursor');
  }, T);

  it('date cap (done_when 3): 367 days, from after to, a malformed date -> the standard validation error; exactly 366 days is allowed', async () => {
    for (const range of [rangeOf('2020-01-01', '2021-01-01'), rangeOf('2020-06-05', '2020-06-04'), rangeOf('2020-13-01', '2020-13-02'), rangeOf('2020-06-01', undefined as never)]) {
      for (const code of PLAIN_CODES) std(await rejected(run(code, { range })));
    }
    for (const code of PLAIN_CODES) expect((await run(code, { range: rangeOf('2020-01-01', '2020-12-31') })).columns, code).toEqual(expectedColumns(code)); // 2020 is a leap year: 366 days
  }, T);

  it('hostile and unknown filters are refused by the standard error, never reaching SQL; the tables survive', async () => {
    for (const filters of [{ party_id: ["'; DROP TABLE billing.invoices; --"] }, { no_such_filter: ['x'] }, { centre_id: 'not-an-array' }, { min_repeat_count: '2; select 1' }, { visit_type: 'icu' }]) {
      std(await rejected(run('bill_of_the_day', { filters })));
      std(await rejected(run('repeated_patient', { filters })));
    }
    expect(Number((await ownerSql('SELECT count(*)::int AS n FROM billing.invoices WHERE tenant_id = $1', [TENANT_A]))[0].n)).toBeGreaterThanOrEqual(120);
  }, T);
});

// =============================================================================================== Bill of the Day (reconciled to the billing register)
describe('Bill of the Day equals the billing register for the day (done_when 4)', () => {
  const busiest = () => { const m = group(A.bills, (b) => b.day); return [...m.entries()].sort((x, y) => y[1].length - x[1].length || (x[0] < y[0] ? -1 : 1))[0]!; };

  it('one business day: the rows are exactly the issued invoices of that day; every amount matches; totals equal an independent SQL over billing.invoices and billing.ledger_entries', async () => {
    const [day, bills] = busiest();
    expect(bills.length).toBeGreaterThanOrEqual(3);
    for (const mode of ['rls', 'owner'] as const) {
      const rows = await rowsOf('bill_of_the_day', { range: rangeOf(day, day) }, A, mode);
      expect(rows.map((r) => r.invoice_id).sort(), mode).toEqual(bills.map((b) => b.id).sort());
      for (const r of rows) {
        const b = bills.find((x) => x.id === r.invoice_id)!;
        expect(r).toMatchObject({ invoice_number: b.no, business_date: day, centre_id: b.centreId, party_id: b.partyId ?? '', gross_paisa: b.gross, discount_paisa: b.discount, net_paisa: b.net, paid_paisa: b.paid, due_paisa: b.net - b.paid });
        expect(Date.parse(r.billed_at)).toBe(Date.parse(`${day}T06:00:00Z`));
      }
      const reg = (await ownerSql(
        `SELECT count(*)::int AS n, coalesce(sum(gross_paisa),0)::bigint AS g, coalesce(sum(discount_paisa),0)::bigint AS d, coalesce(sum(net_paisa),0)::bigint AS net
           FROM billing.invoices WHERE tenant_id = $1 AND status = 'issued' AND (issued_at AT TIME ZONE 'Asia/Kathmandu')::date = $2::date`, [TENANT_A, day]))[0];
      const paid = (await ownerSql(
        `SELECT coalesce(sum(amount_paisa),0)::bigint AS p FROM billing.ledger_entries
          WHERE tenant_id = $1 AND invoice_id IN (SELECT id FROM billing.invoices WHERE tenant_id = $1 AND status = 'issued' AND (issued_at AT TIME ZONE 'Asia/Kathmandu')::date = $2::date)`, [TENANT_A, day]))[0];
      expect({ n: rows.length, g: sum(rows.map((r) => r.gross_paisa)), d: sum(rows.map((r) => r.discount_paisa)), net: sum(rows.map((r) => r.net_paisa)), p: sum(rows.map((r) => r.paid_paisa)) }, mode)
        .toEqual({ n: reg.n, g: Number(reg.g), d: Number(reg.d), net: Number(reg.net), p: Number(paid.p) });
      expect(sum(rows.map((r) => r.gross_paisa - r.discount_paisa)), 'gross - discount = net (no tax in this fixture)').toBe(sum(rows.map((r) => r.net_paisa)));
    }
  }, T);

  it('the reversed payment is netted: that bill shows paid 0 and its full amount due', async () => {
    const b = A.bills.find((x) => x.payId && x.paid === 0 && x.collectorId)!;
    const row = (await rowsOf('bill_of_the_day', { range: rangeOf(b.day, b.day) })).find((r) => r.invoice_id === b.id)!;
    expect(row).toMatchObject({ paid_paisa: 0, due_paisa: b.net });
  }, T);

  it('a whole month, centre filter, party filter, restricted scope', async () => {
    const all = await rowsOf('bill_of_the_day');
    expect(all).toHaveLength(A.bills.length);
    const c0 = A.spec.centres[0]!, c1 = A.spec.centres[1]!;
    const byCentre = await rowsOf('bill_of_the_day', { filters: { centre_id: [c0] } });
    expect(byCentre.map((r) => r.invoice_id).sort()).toEqual(A.bills.filter((b) => b.centreId === c0).map((b) => b.id).sort());
    const scoped = await rowsOf('bill_of_the_day', { scope: { all: false, centreIds: [c1] } });
    expect(scoped.map((r) => r.invoice_id).sort()).toEqual(A.bills.filter((b) => b.centreId === c1).map((b) => b.id).sort());
    expect(await rowsOf('bill_of_the_day', { scope: { all: false, centreIds: [c1] }, filters: { centre_id: [c0] } }), 'scope wins over a filter outside it').toEqual([]);
    expect(await rowsOf('bill_of_the_day', { scope: { all: false, centreIds: [] } }), 'a scope with no centre sees nothing').toEqual([]);
    const p = A.spec.parties[1]!;
    expect((await rowsOf('bill_of_the_day', { filters: { party_id: [p] } })).map((r) => r.invoice_id).sort()).toEqual(A.bills.filter((b) => b.partyId === p).map((b) => b.id).sort());
  }, T);
});

// =============================================================================================== sales representative / consultant / collection boy: totals = sum of rows
describe('sales representative, consultant and collection boy: rows and totals reconcile (done_when 4)', () => {
  const assigned = (rep: 'top' | 'sub', from: string, to: string) => {
    const parts = rep === 'top' ? [[A.spec.parties[0]!, FROM], [A.spec.parties[1]!, mid]] : [[A.spec.parties[2]!, FROM]];
    return parts.flatMap(([p, eff]) => A.bills.filter((b) => b.partyId === p && b.day >= eff! && b.day >= from && b.day <= to));
  };

  it('sales_representative: per representative, only assigned parties inside their window; orders, net billed and collected; Σ rows = Σ assigned bills', async () => {
    const rows = await rowsOf('sales_representative');
    const top = rows.find((r) => r.representative_id === A.reps!.top)!, sub = rows.find((r) => r.representative_id === A.reps!.sub)!;
    for (const [row, who, level, name] of [[top, 'top', 7, 'Synthetic Head Rep'], [sub, 'sub', 8, 'Synthetic Exec Rep']] as const) {
      const bs = assigned(who, FROM, TO);
      expect(row, who).toMatchObject({ representative_name: name, designation_level: level, orders_registered: bs.length, net_billed_paisa: sum(bs.map((b) => b.net)), collected_paisa: sum(bs.map((b) => b.paid)) });
    }
    expect(top.parties_count).toBe(2); expect(sub.parties_count).toBe(1);
    expect(rows.map((r) => r.representative_id).sort(), 'no row for a representative of another tenant').toEqual([A.reps!.top, A.reps!.sub].sort());
    expect(sum(rows.map((r) => r.net_billed_paisa))).toBe(sum([...assigned('top', FROM, TO), ...assigned('sub', FROM, TO)].map((b) => b.net)));
    const unassigned = A.bills.filter((b) => b.partyId === A.spec.parties[3]);
    expect(unassigned.length).toBeGreaterThan(0); // fixture sanity: this party's bills belong to nobody
    expect(sum(rows.map((r) => r.orders_registered))).toBe(assigned('top', FROM, TO).length + assigned('sub', FROM, TO).length);
  }, T);

  it('sales_representative: the assignment window is honoured (first half: only the party assigned from day 1)', async () => {
    const rows = await rowsOf('sales_representative', { range: rangeOf(FROM, '2020-06-15') });
    const top = rows.find((r) => r.representative_id === A.reps!.top)!;
    expect(top.parties_count).toBe(1);
    expect(top.net_billed_paisa).toBe(sum(assigned('top', FROM, '2020-06-15').map((b) => b.net)));
    expect(top.orders_registered).toBe(assigned('top', FROM, '2020-06-15').length);
  }, T);

  it('sales_representative: representative filter returns that row only; a foreign / unknown id returns nothing and leaks nothing', async () => {
    expect((await rowsOf('sales_representative', { filters: { representative_id: [A.reps!.sub] } })).map((r) => r.representative_id)).toEqual([A.reps!.sub]);
    expect(await rowsOf('sales_representative', { filters: { representative_id: [uid()] } })).toEqual([]);
    expect(await rowsOf('sales_representative', { filters: { representative_id: [B.spec.parties[0]!] } }, A)).toEqual([]);
  }, T);

  // LD-346 (1): the consultant report is VOLUME ONLY (no per-referrer money outside the gate, A39-3): no net_billed_paisa column, sorted by tests_count descending.
  it('consultant (LD-346): per (referrer, department) orders and tests only, no money column, sorted by tests_count desc; Σ tests = tests of the referred bills', async () => {
    expect(def('consultant').columns.map((c) => c.name)).not.toContain('net_billed_paisa');
    expect(def('consultant').default_sort).toEqual({ column: 'tests_count', direction: 'desc' });
    const rows = await rowsOf('consultant');
    const want = new Map<string, { orders: Set<string>; tests: number }>();
    for (const b of A.bills.filter((x) => x.referrerId)) for (const l of b.lines) {
      const k = `${b.referrerId}|${l.deptId}`; const e = want.get(k) ?? { orders: new Set<string>(), tests: 0 };
      e.orders.add(b.orderId); e.tests++; want.set(k, e);
    }
    expect(rows).toHaveLength(want.size);
    for (const r of rows) {
      const e = want.get(`${r.referrer_id}|${r.department_id}`)!;
      expect(e, `${r.referrer_id}|${r.department_id}`).toBeDefined();
      expect(r).toMatchObject({ orders_registered: e.orders.size, tests_count: e.tests });
      expect(Object.keys(r).filter((k) => /paisa|net_billed|amount/i.test(k)), 'no money key in a consultant row').toEqual([]);
      expect(typeof r.referrer_name).toBe('string');
    }
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].tests_count).toBeGreaterThanOrEqual(rows[i].tests_count);
    expect(sum(rows.map((r) => r.tests_count))).toBe(sum(A.bills.filter((b) => b.referrerId).map((b) => b.lines.length)));
  }, T);

  it('consultant: referrer and department filters', async () => {
    const r0 = A.spec.referrers[0]!, d0 = A.spec.depts[0]!;
    const byRef = await rowsOf('consultant', { filters: { referrer_id: [r0] } });
    expect(byRef.length).toBeGreaterThan(0); expect(new Set(byRef.map((r) => r.referrer_id))).toEqual(new Set([r0]));
    const byDept = await rowsOf('consultant', { filters: { department_id: [d0] } });
    expect(byDept.length).toBeGreaterThan(0); expect(new Set(byDept.map((r) => r.department_id))).toEqual(new Set([d0]));
  }, T);

  it('collection_boy: per collector collected cash (reversals netted) and applied collections; Σ rows = ledger register', async () => {
    const rows = await rowsOf('collection_boy');
    for (const c of A.spec.collectors) {
      const row = rows.find((r) => r.collector_id === c)!;
      expect(row, c).toBeDefined();
      const paid = sum(A.bills.filter((b) => b.collectorId === c && b.payId).map((b) => b.paid));
      const colls = A.collections.filter((x) => x.collector === c);
      expect(row).toMatchObject({ collected_paisa: paid, collections_count: colls.length });
      num(row.pickups_count); expect(typeof row.collector_name).toBe('string'); expect(row.collector_name.length).toBeGreaterThan(0);
      expect(row.last_activity_at === '' || !Number.isNaN(Date.parse(row.last_activity_at))).toBe(true);
    }
    const register = Number((await ownerSql(`SELECT coalesce(sum(amount_paisa),0)::bigint AS n FROM billing.ledger_entries WHERE tenant_id = $1 AND collected_by_membership_id = ANY($2::uuid[])
       AND business_date BETWEEN $3::date AND $4::date`, [TENANT_A, A.spec.collectors, FROM, TO]))[0].n);
    expect(sum(rows.map((r) => r.collected_paisa))).toBe(register);
    expect(rows.map((r) => r.collector_id).sort(), 'only tenant A collectors').toEqual([...A.spec.collectors].sort());
  }, T);

  it('collection_boy: a day range, and the collector filter', async () => {
    const day = A.collections[0]!.day;
    const rows = await rowsOf('collection_boy', { range: rangeOf(day, day) });
    expect(sum(rows.map((r) => r.collections_count))).toBe(A.collections.filter((x) => x.day === day).length);
    const one = await rowsOf('collection_boy', { filters: { collector_id: [A.spec.collectors[0]!] } });
    expect(one.map((r) => r.collector_id)).toEqual([A.spec.collectors[0]]);
  }, T);
});

// =============================================================================================== the rest of the catalogue
describe('repeated patient, repeated test, IPD and OPD, party billing', () => {
  it('repeated_patient: patients with at least min_repeat_count visits (default 2), most visits first; number only; dates and net billed right', async () => {
    const byP = group(A.bills, (b) => b.patientId);
    for (const min of [undefined, 3]) {
      const rows = await rowsOf('repeated_patient', min ? { filters: { min_repeat_count: min } } : {});
      const want = [...byP.entries()].filter(([, bs]) => bs.length >= (min ?? 2));
      expect(rows.map((r) => r.patient_id).sort()).toEqual(want.map(([id]) => id).sort());
      for (const r of rows) {
        const bs = byP.get(r.patient_id)!; const days = bs.map((b) => b.day).sort();
        expect(r).toMatchObject({ patient_number: bs[0]!.patientCode, visit_count: bs.length, first_visit_date: days[0], last_visit_date: days.at(-1), net_billed_paisa: sum(bs.map((b) => b.net)) });
      }
      expect(want.length, `fixture has repeat patients at min ${min ?? 2}`).toBeGreaterThan(0);
    }
  }, T);

  it('repeated_test: tests ordered >= min times by one patient: test count, patients, repeat patients', async () => {
    const rows = await rowsOf('repeated_test');
    const per = new Map<string, Map<string, number>>(); // test code -> patient -> times
    for (const b of A.bills) for (const l of b.lines) { const m = per.get(l.testCode) ?? new Map<string, number>(); m.set(b.patientId, (m.get(b.patientId) ?? 0) + 1); per.set(l.testCode, m); }
    const want = [...per.entries()].map(([code, m]) => ({ code, tests: sum([...m.values()]), patients: m.size, repeat: [...m.values()].filter((n) => n >= 2).length })).filter((x) => x.repeat > 0);
    expect(rows.map((r) => r.test_code).sort()).toEqual(want.map((x) => x.code).sort());
    for (const r of rows) { const w = want.find((x) => x.code === r.test_code)!; expect(r).toMatchObject({ test_count: w.tests, patients_count: w.patients, repeat_patients_count: w.repeat }); }
  }, T);

  it('ipd_opd: per (day, centre, patient type); Σ net = invoice register; visit_type and centre filters', async () => {
    const rows = await rowsOf('ipd_opd');
    const g = group(A.bills, (b) => `${b.day}|${b.centreId}|${b.visit}`);
    expect(rows).toHaveLength(g.size);
    for (const r of rows) {
      const bs = g.get(`${r.business_date}|${r.centre_id}|${r.visit_type}`)!;
      expect(bs, `${r.business_date}|${r.centre_id}|${r.visit_type}`).toBeDefined();
      expect(r).toMatchObject({ orders_registered: bs.length, tests_count: sum(bs.map((b) => b.lines.length)), gross_paisa: sum(bs.map((b) => b.gross)), net_paisa: sum(bs.map((b) => b.net)) });
    }
    const register = Number((await ownerSql(`SELECT coalesce(sum(net_paisa),0)::bigint AS n FROM billing.invoices WHERE tenant_id = $1 AND status = 'issued'`, [TENANT_A]))[0].n);
    expect(sum(rows.map((r) => r.net_paisa))).toBe(register);
    const ipd = await rowsOf('ipd_opd', { filters: { visit_type: 'ipd' } });
    expect(ipd.length).toBeGreaterThan(0); expect(new Set(ipd.map((r) => r.visit_type))).toEqual(new Set(['ipd']));
    expect(sum(ipd.map((r) => r.orders_registered))).toBe(A.bills.filter((b) => b.visit === 'ipd').length);
  }, T);

  it('party_billing: per credit party orders, gross, discount, net, paid, outstanding; Σ rows = the credit invoices of the register', async () => {
    const rows = await rowsOf('party_billing');
    const g = group(A.bills.filter((b) => b.partyId), (b) => b.partyId!);
    expect(rows.map((r) => r.party_id).sort()).toEqual([...g.keys()].sort());
    for (const r of rows) {
      const bs = g.get(r.party_id)!;
      expect(r).toMatchObject({ billing_mode: 'credit', orders_registered: bs.length, gross_paisa: sum(bs.map((b) => b.gross)), discount_paisa: sum(bs.map((b) => b.discount)),
        net_billed_paisa: sum(bs.map((b) => b.net)), paid_paisa: sum(bs.map((b) => b.paid)), outstanding_paisa: sum(bs.map((b) => b.net - b.paid)) });
    }
    const register = Number((await ownerSql(`SELECT coalesce(sum(net_paisa),0)::bigint AS n FROM billing.invoices WHERE tenant_id = $1 AND status = 'issued' AND credit_party_id IS NOT NULL`, [TENANT_A]))[0].n);
    expect(sum(rows.map((r) => r.net_billed_paisa))).toBe(register);
  }, T);

  it('outsource: runs and returns its contract columns (the outsourced work rule is not seeded in this fixture)', async () => {
    const r = await run('outsource');
    expect(r.columns).toEqual(expectedColumns('outsource'));
    for (const row of r.rows) { num(row.tests_sent); num(row.tests_resulted); }
  }, T);
});

// =============================================================================================== tenant isolation
describe('cross tenant isolation (done_when 5): no row of another tenant, with RLS and without it', () => {
  const idsOf = (w: World) => [...w.bills.flatMap((b) => [b.id, b.no, b.orderId, b.patientId, b.patientCode]), ...w.spec.parties, ...w.spec.referrers, ...w.spec.collectors, ...w.spec.centres.slice(1), ...(w.reps ? [w.reps.top, w.reps.sub] : [])];
  it.each(PLAIN_CODES)('%s: tenant A rows hold no id, number or patient code of tenant B (and the other way round); same rows with RLS bypassed', async (code) => {
    const aRls = await rowsOf(code, {}, A, 'rls'), aOwner = await rowsOf(code, {}, A, 'owner');
    expect(aOwner, 'explicit tenant predicate holds without RLS').toEqual(aRls);
    const blobA = JSON.stringify(aRls), bIds = idsOf(B);
    for (const id of bIds) expect(blobA.includes(id), `${code}: tenant B value ${id} in tenant A rows`).toBe(false);
    const bRls = await rowsOf(code, {}, B, 'rls'), bOwner = await rowsOf(code, {}, B, 'owner');
    expect(bOwner).toEqual(bRls);
    for (const id of idsOf(A)) expect(JSON.stringify(bRls).includes(id), `${code}: tenant A value ${id} in tenant B rows`).toBe(false);
  }, T);
  it('a tenant B bill is invisible to the day report of tenant A, and tenant A totals do not change when tenant B has data on the same days', async () => {
    const b = B.bills[0]!;
    const rows = await rowsOf('bill_of_the_day', { range: rangeOf(b.day, b.day) });
    expect(rows.map((r) => r.invoice_id)).not.toContain(b.id);
    expect(sum((await rowsOf('bill_of_the_day')).map((r) => r.net_paisa))).toBe(sum(A.bills.map((x) => x.net)));
  }, T);
  it('a centre filter naming a centre of the other tenant yields nothing', async () => {
    expect(await rowsOf('bill_of_the_day', { filters: { centre_id: [B.spec.centres[0]!] } })).toEqual([]);
    expect(await rowsOf('party_billing', { filters: { party_id: [B.spec.parties[0]!] } })).toEqual([]);
  }, T);
});

// =============================================================================================== no per row queries (done_when 2)
describe('query count per report does not grow with the rows', () => {
  it.each(PLAIN_CODES)('%s: the same number of statements for one day and for the month, at most 8; one statement per page of the cursor', async (code) => {
    const count = (a: Record<string, unknown>) => withCtx(A, 'rls', async ({ ctx, statements }) => { await (await misReports()).runMisReport(ctx, code, { range: rangeOf(FROM, TO), scope: ALL, limit: 1000, ...a }); return statements.length; });
    const month = await count({}), day = await count({ range: rangeOf(MID, MID) }), empty = await count({ range: rangeOf('2019-01-01', '2019-01-02') });
    expect(month, code).toBeLessThanOrEqual(8);
    expect([day, empty], code).toEqual([month, month]);
    if (code === 'bill_of_the_day') {
      const pages = await withCtx(A, 'rls', async ({ ctx, statements }) => { const rows = await allPages(ctx, code, { range: rangeOf(FROM, TO), scope: ALL }, 10); return { n: statements.length, pages: Math.ceil(rows.length / 10) }; });
      expect(pages.pages, 'fixture pages').toBeGreaterThan(5);
      expect(pages.n / pages.pages, 'statements per page stay constant: no per row query across pages').toBeLessThanOrEqual(8);
    }
  }, T);
});

// =============================================================================================== streaming source of the export
describe('streamMisReport feeds the export without materialising the result', () => {
  it('yields chunks of at most chunkRows, in report order, equal to the paged result; stops reading when the consumer stops', async () => {
    const whole = await rowsOf('bill_of_the_day');
    await withCtx(A, 'rls', async ({ ctx, statements }) => {
      const { streamMisReport } = await misReports(); const got: any[] = []; let chunks = 0;
      for await (const ch of streamMisReport(ctx, 'bill_of_the_day', { range: rangeOf(FROM, TO), scope: ALL, chunkRows: 10 })) { expect(ch.length).toBeLessThanOrEqual(10); expect(ch.length).toBeGreaterThan(0); got.push(...ch); chunks++; }
      expect(got).toEqual(whole); expect(chunks).toBe(Math.ceil(whole.length / 10));
      const full = statements.length; statements.length = 0;
      for await (const ch of streamMisReport(ctx, 'bill_of_the_day', { range: rangeOf(FROM, TO), scope: ALL, chunkRows: 10 })) { expect(ch.length).toBe(10); break; }
      expect(statements.length, 'one chunk read, not the whole result').toBeLessThan(full);
    });
  }, T);
  it('the date cap applies to a stream too: 367 days fails with the standard validation error before the first chunk (the row cap is proven on 20000 bills in perf.live.test.ts)', async () => {
    await withCtx(A, 'rls', async ({ ctx }) => {
      const { streamMisReport } = await misReports(); const e = await rejected((async () => { for await (const _ of streamMisReport(ctx, 'bill_of_the_day', { range: rangeOf('2020-01-01', '2021-01-01'), scope: ALL })) { /* never */ } })());
      std(e);
    });
  }, T);
  it('the contract row caps are 5000 / 2000 and every definition is readable (guards the numbers the perf test relies on)', () => {
    expect(def('bill_of_the_day').row_cap).toBe(5000);
    expect(DEFS.every((d) => d.row_cap >= 2000)).toBe(true);
  });
});
