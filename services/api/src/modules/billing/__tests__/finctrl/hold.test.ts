// T0B-FINCTRL-1 (LD-321, LD-310) done_when (4) HOLD AND RELEASE + (7) audit / no free text in logs + (8) isolation and concurrency.
// Contract (billing.yaml holdLedgerEntry / releaseLedgerEntry, T0C-FINCTRL-1): hold = submitted -> held, release = held -> submitted, a `reason` (1..500) on both, anything else -> 409
// common.immutable_record; held entries are NOT posted: statement rows, running balance, closing balance, account summary and daily collection posted totals leave them out until release.
// Real PG17 under RLS. Fails now: both operations are pending (no handler).
// BRIEF vs CONTRACT (flagged in the notes, not asserted either way): the brief says "hold from submitted or approved, release returns the earlier status"; the contract and the DB guard
// only allow submitted <-> held and no API call creates an approved account entry, so `approved` is not tested. "Held total": the contract has NO field for it (AccountStatement /
// AccountSummary / DailyCollectionSummary are additionalProperties:false) -> the held entries are asserted through listAccountLedgerEntries?status=held (CR needed for a total field).
// PIN (CONV): one audit record per hold and per release naming the entry (audit.audit_log row or audit.access_log row; the closed access action set has no hold / release name yet).
import { describe, expect, it } from 'vitest';
import { entry, fire, moneyIsInteger, notFound, post, prng, rejected, req, reverse, sideSigned, signed, statement, summary } from '../accounts/helpers.js';
import { fundCredit, summaryOf } from '../accounts/helpers2.js';
import { T, auditCount, dbEntry, dbRows, hold, listEntries, ok, release, tag, uid, world } from './kit.js';

const REASON = 'Synthetic cheque not cleared by the bank';
const net = (s: any) => sideSigned(s.closing_balance_paisa, s.closing_balance_side);

describe('holdLedgerEntry', () => {
  it('submitted -> held: 200, status held, reason, holder and time recorded, amount / party / date / type untouched, ONE audit record, one UPDATE and nothing else', async () => {
    const w = await world('a');
    const e = await entry(w, { amount_paisa: 77_000 });
    const before = await auditCount(w.tenant, 'account_ledger_entries', e.id);
    const o = await hold(w.tenant, e.id, { reason: REASON });
    const h = ok(o);
    expect(h).toMatchObject({ id: e.id, status: 'held', held_reason: REASON, held_by: e.created_by, amount_paisa: 77_000, entry_type: e.entry_type, entry_date: e.entry_date, party_id: w.partyId, receipt_no: e.receipt_no });
    expect(typeof h.held_at).toBe('string');
    expect(h).not.toHaveProperty('released_by');
    expect(moneyIsInteger(h)).toEqual([]);
    const row = await dbEntry(w.tenant, e.id);
    expect(row).toMatchObject({ status: 'held', held_reason: REASON, released_by: null, released_at: null });
    expect(Number(row.amount_paisa)).toBe(77_000);
    expect(await auditCount(w.tenant, 'account_ledger_entries', e.id)).toBe(before + 1);
    expect(o.writes.filter((s) => /^\s*(delete|truncate)/i.test(s) || (/^\s*insert/i.test(s) && /account_ledger_entries/i.test(s)))).toEqual([]);
    expect(o.logs.join('\n')).not.toContain(REASON);
    const audit = JSON.stringify([...(await dbRows(w.tenant, `SELECT to_jsonb(a) AS j FROM audit.access_log a WHERE tenant_id = $1 AND entity_id = $2`, [e.id])), ...(await dbRows(w.tenant, `SELECT to_jsonb(a) AS j FROM audit.audit_log a WHERE tenant_id = $1 AND row_id = $2`, [e.id]))]);
    expect(audit, 'the free text reason must not land in the audit record').not.toContain(REASON);
  }, T);

  it.each<[string, unknown, string]>([
    ['no reason', {}, '/reason'], ['an empty reason', { reason: '' }, '/reason'], ['a blank reason', { reason: '   ' }, '/reason'], ['a 501 character reason', { reason: 'x'.repeat(501) }, '/reason'],
    ['a reason that is not text', { reason: 5 }, '/reason'], ['an unknown field', { reason: REASON, status: 'approved' }, '/status'],
  ])('refuses %s with 400 and the path; the entry stays submitted', async (_n, body, path) => {
    const w = await world('a');
    const e = await entry(w);
    const err = rejected(await hold(w.tenant, e.id, body));
    expect((err.errors ?? []).map((x: any) => x.path), JSON.stringify(err.errors)).toContain(path);
    expect((await dbEntry(w.tenant, e.id)).status).toBe('submitted');
  }, T);

  it('only a submitted entry: a held one and a reversed one -> 409 common.immutable_record, unchanged', async () => {
    const w = await world('a');
    const held = await entry(w);
    ok(await hold(w.tenant, held.id));
    rejected(await hold(w.tenant, held.id), 'common.immutable_record');
    const orig = await entry(w);
    ok(await reverse(w, orig.id), 201);
    rejected(await hold(w.tenant, orig.id), 'common.immutable_record');
    expect((await dbEntry(w.tenant, held.id)).status).toBe('held');
    expect((await dbEntry(w.tenant, orig.id)).status).not.toBe('held');
  }, T);

  it('an unknown id and another tenant\'s entry -> 404; nothing changes in the owner tenant', async () => {
    const a = await world('a'), b = await world('b');
    const e = await entry(a);
    notFound(await hold(a.tenant, uid()));
    notFound(await hold(b.tenant, e.id));
    notFound(await fire('releaseLedgerEntry', req({ params: { account_ledger_entry_id: e.id }, headers: { 'idempotency-key': uid() }, body: { reason: REASON } }), { tenant: b.tenant }));
    expect((await dbEntry(a.tenant, e.id)).status).toBe('submitted');
  }, T);

  it('two simultaneous holds of one entry: exactly one 200, the other immutable_record, ONE audit record added', async () => {
    const w = await world('a');
    const e = await entry(w);
    const before = await auditCount(w.tenant, 'account_ledger_entries', e.id);
    const outs = await Promise.all([hold(w.tenant, e.id, { reason: 'Synthetic racer one' }), hold(w.tenant, e.id, { reason: 'Synthetic racer two' })]);
    expect(outs.filter((o) => o.reply?.status === 200)).toHaveLength(1);
    rejected(outs.find((o) => o.reply === undefined)!, 'common.immutable_record');
    expect(await auditCount(w.tenant, 'account_ledger_entries', e.id)).toBe(before + 1);
  }, T);
});

