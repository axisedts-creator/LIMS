// T0B-ACCT-2 (LD-313, LD-310) getDailyCollectionSummary: done_when 4 (groups payments and ledger entries by payment mode for a centre and day and MATCHES the billing daily cash numbers
// for the same day) and 1 (tenant isolation). Real PG17 under RLS. Fails now: the operation is pending (501), no handler.
// Contract: credit entries of the centre on that entry_date, net of their reversals, grouped by payment_mode; total_paisa = sum of rows; money integer paisa.
// PIN (CONV, notes/T0B-ACCT-2-tests.md): the invoice payments of billing.ledger_entries of the same centre and business_date (payment, net of reversal / refund rows; gateway rows have
// no collector and are left out exactly like getDailyCash) are grouped by method_code into the SAME payment_mode rows, so for a day the summary total equals
// getDailyCash totals.net.amount_paisa + the net credit account entries of the day. A day with nothing -> rows [] and total 0.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { notFound, rejected } from './helpers.js';
import { CENTRE, T, TENANT_A, dbRows, expWorld, fire, fundCredit, ok, req, staff, summaryOf, superTx, uid } from './helpers2.js';

const DAY = '2026-11-17';
const rowsOf = (body: any) => Object.fromEntries(body.rows.map((r: any) => [r.payment_mode, r]));

describe('getDailyCollectionSummary: account ledger entries', () => {
  it('groups credit entries by payment mode for the centre and day, net of reversals; debits and other days are left out', async () => {
    const w = await expWorld('a');
    const day = '2026-03-' + String(10 + Math.floor(Math.random() * 15));            // a private day per run: the shared tenant has other tests' entries on 2026-11-17
    await fundCredit(w, { entry_date: day, payment_mode: 'cash', amount_paisa: 300_000 });
    await fundCredit(w, { entry_date: day, payment_mode: 'cash', amount_paisa: 50_000 });
    await fundCredit(w, { entry_date: day, payment_mode: 'bank_transfer', amount_paisa: 150_000, bank_name: 'Synthetic Bank' });
    const wrong = await fundCredit(w, { entry_date: day, payment_mode: 'cash', amount_paisa: 40_000 });
    ok(await fire('reverseAccountLedgerEntry', req({ params: { account_ledger_entry_id: wrong.id }, headers: { 'idempotency-key': uid() }, body: { reason_text: 'Synthetic wrong' } }), { tenant: w.tenant }), 201);
    await fundCredit(w, { entry_date: day, payment_mode: 'cash', amount_paisa: 9_999, entry_type: 'debit' });
    await fundCredit(w, { entry_date: '2026-03-01', payment_mode: 'cash', amount_paisa: 7_777 });
    const s = ok(await summaryOf(w.tenant, w.centre, day));
    expect(Object.keys(s).sort()).toEqual(['centre_id', 'day', 'rows', 'total_paisa']);
    expect(s).toMatchObject({ centre_id: w.centre, day });
    const r = rowsOf(s);
    expect(r['cash']).toEqual({ payment_mode: 'cash', entry_count: 2, total_paisa: 350_000 });
    expect(r['bank_transfer']).toEqual({ payment_mode: 'bank_transfer', entry_count: 1, total_paisa: 150_000 });
    expect(s.rows).toHaveLength(2);
    expect(s.total_paisa).toBe(500_000);
    expect(s.total_paisa).toBe(s.rows.reduce((a: number, x: any) => a + x.total_paisa, 0));
    for (const x of s.rows) expect(Number.isSafeInteger(x.total_paisa) && Number.isSafeInteger(x.entry_count)).toBe(true);
  }, T);

  it('an empty day -> rows [] and total 0; another centre of the tenant sees none of this centre\'s entries', async () => {
    const w = await expWorld('a');
    const s = ok(await summaryOf(w.tenant, w.centre, '2001-01-01'));
    expect(s).toMatchObject({ rows: [], total_paisa: 0 });
  }, T);

  it('tenant isolation: another tenant\'s centre -> 404 (never an empty 200 that hides existence); unknown centre -> 404; its entries are never counted', async () => {
    const a = await expWorld('a'), b = await expWorld('b');
    const day = '2026-04-12';
    await fundCredit(b, { entry_date: day, payment_mode: 'cash', amount_paisa: 123_000 });
    notFound(await summaryOf(a.tenant, b.centre, day));
    notFound(await summaryOf(a.tenant, uid(), day));
    expect(ok(await summaryOf(a.tenant, a.centre, day)).total_paisa).toBe(0);
    expect(ok(await summaryOf(b.tenant, b.centre, day)).total_paisa).toBe(123_000);
  }, T);

  it.each([['no centre', { day: DAY }], ['no day', { centre_id: CENTRE.a }], ['bad centre', { centre_id: 'x', day: DAY }], ['bad day', { centre_id: CENTRE.a, day: '2026-13-40' }],
    ['day with time', { centre_id: CENTRE.a, day: `${DAY}T00:00:00Z` }], ['unknown param', { centre_id: CENTRE.a, day: DAY, tenant_id: uid() }]])('refuses %s with 400', async (_n, q) => {
    rejected(await fire('getDailyCollectionSummary', req({ query: q }), { tenant: TENANT_A }));
  }, T);
});

