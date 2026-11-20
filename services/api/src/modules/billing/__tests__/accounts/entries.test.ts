// T0B-ACCT-1 (LD-313 b) ledger entries: createAccountLedgerEntry, getAccountLedgerEntry, listAccountLedgerEntries (done_when 4 receipt numbers, 5 validation, 6 audit + logs, 7 money types).
// Real PG17 under RLS. Fails now: the handlers do not exist.
// PINS the writer may dispute (each is the simplest reading of done_when; dispute in .orchestra/notes with a reason):
//  - receipt_no = 'ACC-' + 6 digit receipt_seq (contract example ACC-000001); the per tenant sequence is exactly 1..N over all committed entries, reversals included.
//  - amount ceiling: the contract maximum 9007199254740991 is refused (400 /amount_paisa); NPR 5,000,000.00 (500000000 paisa) is accepted. The configurable maximum's
//    name is the writer's to pick (no env name is pinned here; CR if the spec has none).
//  - entry_date: today (tenant timezone) + 1 day is accepted, + 2 days is 400; a calendar-invalid date is 400.
//  - bank fields: payment_mode 'cash' must not carry bank_name / reference_no / payment_details (400); 'bank_transfer' and 'cheque' require bank_name (400 without).
//  - unknown or other tenant centre / particular / party -> 404 common.not_found; inactive particular or inactive group -> 400 common.validation_failed.
//  - audit: a ledger write has no row trigger (migration header), so the service must write an audit.audit_log or audit.access_log row naming the entry id; it must hold none of the
//    free text (comments, bank_name, reference_no, payment_details).
import { describe, expect, it } from 'vitest';
import { T, TENANT_A, allSeqs, dbCount, dbEntries, entry, fire, moneyIsInteger, notFound, ok, post, rejected, req, seed, superTx, tag, uid, world } from './helpers.js';

const bad = (w: any, over: Record<string, unknown>) => post(w, over);