describe('releaseLedgerEntry', () => {
  it('held -> submitted again (the earlier status): release holder and time recorded, hold history kept, ONE audit record; hold -> release -> hold works', async () => {
    const w = await world('a');
    const e = await entry(w, { amount_paisa: 12_345 });
    ok(await hold(w.tenant, e.id, { reason: 'Synthetic first hold' }));
    const before = await auditCount(w.tenant, 'account_ledger_entries', e.id);
    const o = await release(w.tenant, e.id, { reason: 'Synthetic cheque cleared' });
    const r = ok(o);
    expect(r).toMatchObject({ id: e.id, status: 'submitted', amount_paisa: 12_345, held_reason: 'Synthetic first hold', released_by: e.created_by });
    expect(typeof r.released_at).toBe('string');
    expect(await auditCount(w.tenant, 'account_ledger_entries', e.id)).toBe(before + 1);
    expect(o.logs.join('\n')).not.toContain('Synthetic cheque cleared');
    const again = ok(await hold(w.tenant, e.id, { reason: 'Synthetic second hold' }));
    expect(again).toMatchObject({ status: 'held', held_reason: 'Synthetic second hold' });
    expect(again).not.toHaveProperty('released_by');
    expect(ok(await release(w.tenant, e.id, { reason: 'Synthetic second release' })).status).toBe('submitted');
  }, T);

  it('a reason is required; an entry that is not held (never held, or already released) -> 409 immutable_record; unknown -> 404', async () => {
    const w = await world('a');
    const e = await entry(w);
    rejected(await release(w.tenant, e.id, { reason: REASON }), 'common.immutable_record');
    ok(await hold(w.tenant, e.id));
    for (const body of [{}, { reason: '' }, { reason: '  ' }, { reason: 'y'.repeat(501) }]) rejected(await release(w.tenant, e.id, body));
    expect((await dbEntry(w.tenant, e.id)).status).toBe('held');
    ok(await release(w.tenant, e.id, { reason: REASON }));
    rejected(await release(w.tenant, e.id, { reason: REASON }), 'common.immutable_record');
    notFound(await release(w.tenant, uid(), { reason: REASON }));
  }, T);

  it('two simultaneous releases: exactly one 200', async () => {
    const w = await world('a');
    const e = await entry(w);
    ok(await hold(w.tenant, e.id));
    const outs = await Promise.all([release(w.tenant, e.id, { reason: 'Synthetic one' }), release(w.tenant, e.id, { reason: 'Synthetic two' })]);
    expect(outs.filter((o) => o.reply?.status === 200)).toHaveLength(1);
    rejected(outs.find((o) => o.reply === undefined)!, 'common.immutable_record');
  }, T);
});

