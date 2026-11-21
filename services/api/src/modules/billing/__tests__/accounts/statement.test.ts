// T0B-ACCT-1 (LD-313, done_when 3 + 7) getAccountStatement and getAccountSummary: computed in SQL (opening balance = one query, rows = one query, no per row loop),
// running balance in exact integer paisa, credits + debits + balances reconcile. Real PG17 under RLS. Fails now: the handlers do not exist.
// PINS the writer may dispute: balance = credits - debits; side 'credit' when >= 0 is NOT pinned for zero, only the magnitude is; rows are ordered by entry_date then receipt number;
// a statement row's status is the derived status (reversed when a reversal exists); total_credit_paisa / total_debit_paisa sum the rows of the range (reversal rows included);
// summary.outstanding is over ALL entries of the party (no date), credit_limit_paisa / is_blocked come from billing.credit_accounts (limit, is_locked) for credit_party;
// more than 1000 rows in the range -> 400 common.validation_failed; unknown party (any kind) -> 404. Franchise / user_pocket / laboratory happy paths are NOT covered
// (their party tables are not pinned by the contract): only their 404 is.
import { describe, expect, it } from 'vitest';
import { T, TENANT_A, entry, fire, moneyIsInteger, notFound, ok, post, prng, rejected, req, reverse, sideSigned, signed, statement, summary, superTx, uid, world } from './helpers.js';

const ledgerSelects = (stmts: string[]) => stmts.filter((s) => /account_ledger_entries/i.test(s) && /^\s*(with|select)\b/i.test(s));

describe('statement: 200 random entries reconcile exactly (done_when 3)', () => {
  it('rows, running balance, opening, closing and totals equal an independent integer computation; sum of rows = closing - opening', async () => {
    const SEED = 20261117; const rnd = prng(SEED);
    const w = await world('a');
    const made: Array<{ id: string; date: string; type: string; amount: number; receipt: string; reverses?: string }> = [];
    const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10);       // 2026-10-01 .. 2026-11-17
    for (let i = 0; i < 200; i++) {
      const type = rnd() < 0.5 ? 'credit' : 'debit';
      const amount = 1 + Math.floor(rnd() * 2_000_000);
      const e = ok(await post(w, { entry_type: type, amount_paisa: amount, entry_date: day(Math.floor(rnd() * 48)) }), 201);
      made.push({ id: e.id, date: e.entry_date, type, amount, receipt: e.receipt_no });
    }
    for (const orig of made.slice(0, 200).filter(() => rnd() < 0.08)) {                              // ~16 reversals mixed in
      const r = ok(await reverse(w, orig.id), 201);
      made.push({ id: r.id, date: r.entry_date, type: r.entry_type, amount: r.amount_paisa, receipt: r.receipt_no, reverses: orig.id });
    }
    const from = '2026-10-15', to = '2026-11-05';
    const order = (a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : Number(a.receipt.slice(4)) - Number(b.receipt.slice(4)));
    const opening = made.filter((e) => e.date < from).reduce((s, e) => s + signed(e.type, e.amount), 0);
    const inRange = made.filter((e) => e.date >= from && e.date <= to).sort(order);
    expect(inRange.length, `seed ${SEED}`).toBeGreaterThan(20);

    const o = await statement(w, from, to);
    const s = ok(o);
    expect(moneyIsInteger(s)).toEqual([]);
    expect(s).toMatchObject({ party_kind: 'credit_party', party_id: w.partyId, from, to });
    expect(sideSigned(s.opening_balance_paisa, s.opening_balance_side), `opening, seed ${SEED}`).toBe(opening);
    expect(s.rows.map((r: any) => r.entry_id), `row order, seed ${SEED}`).toEqual(inRange.map((e) => e.id));
    let run = opening, tc = 0, td = 0;
    s.rows.forEach((r: any, i: number) => {
      const e = inRange[i]!;
      run += signed(e.type, e.amount);
      expect(r).toMatchObject({ entry_date: e.date, receipt_no: e.receipt, entry_type: e.type, credit_paisa: e.type === 'credit' ? e.amount : 0, debit_paisa: e.type === 'debit' ? e.amount : 0 });
      expect(sideSigned(r.balance_paisa, r.balance_side), `running balance of row ${i}, seed ${SEED}`).toBe(run);
      tc += r.credit_paisa; td += r.debit_paisa;
    });
    expect(sideSigned(s.closing_balance_paisa, s.closing_balance_side), `closing, seed ${SEED}`).toBe(run);
    expect(s.total_credit_paisa).toBe(tc); expect(s.total_debit_paisa).toBe(td);
    // the reconciliation the task asks for: sum of rows = closing - opening
    expect(s.total_credit_paisa - s.total_debit_paisa).toBe(sideSigned(s.closing_balance_paisa, s.closing_balance_side) - sideSigned(s.opening_balance_paisa, s.opening_balance_side));
    // and against the database itself, not only against the test's own list
    const dbSum = await superTx(async (tx) => Number((await tx.query(
      `SELECT COALESCE(SUM(CASE entry_type WHEN 'credit' THEN amount_paisa ELSE -amount_paisa END), 0)::text AS s FROM billing.account_ledger_entries
        WHERE tenant_id = $1 AND party_id = $2 AND entry_date BETWEEN $3 AND $4`, [TENANT_A, w.partyId, from, to])).rows[0].s), TENANT_A);
    expect(dbSum).toBe(tc - td);
    // computed in SQL: at most one query for the opening balance + one for the rows, whatever the row count (no per row loop)
    expect(ledgerSelects(o.stmts).length, o.stmts.join('\n')).toBeLessThanOrEqual(2);

    // whole life: opening 0, closing = every entry, and the summary agrees with it
    const all = ok(await statement(w, '2026-01-01', '2026-11-18'));
    const total = made.reduce((a, e) => a + signed(e.type, e.amount), 0);
    expect(all.opening_balance_paisa).toBe(0);
    expect(all.rows).toHaveLength(made.length);
    expect(sideSigned(all.closing_balance_paisa, all.closing_balance_side)).toBe(total);
    const sm = await summary(w);
    expect(sideSigned(ok(sm).outstanding_paisa, ok(sm).outstanding_side)).toBe(total);
    expect(ledgerSelects(sm.stmts).length).toBeLessThanOrEqual(1);
  }, T);
});