describe('createAccountLedgerEntry', () => {
  it('201 with the contract shape; status submitted, receipt_no ACC-nnnnnn, created_by = caller, money an integer', async () => {
    const w = await world('a');
    const e = ok(await post(w, { comments: 'Synthetic comment' }), 201);
    expect(e).toMatchObject({ centre_id: w.centre, party_kind: 'credit_party', party_id: w.partyId, entry_date: '2026-11-17', account_particular_id: w.particularId,
      entry_type: 'credit', amount_paisa: 150000, payment_mode: 'cash', status: 'submitted', comments: 'Synthetic comment' });
    expect(e.receipt_no).toMatch(/^ACC-\d{6,}$/);
    expect(e.reverses_entry_id).toBeUndefined();
    expect(moneyIsInteger(e)).toEqual([]);
    expect(typeof e.amount_paisa).toBe('number');
    const [row] = await dbEntries(TENANT_A, 'id = $2', [e.id]);
    expect(row.amount_paisa).toBe(String(150000));          // bigint column, never a float
    expect(e.receipt_no).toBe(`ACC-${String(row.receipt_seq).padStart(6, '0')}`);
    expect(e.created_by).toBe(row.created_by);
  }, T);

  it('amount: 0, negative, fractional, string, null, above the maximum, the contract maximum -> 400 /amount_paisa; a normal large amount is accepted', async () => {
    const w = await world('a');
    for (const amount_paisa of [0, -1, 1.5, '1000', null, 9007199254740991, 9007199254740992]) {
      const o = await bad(w, { amount_paisa });
      const err = rejected(o);
      expect(JSON.stringify(err.errors ?? [])).toContain('amount_paisa');
    }
    expect(ok(await post(w, { amount_paisa: 500_000_000 }), 201).amount_paisa).toBe(500_000_000);
    expect(ok(await post(w, { amount_paisa: 1 }), 201).amount_paisa).toBe(1);
  }, T);

  it('entry_date: today + 1 accepted, today + 2 refused, impossible / malformed dates refused, a past date accepted', async () => {
    const w = await world('a');
    ok(await post(w, { entry_date: '2026-11-18' }), 201);
    ok(await post(w, { entry_date: '2026-01-05' }), 201);
    for (const entry_date of ['2026-11-19', '2027-01-01', '2026-02-30', '17-11-2026', '2026-11-17T00:00:00Z', 20261117]) rejected(await bad(w, { entry_date }));
  }, T);

  it('entry_type / party_kind / payment_mode / free text shape: unknown values and over long text -> 400; reference_no and payment_details never hold a 13 digit run', async () => {
    const w = await world('a');
    for (const over of [{ entry_type: 'refund' }, { party_kind: 'patient' }, { payment_mode: 'Cash!' }, { payment_mode: '' }, { comments: '' }, { comments: 'x'.repeat(2001) },
      { reference_no: 'REF-4111111111111111' }, { payment_details: 'card 4111111111111111 held' }, { centre_id: 'nope' }, { status: 'approved' }, { receipt_no: 'ACC-999999' }, { tenant_id: uid() }, { reverses_entry_id: uid() }])
      rejected(await bad(w, over));
    expect(await dbCount(TENANT_A, "payment_details LIKE '%4111111111111111%' OR reference_no LIKE '%4111111111111111%'")).toBe(0);
  }, T);

  it('bank fields only when the payment mode needs them', async () => {
    const w = await world('a');
    for (const over of [{ bank_name: 'Synthetic Bank' }, { reference_no: 'SYN-1' }, { payment_details: 'Synthetic detail' }]) rejected(await bad(w, { payment_mode: 'cash', ...over }));
    for (const payment_mode of ['bank_transfer', 'cheque']) {
      rejected(await bad(w, { payment_mode }));
      const e = ok(await post(w, { payment_mode, bank_name: 'Synthetic Bank', reference_no: 'SYN-REF-1', payment_details: 'Synthetic detail' }), 201);
      expect(e).toMatchObject({ payment_mode, bank_name: 'Synthetic Bank', reference_no: 'SYN-REF-1', payment_details: 'Synthetic detail' });
    }
  }, T);

  it('references must exist in the tenant: unknown / tenant B centre, particular and party -> 404; nothing is stored', async () => {
    const a = await world('a'); const b = await world('b');
    const before = await dbCount(TENANT_A);
    for (const over of [{ centre_id: uid() }, { centre_id: b.centre }, { account_particular_id: uid() }, { account_particular_id: b.particularId }, { party_id: uid() }, { party_id: b.partyId },
      { party_kind: 'franchise', party_id: uid() }, { party_kind: 'user_pocket', party_id: uid() }, { party_kind: 'laboratory', party_id: uid() }])
      notFound(await bad(a, over));
    expect(await dbCount(TENANT_A)).toBe(before);
  }, T);

  it('inactive particular or inactive group -> 400 and nothing stored; active again -> accepted', async () => {
    const w = await world('a');
    const before = await dbCount(TENANT_A);
    await superTx(async (tx) => { await tx.query('UPDATE billing.account_particulars SET is_active = false WHERE id = $1', [w.particularId]); }, TENANT_A);
    rejected(await bad(w, {}));
    await superTx(async (tx) => { await tx.query('UPDATE billing.account_particulars SET is_active = true WHERE id = $1', [w.particularId]);
      await tx.query('UPDATE billing.account_groups SET is_active = false WHERE id = $1', [w.groupId]); }, TENANT_A);
    rejected(await bad(w, {}));
    expect(await dbCount(TENANT_A)).toBe(before);
    await superTx(async (tx) => { await tx.query('UPDATE billing.account_groups SET is_active = true WHERE id = $1', [w.groupId]); }, TENANT_A);
    ok(await post(w, {}), 201);
  }, T);

  it('the body never decides tenant, status, receipt number or creator; credit limit and blocked party are not enforced (contract text)', async () => {
    const w = await world('a', { limitPaisa: 100, locked: true });
    const e = ok(await post(w, { amount_paisa: 9_999_999 }), 201);       // far above the limit, party locked
    expect(e.status).toBe('submitted');
  }, T);

  it('every create writes an audit record naming the entry, with none of the free text; logs hold no free text either', async () => {
    const w = await world('a');
    const secrets = { comments: `Synthetic note ${tag()}`, bank_name: `Synthetic Bank ${tag()}`, reference_no: `REF-${tag()}`, payment_details: `Synthetic detail ${tag()}` };
    const o = await post(w, { payment_mode: 'bank_transfer', ...secrets });
    const e = ok(o, 201);
    const rows = await superTx(async (tx) => [
      ...(await tx.query(`SELECT to_jsonb(a) AS j FROM audit.audit_log a WHERE tenant_id = $1 AND table_name = 'account_ledger_entries' AND row_id = $2`, [TENANT_A, e.id])).rows,
      ...(await tx.query(`SELECT to_jsonb(a) AS j FROM audit.access_log a WHERE tenant_id = $1 AND entity_id = $2`, [TENANT_A, e.id])).rows,
    ], TENANT_A);
    expect(rows.length, 'no audit.audit_log / audit.access_log row for the new entry').toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(rows) + o.logs.join('\n');
    for (const v of Object.values(secrets)) expect(text).not.toContain(v);
    expect(o.writes.filter((s) => /^\s*(update|delete)/i.test(s) && /account_ledger_entries/i.test(s))).toEqual([]);
  }, T);

  it('a refused create stores nothing and does not consume a receipt number (gap free)', async () => {
    const w = await world('a');
    ok(await post(w, {}), 201);
    const before = await allSeqs(TENANT_A);
    rejected(await bad(w, { amount_paisa: 0 }));
    notFound(await bad(w, { account_particular_id: uid() }));
    const e = ok(await post(w, {}), 201);
    const after = await allSeqs(TENANT_A);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toEqual(after.map((_, i) => i + 1));      // exactly 1..N, no gap, no duplicate
    expect(Number(e.receipt_no.slice(4))).toBe(after[after.length - 1]);
  }, T);
});