describe('held entries are not posted: statement, running balance, summary, daily collection', () => {
  it('statement rows, closing balance and account summary leave the held entry out; they come back on release', async () => {
    const w = await world('a');
    const a = await entry(w, { entry_type: 'credit', amount_paisa: 100_000, entry_date: '2026-11-01' });
    const b = await entry(w, { entry_type: 'credit', amount_paisa: 40_000, entry_date: '2026-11-02' });
    await entry(w, { entry_type: 'debit', amount_paisa: 10_000, entry_date: '2026-11-03' });
    ok(await hold(w.tenant, b.id));
    const s = ok(await statement(w, '2026-11-01', '2026-11-30'));
    expect(s.rows.map((r: any) => r.entry_id)).not.toContain(b.id);
    expect(s.rows).toHaveLength(2);
    expect(net(s)).toBe(100_000 - 10_000);
    expect(s.total_credit_paisa).toBe(100_000);
    expect(s.rows.map((r: any) => sideSigned(r.balance_paisa, r.balance_side))).toEqual([100_000, 90_000]);
    expect(sideSigned(ok(await summary(w)).outstanding_paisa, ok(await summary(w)).outstanding_side)).toBe(90_000);
    // a hold in front of the range moves the opening balance, never the rows
    ok(await hold(w.tenant, a.id));
    const late = ok(await statement(w, '2026-11-03', '2026-11-30'));
    expect(sideSigned(late.opening_balance_paisa, late.opening_balance_side)).toBe(0);
    ok(await release(w.tenant, a.id, { reason: REASON })); ok(await release(w.tenant, b.id, { reason: REASON }));
    const back = ok(await statement(w, '2026-11-01', '2026-11-30'));
    expect(back.rows).toHaveLength(3);
    expect(net(back)).toBe(130_000);
    expect(ok(await summary(w)).outstanding_paisa).toBe(130_000);
  }, T);

  it('held entries are listed apart: listAccountLedgerEntries status=held returns exactly them (held fields shown), and a released one leaves that list', async () => {
    const w = await world('a');
    const keep = await entry(w), gone = await entry(w);
    ok(await hold(w.tenant, keep.id, { reason: 'Synthetic kept on hold' }));
    ok(await hold(w.tenant, gone.id)); ok(await release(w.tenant, gone.id, { reason: REASON }));
    const held = ok(await listEntries(w.tenant, { party_kind: 'credit_party', party_id: w.partyId, status: 'held' }));
    expect(held.data.map((x: any) => x.id)).toEqual([keep.id]);
    expect(held.data[0]).toMatchObject({ status: 'held', held_reason: 'Synthetic kept on hold' });
    expect(ok(await listEntries(w.tenant, { party_kind: 'credit_party', party_id: w.partyId, status: 'submitted' })).data.map((x: any) => x.id)).toEqual([gone.id]);
  }, T);

  it('daily collection posted totals exclude a held credit entry and include it again after release (per payment mode, total = sum of rows)', async () => {
    const w = await world('a');
    const day = '2026-02-' + String(10 + Math.floor(Math.random() * 15));
    const cashA = await fundCredit(w, { entry_date: day, payment_mode: 'cash', amount_paisa: 300_000 });
    await fundCredit(w, { entry_date: day, payment_mode: 'cash', amount_paisa: 50_000 });
    const bank = await fundCredit(w, { entry_date: day, payment_mode: 'bank_transfer', amount_paisa: 150_000, bank_name: 'Synthetic Bank' });
    const rowsOf = (b: any) => Object.fromEntries(b.rows.map((r: any) => [r.payment_mode, r]));
    ok(await hold(w.tenant, cashA.id)); ok(await hold(w.tenant, bank.id));
    const s = ok(await summaryOf(w.tenant, w.centre, day));
    expect(rowsOf(s)['cash']).toEqual({ payment_mode: 'cash', entry_count: 1, total_paisa: 50_000 });
    expect(rowsOf(s)['bank_transfer']).toBeUndefined();
    expect(s.total_paisa).toBe(50_000);
    ok(await release(w.tenant, cashA.id, { reason: REASON })); ok(await release(w.tenant, bank.id, { reason: REASON }));
    const back = ok(await summaryOf(w.tenant, w.centre, day));
    expect(back.total_paisa).toBe(500_000);
    expect(back.total_paisa).toBe(back.rows.reduce((a: number, r: any) => a + r.total_paisa, 0));
  }, T);

  it('200 random entries, some held: sum of the statement rows = closing - opening, every running balance is exact, and the held ones appear nowhere in them', async () => {
    const SEED = 20261118; const rnd = prng(SEED);
    const w = await world('a');
    const made: Array<{ id: string; date: string; type: string; amount: number; receipt: string; held: boolean }> = [];
    const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10);
    for (let i = 0; i < 200; i++) {
      const type = rnd() < 0.5 ? 'credit' : 'debit';
      const amount = 1 + Math.floor(rnd() * 2_000_000);
      const e = ok(await post(w, { entry_type: type, amount_paisa: amount, entry_date: day(Math.floor(rnd() * 48)) }), 201);
      made.push({ id: e.id, date: e.entry_date, type, amount, receipt: e.receipt_no, held: false });
    }
    for (const m of made) if (rnd() < 0.3) { ok(await hold(w.tenant, m.id, { reason: `Synthetic hold ${tag()}` })); m.held = true; }
    for (const m of made.filter((x) => !x.held && rnd() < 0.05)) {                       // a few reversals of posted entries; a reversal row is posted too
      const r = ok(await reverse(w, m.id), 201);
      made.push({ id: r.id, date: r.entry_date, type: r.entry_type, amount: r.amount_paisa, receipt: r.receipt_no, held: false });
    }
    const heldCount = made.filter((m) => m.held).length;
    expect(heldCount, `seed ${SEED}`).toBeGreaterThan(20);
    const posted = made.filter((m) => !m.held);
    const from = '2026-10-15', to = '2026-11-05';
    const order = (a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : Number(a.receipt.slice(4)) - Number(b.receipt.slice(4)));
    const opening = posted.filter((e) => e.date < from).reduce((s, e) => s + signed(e.type, e.amount), 0);
    const inRange = posted.filter((e) => e.date >= from && e.date <= to).sort(order);

    const s = ok(await statement(w, from, to));
    expect(moneyIsInteger(s)).toEqual([]);
    expect(s.rows.map((r: any) => r.entry_id), `rows, seed ${SEED}`).toEqual(inRange.map((e) => e.id));
    let run = opening, tc = 0, td = 0;
    s.rows.forEach((r: any, i: number) => { run += signed(inRange[i]!.type, inRange[i]!.amount); expect(sideSigned(r.balance_paisa, r.balance_side), `running balance ${i}, seed ${SEED}`).toBe(run); tc += r.credit_paisa; td += r.debit_paisa; });
    expect(sideSigned(s.opening_balance_paisa, s.opening_balance_side), `opening, seed ${SEED}`).toBe(opening);
    expect(net(s), `closing, seed ${SEED}`).toBe(run);
    // the reconciliation of the brief: the sum of the rows equals closing minus opening
    expect(tc - td).toBe(net(s) - sideSigned(s.opening_balance_paisa, s.opening_balance_side));
    expect(s.total_credit_paisa - s.total_debit_paisa).toBe(tc - td);
    // against the database, not only against the test's own list: posted = every status except held
    const dbSum = Number((await dbRows(w.tenant, `SELECT COALESCE(SUM(CASE entry_type WHEN 'credit' THEN amount_paisa ELSE -amount_paisa END), 0)::text AS s FROM billing.account_ledger_entries
       WHERE tenant_id = $1 AND party_id = $2 AND status <> 'held' AND entry_date BETWEEN $3 AND $4`, [w.partyId, from, to]))[0].s);
    expect(dbSum).toBe(tc - td);
    // whole life + summary agree; held entries are listed apart and counted exactly
    const all = ok(await statement(w, '2026-01-01', '2026-11-18'));
    const total = posted.reduce((a, e) => a + signed(e.type, e.amount), 0);
    expect(all.rows).toHaveLength(posted.length);
    expect(net(all)).toBe(total);
    const sm = ok(await summary(w));
    expect(sideSigned(sm.outstanding_paisa, sm.outstanding_side)).toBe(total);
    const heldIds: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 30; i++) {
      const p = ok(await listEntries(w.tenant, { party_kind: 'credit_party', party_id: w.partyId, status: 'held', limit: '100', ...(cursor ? { cursor } : {}) }));
      heldIds.push(...p.data.map((x: any) => x.id)); cursor = p.page.next_cursor; if (!cursor) break;
    }
    expect(heldIds.sort(), `held list, seed ${SEED}`).toEqual(made.filter((m) => m.held).map((m) => m.id).sort());
  }, 600_000);
});

describe('tenant isolation of held figures', () => {
  it('a held entry of tenant A changes nothing in tenant B figures and B cannot see it in its held list', async () => {
    const a = await world('a'), b = await world('b');
    const ea = await entry(a, { amount_paisa: 5_000 });
    ok(await post(b, { amount_paisa: 9_000 }, { tenant: b.tenant }), 201);
    ok(await hold(a.tenant, ea.id));
    expect(ok(await summary(b)).outstanding_paisa).toBe(9_000);
    expect(JSON.stringify(ok(await listEntries(b.tenant, { status: 'held' })))).not.toContain(ea.id);
  }, T);
});