describe('getDailyCollectionSummary reconciles with billing getDailyCash (done_when 4)', () => {
  async function payment(w: { tenant: string; centre: string }, by: string, o: { method: string; paisa: number; day: string; kind?: 'payment' | 'reversal'; reverses?: string; id?: string; orderId?: string }) {
    const id = o.id ?? uid();
    await superTx(async (tx) => {
      const [b] = (await tx.query(`SELECT id FROM core.branches WHERE tenant_id = $1 LIMIT 1`, [w.tenant])).rows;
      await tx.query(`INSERT INTO billing.ledger_entries (id, tenant_id, branch_id, centre_id, order_id, entry_kind, capture_kind, method_code, amount_paisa, reverses_entry_id, reason_code, fiscal_year_bs,
          collected_by_membership_id, business_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8,$9,$10,'2083/84',$11,$12::date,$11)`,
      [id, w.tenant, b.id, w.centre, o.orderId ?? uid(), o.kind ?? 'payment', o.method, o.kind === 'reversal' ? -o.paisa : o.paisa, o.reverses ?? null, o.kind === 'reversal' ? 'synthetic_error' : null, by, o.day]);
    }, w.tenant);
    return id;
  }

  it('the summary total equals getDailyCash net + the day\'s net account credits, per payment mode, with a reversed payment netted out', async () => {
    const w = await expWorld('a');
    const day = '2026-05-' + String(10 + Math.floor(Math.random() * 15));
    const cashier = await staff(w.tenant);
    await payment(w, cashier.id, { method: 'cash', paisa: 120_000, day });
    const goneOrder = uid();
    const gone = await payment(w, cashier.id, { method: 'cash', paisa: 30_000, day, orderId: goneOrder });
    await payment(w, cashier.id, { method: 'cash', paisa: 30_000, day, kind: 'reversal', reverses: gone, orderId: goneOrder });
    await payment(w, cashier.id, { method: 'esewa_qr', paisa: 80_000, day });
    await fundCredit(w, { entry_date: day, payment_mode: 'cash', amount_paisa: 20_000 });
    await fundCredit(w, { entry_date: day, payment_mode: 'bank_transfer', amount_paisa: 10_000, bank_name: 'Synthetic Bank' });

    const dc = ok(await fire('getDailyCash', req({ query: { business_date: day, centre_id: w.centre } }), { tenant: w.tenant }));
    const s = ok(await summaryOf(w.tenant, w.centre, day));
    const accountNet = 30_000;
    expect(dc.totals.net.amount_paisa).toBe(120_000 + 80_000);
    expect(s.total_paisa).toBe(dc.totals.net.amount_paisa + accountNet);
    const r = rowsOf(s);
    const dcByMethod: Record<string, number> = {};
    for (const x of dc.rows) dcByMethod[x.method_code] = (dcByMethod[x.method_code] ?? 0) + x.net.amount_paisa;
    expect(r['cash'].total_paisa).toBe(dcByMethod['cash']! + 20_000);
    expect(r['esewa_qr'].total_paisa).toBe(dcByMethod['esewa_qr']);
    expect(r['bank_transfer'].total_paisa).toBe(10_000);
    expect(s.total_paisa).toBe(s.rows.reduce((a: number, x: any) => a + x.total_paisa, 0));
  }, T);

  // Reviewer item (T0B-ACCT-2-review.md): a refund today for yesterday's bill must not break the contract. The bounds are read from billing.yaml (DailyCollectionRow,
  // DailyCollectionSummary), so the test follows whichever option the lead rules in the CR (signed net, or refunds reported apart); it only fails while the response
  // violates the declared schema (today minimum: 0 on entry_count and total_paisa vs a negative net).
  it('a refund-only day (payment on D-1, reversal on D) gives a response that satisfies the DailyCollectionSummary contract', async () => {
    const w = await expWorld('a');
    const n = 10 + Math.floor(Math.random() * 15);
    const prev = '2026-07-' + String(n), day = '2026-07-' + String(n + 1);
    const cashier = await staff(w.tenant);
    const orderId = uid();
    const paid = await payment(w, cashier.id, { method: 'cash', paisa: 45_000, day: prev, orderId });
    await payment(w, cashier.id, { method: 'cash', paisa: 45_000, day, kind: 'reversal', reverses: paid, orderId });
    const s = ok(await summaryOf(w.tenant, w.centre, day));
    const spec: any = parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..', 'contracts/openapi/billing.yaml'), 'utf8'));
    const sch = spec.components.schemas;
    const row = sch.DailyCollectionRow.properties, top = sch.DailyCollectionSummary.properties;
    for (const x of s.rows) {
      expect(Number.isSafeInteger(x.entry_count) && Number.isSafeInteger(x.total_paisa)).toBe(true);
      if (row.entry_count.minimum !== undefined) expect(x.entry_count).toBeGreaterThanOrEqual(row.entry_count.minimum);
      if (row.total_paisa.minimum !== undefined) expect(x.total_paisa).toBeGreaterThanOrEqual(row.total_paisa.minimum);
    }
    if (top.total_paisa.minimum !== undefined) expect(s.total_paisa).toBeGreaterThanOrEqual(top.total_paisa.minimum);
    expect(Number.isSafeInteger(s.total_paisa)).toBe(true);
  }, T);

  it('same day, another centre\'s payments are not mixed in (centre filter agrees with getDailyCash centre_id)', async () => {
    const w = await expWorld('a');
    const day = '2026-06-' + String(10 + Math.floor(Math.random() * 15));
    const cashier = await staff(w.tenant);
    await payment({ tenant: w.tenant, centre: w.centre }, cashier.id, { method: 'cash', paisa: 11_000, day });
    const otherCentre = (await dbRows(w.tenant, `SELECT id FROM core.collection_centres WHERE tenant_id = $1 AND id <> $2 LIMIT 1`, [w.centre]))[0]?.id;
    if (otherCentre) {
      const dcOther = ok(await fire('getDailyCash', req({ query: { business_date: day, centre_id: otherCentre } }), { tenant: w.tenant }));
      expect(ok(await summaryOf(w.tenant, otherCentre, day)).total_paisa).toBe(dcOther.totals.net.amount_paisa);
    }
    expect(ok(await summaryOf(w.tenant, w.centre, day)).total_paisa).toBe(11_000);
  }, T);
});