describe('receipt numbers per tenant', () => {
  it('30 concurrent creates: every one 201, receipt_no unique, the tenant sequence is exactly 1..N afterwards', async () => {
    const w = await world('a');
    const outs = await Promise.all(Array.from({ length: 30 }, (_, i) => post(w, { amount_paisa: 100 + i })));
    const bodies = outs.map((o) => ok(o, 201));
    expect(new Set(bodies.map((b) => b.receipt_no)).size).toBe(30);
    const seqs = await allSeqs(TENANT_A);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  }, T);

  it('tenants count independently: tenant B has its own ACC-000001 and its own gap free sequence', async () => {
    const a = await world('a'); const b = await world('b');
    ok(await post(a, {}), 201);
    const eb = ok(await post(b, {}, { tenant: b.tenant }), 201);
    const seqsB = await allSeqs(b.tenant);
    expect(seqsB).toEqual(seqsB.map((_, i) => i + 1));
    expect(seqsB.length).toBeGreaterThanOrEqual(1);
    expect(eb.receipt_no).toMatch(/^ACC-\d{6,}$/);
    expect(await dbCount(b.tenant, 'receipt_no = $2', ['ACC-000001'])).toBe(1);
  }, T);
});

describe('getAccountLedgerEntry / listAccountLedgerEntries', () => {
  it('get returns the entry; unknown id and tenant B id are 404; malformed id is 400', async () => {
    const a = await world('a'); const b = await world('b');
    const e = await entry(a); const eb = ok(await post(b, {}, { tenant: b.tenant }), 201);
    expect(ok(await fire('getAccountLedgerEntry', req({ params: { account_ledger_entry_id: e.id } })))).toEqual(e);
    notFound(await fire('getAccountLedgerEntry', req({ params: { account_ledger_entry_id: uid() } })));
    notFound(await fire('getAccountLedgerEntry', req({ params: { account_ledger_entry_id: eb.id } })));
    rejected(await fire('getAccountLedgerEntry', req({ params: { account_ledger_entry_id: 'not-a-uuid' } })));
  }, T);

  it('list: filters (party, kind, type, particular, dates, status), every row money is an integer, tenant B never appears, cursor pages are complete and disjoint', async () => {
    const a = await world('a'); const b = await world('b');
    const made: any[] = [];
    for (const [t, d, amt] of [['credit', '2026-11-01', 1000], ['debit', '2026-11-02', 400], ['credit', '2026-11-03', 250], ['debit', '2026-11-04', 50], ['credit', '2026-11-05', 7]] as const)
      made.push(await entry(a, { entry_type: t, entry_date: d, amount_paisa: amt }));
    const eb = ok(await post(b, {}, { tenant: b.tenant }), 201);
    const q = (query: Record<string, unknown>) => fire('listAccountLedgerEntries', req({ query: { party_kind: 'credit_party', party_id: a.partyId, ...query } }));
    const all = ok(await q({ limit: 200 }));
    expect(all.data.map((e: any) => e.id).sort()).toEqual(made.map((e) => e.id).sort());
    expect(moneyIsInteger(all)).toEqual([]);
    expect(ok(await q({ entry_type: 'debit' })).data).toHaveLength(2);
    expect(ok(await q({ entry_date_from: '2026-11-02', entry_date_to: '2026-11-04' })).data).toHaveLength(3);
    expect(ok(await q({ account_particular_id: a.particularId })).data).toHaveLength(5);
    expect(ok(await q({ account_particular_id: uid() })).data).toHaveLength(0);
    expect(ok(await q({ status: 'reversed' })).data).toHaveLength(0);
    expect(ok(await fire('listAccountLedgerEntries', req({ query: { party_id: eb.party_id, limit: 200 } }))).data).toHaveLength(0);   // tenant B party through tenant A
    const seen: string[] = []; let cursor: string | undefined; let n = 0;
    do { const p = ok(await q({ limit: 2, ...(cursor ? { cursor } : {}) })); seen.push(...p.data.map((e: any) => e.id)); cursor = p.page.next_cursor; n++; } while (cursor && n < 20);
    expect(seen.sort()).toEqual(made.map((e) => e.id).sort());
    rejected(await q({ cursor: '!!!' }), 'common.invalid_cursor');
    rejected(await q({ limit: 201 }));
    rejected(await q({ entry_date_from: '2026-11-05', entry_date_to: '2026-11-01' }));
  }, T);
});