describe('statement details', () => {
  it('empty range keeps opening = closing; an empty party is all zero; opening excludes the from day itself', async () => {
    const w = await world('a');
    await entry(w, { entry_type: 'credit', amount_paisa: 700, entry_date: '2026-11-01' });
    await entry(w, { entry_type: 'debit', amount_paisa: 200, entry_date: '2026-11-10' });
    const s = ok(await statement(w, '2026-11-05', '2026-11-06'));
    expect(s.rows).toEqual([]);
    expect(s).toMatchObject({ opening_balance_paisa: 700, opening_balance_side: 'credit', closing_balance_paisa: 700, closing_balance_side: 'credit', total_credit_paisa: 0, total_debit_paisa: 0 });
    const d = ok(await statement(w, '2026-11-10', '2026-11-10'));
    expect(d).toMatchObject({ opening_balance_paisa: 700, closing_balance_paisa: 500, closing_balance_side: 'credit', total_debit_paisa: 200 });
    const empty = ok(await statement(await world('a'), '2026-11-01', '2026-11-30'));
    expect(empty).toMatchObject({ opening_balance_paisa: 0, closing_balance_paisa: 0, total_credit_paisa: 0, total_debit_paisa: 0, rows: [] });
  }, T);

  it('a debit larger than the credits shows side debit with the exact magnitude (contract example 50000 debit)', async () => {
    const w = await world('a');
    await entry(w, { entry_type: 'credit', amount_paisa: 200_000, entry_date: '2026-11-05' });
    await entry(w, { entry_type: 'debit', amount_paisa: 250_000, entry_date: '2026-11-12' });
    const s = ok(await statement(w, '2026-11-01', '2026-11-17'));
    expect(s.rows.map((r: any) => [r.balance_paisa, r.balance_side])).toEqual([[200_000, 'credit'], [50_000, 'debit']]);
    expect(s).toMatchObject({ closing_balance_paisa: 50_000, closing_balance_side: 'debit', total_credit_paisa: 200_000, total_debit_paisa: 250_000 });
  }, T);

  it('exact integer arithmetic on large amounts (no float rounding, no string concatenation: bigint sums come back as numbers)', async () => {
    const w = await world('a');
    const big = 500_000_000;                                           // the largest single amount the service accepts (see entries.test.ts)
    for (let i = 0; i < 3; i++) await entry(w, { entry_type: 'credit', amount_paisa: big - i, entry_date: '2026-11-01' });
    await entry(w, { entry_type: 'debit', amount_paisa: 3, entry_date: '2026-11-02' });
    const s = ok(await statement(w, '2026-11-01', '2026-11-30'));
    expect(s.closing_balance_paisa).toBe(3 * big - 3 - 3);
    expect(Number.isSafeInteger(s.closing_balance_paisa)).toBe(true);
    expect(moneyIsInteger(s)).toEqual([]);
  }, T);

  it('validation: from after to, missing or malformed params, unknown party kind -> 400; unknown party of every kind -> 404', async () => {
    const w = await world('a');
    for (const query of [{ from: '2026-11-10', to: '2026-11-01' }, { from: '2026-02-30' }, { to: 'tomorrow' }, { party_kind: 'patient' }, { party_id: 'x' }])
      rejected(await statement(w, '2026-11-01', '2026-11-30', query));
    for (const q of [{ party_id: undefined }, { from: undefined }, { to: undefined }, { party_kind: undefined }]) {
      const query: Record<string, unknown> = { party_kind: 'credit_party', party_id: w.partyId, from: '2026-11-01', to: '2026-11-30', ...q };
      for (const k of Object.keys(query)) if (query[k] === undefined) delete query[k];
      rejected(await fire('getAccountStatement', req({ query })));
    }
    for (const party_kind of ['credit_party', 'franchise', 'user_pocket', 'laboratory']) {
      notFound(await statement(w, '2026-11-01', '2026-11-30', { party_kind, party_id: uid() }));
      notFound(await summary(w, { party_kind, party_id: uid() }));
    }
  }, T);

  it('more than 1000 rows in the range -> 400 (narrow the range) and a narrowed range is served', async () => {
    const w = await world('a');
    for (let i = 0; i < 1001; i += 25) await Promise.all(Array.from({ length: Math.min(25, 1001 - i) }, () => post(w, { amount_paisa: 5, entry_date: '2026-11-03' }).then((o) => ok(o, 201))));
    rejected(await statement(w, '2026-11-01', '2026-11-30'));
    expect(ok(await statement(w, '2026-11-04', '2026-11-30')).rows).toEqual([]);                    // narrowed: the 1001 rows are outside
    await entry(w, { amount_paisa: 5, entry_date: '2026-11-09' });
    expect(ok(await statement(w, '2026-11-09', '2026-11-09')).rows).toHaveLength(1);
  }, T);

  it('tenant isolation: tenant A cannot read tenant B party statement or summary (404), and B entries never enter A figures', async () => {
    const a = await world('a'); const b = await world('b');
    await entry(a, { amount_paisa: 111 });
    ok(await post(b, { amount_paisa: 999_999 }, { tenant: b.tenant }), 201);
    notFound(await fire('getAccountStatement', req({ query: { party_kind: 'credit_party', party_id: b.partyId, from: '2026-11-01', to: '2026-11-30' } })));
    notFound(await fire('getAccountSummary', req({ query: { party_kind: 'credit_party', party_id: b.partyId } })));
    expect(ok(await summary(a)).outstanding_paisa).toBe(111);
  }, T);
});

describe('getAccountSummary', () => {
  it('credit limit, outstanding with its side, blocked flag from the credit account; held in integers', async () => {
    const w = await world('a', { limitPaisa: 7_500_000, locked: false });
    await entry(w, { entry_type: 'credit', amount_paisa: 150_000 });
    await entry(w, { entry_type: 'debit', amount_paisa: 250_000 });
    const sm = ok(await summary(w));
    expect(sm).toEqual({ party_kind: 'credit_party', party_id: w.partyId, credit_limit_paisa: 7_500_000, outstanding_paisa: 100_000, outstanding_side: 'debit', is_blocked: false });
    const locked = await world('a', { limitPaisa: 1_000, locked: true });
    expect(ok(await summary(locked))).toMatchObject({ credit_limit_paisa: 1_000, is_blocked: true, outstanding_paisa: 0 });
    expect(moneyIsInteger(sm)).toEqual([]);
  }, T);

  it('a reversed pair nets to zero outstanding', async () => {
    const w = await world('a');
    const e = await entry(w, { amount_paisa: 42_000 });
    ok(await reverse(w, e.id), 201);
    expect(ok(await summary(w)).outstanding_paisa).toBe(0);
  }, T);
});
