// T0B-ACCT-1 (LD-313 b, done_when 2) reverseAccountLedgerEntry: append only; a correction is a NEW opposite entry linked by reverses_entry_id, once per entry, atomically.
// Real PG17 under RLS. Fails now: the handler does not exist.
// PINS the writer may dispute: the original row is never UPDATEd (the table grants lims_api SELECT + INSERT only), so "status reversed on the original" is DERIVED on read
// (getAccountLedgerEntry / listAccountLedgerEntries / statement rows show status 'reversed' for an entry that has a reversal row); the reversal row itself is 'submitted'
// and its comments carry reason_text (contract example); a second reversal, a reversal of a reversal -> 409 billing.ledger_reversal_invalid; a concurrent double reverse is
// one 201 and the rest 409 (never a 500 from the unique constraint).
import { describe, expect, it } from 'vitest';
import { T, TENANT_A, allSeqs, appTx, dbCount, dbEntries, entry, fire, notFound, ok, rejected, req, reverse, statement, summary, superTx, uid, world } from './helpers.js';

const get = (id: string) => fire('getAccountLedgerEntry', req({ params: { account_ledger_entry_id: id } }));

describe('reverseAccountLedgerEntry', () => {
  it('creates ONE opposite entry (same amount, centre, party, particular) linked by reverses_entry_id with the next receipt number; the original row is untouched', async () => {
    const w = await world('a');
    const orig = await entry(w, { amount_paisa: 123_456, entry_type: 'debit', comments: 'Synthetic original' });
    const [before] = await dbEntries(TENANT_A, 'id = $2', [orig.id]);
    const o = await reverse(w, orig.id, 'Synthetic wrong particular');
    const rev = ok(o, 201);
    expect(rev).toMatchObject({ entry_type: 'credit', amount_paisa: 123_456, centre_id: orig.centre_id, party_kind: orig.party_kind, party_id: orig.party_id,
      account_particular_id: orig.account_particular_id, reverses_entry_id: orig.id, status: 'submitted', comments: 'Synthetic wrong particular' });
    expect(rev.id).not.toBe(orig.id);
    expect(rev.receipt_no).not.toBe(orig.receipt_no);
    expect(Number(rev.receipt_no.slice(4))).toBeGreaterThan(Number(orig.receipt_no.slice(4)));   // a new number from the tenant counter (gap freeness is checked below)
    const [after] = await dbEntries(TENANT_A, 'id = $2', [orig.id]);
    expect(after).toEqual(before);                                   // byte for byte: no UPDATE of amount, party, particular, date, status
    expect(o.writes.filter((s) => /update|delete/i.test(s) && /account_ledger_entries/i.test(s))).toEqual([]);
    const seqs = await allSeqs(TENANT_A);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  }, T);

  // LD-324 (c) / LD-326: ctx.audit.access with action account_entry.reverse, entityType account_ledger_entry, entityId = the NEW reversal id, original id in detail.reverses_entry_id, ids only, outcome allowed.
  it('a reverse writes ONE audit.access_log row account_entry.reverse on the reversal id, original id in detail, no free text', async () => {
    const w = await world('a');
    const secrets = { comments: `Synthetic note ${uid()}`, bank_name: `Synthetic Bank ${uid()}`, reference_no: `REF-${uid()}`, payment_details: `Synthetic detail ${uid()}` };
    const orig = await entry(w, { payment_mode: 'bank_transfer', ...secrets });
    const reason = `Synthetic reason ${uid()}`;
    const o = await reverse(w, orig.id, reason);
    const rev = ok(o, 201);
    const rows = await superTx(async (tx) => (await tx.query(`SELECT to_jsonb(a) AS j FROM audit.access_log a WHERE tenant_id = $1 AND action IN ('account_entry.create','account_entry.reverse') AND entity_id = ANY($2::uuid[])`, [TENANT_A, [orig.id, rev.id]])).rows.map((r: { j: Record<string, any> }) => r.j), TENANT_A);
    const forRev = rows.filter((r) => r.entity_id === rev.id);
    expect(forRev, 'exactly one access_log row for the reversal id').toHaveLength(1);
    expect(forRev[0]).toMatchObject({ action: 'account_entry.reverse', entity_type: 'account_ledger_entry', outcome: 'allowed' });
    expect(forRev[0].detail.reverses_entry_id).toBe(orig.id);
    expect(rows.filter((r) => r.entity_id === orig.id).map((r) => r.action)).toEqual(['account_entry.create']);   // the create row of the original, entity_id = the original id
    const text = JSON.stringify(rows) + o.logs.join('\n');
    for (const v of [...Object.values(secrets), reason]) expect(text).not.toContain(v);
  }, T);

  it('the original now reads as reversed (derived), the reversal reads as submitted, and both are listed', async () => {
    const w = await world('a');
    const orig = await entry(w, {});
    const rev = ok(await reverse(w, orig.id), 201);
    expect(ok(await get(orig.id))).toMatchObject({ id: orig.id, status: 'reversed' });
    expect(ok(await get(rev.id))).toMatchObject({ id: rev.id, status: 'submitted', reverses_entry_id: orig.id });
    const list = ok(await fire('listAccountLedgerEntries', req({ query: { party_kind: 'credit_party', party_id: w.partyId, status: 'reversed' } })));
    expect(list.data.map((e: any) => e.id)).toEqual([orig.id]);
    const all = ok(await fire('listAccountLedgerEntries', req({ query: { party_kind: 'credit_party', party_id: w.partyId, limit: 200 } })));
    expect(all.data).toHaveLength(2);
  }, T);

  it('once only: a second reversal of the same entry and a reversal of a reversal are 409 billing.ledger_reversal_invalid and store nothing', async () => {
    const w = await world('a');
    const orig = await entry(w, {});
    const rev = ok(await reverse(w, orig.id), 201);
    const rows = await dbCount(TENANT_A); const seqs = await allSeqs(TENANT_A);
    rejected(await reverse(w, orig.id, 'again'), 'billing.ledger_reversal_invalid');
    rejected(await reverse(w, rev.id, 'undo the undo'), 'billing.ledger_reversal_invalid');
    expect(await dbCount(TENANT_A)).toBe(rows);
    expect(await allSeqs(TENANT_A)).toEqual(seqs);                   // a refused reversal consumes no receipt number
    expect(await dbCount(TENANT_A, 'reverses_entry_id = $2', [orig.id])).toBe(1);
  }, T);

  it('concurrent double reverse: exactly one 201, every other call 409 billing.ledger_reversal_invalid, one reversal row, sequence still gap free', async () => {
    const w = await world('a');
    const orig = await entry(w, {});
    const outs = await Promise.all(Array.from({ length: 6 }, () => reverse(w, orig.id)));
    expect(outs.filter((o) => o.reply?.status === 201)).toHaveLength(1);
    for (const o of outs.filter((x) => x.reply?.status !== 201)) rejected(o, 'billing.ledger_reversal_invalid');
    expect(await dbCount(TENANT_A, 'reverses_entry_id = $2', [orig.id])).toBe(1);
    const seqs = await allSeqs(TENANT_A);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  }, T);

  it('validation and isolation: reason_text required (1..500), extra body fields refused, unknown id 404, tenant B entry 404 and untouched, bad id 400', async () => {
    const a = await world('a'); const b = await world('b');
    const orig = await entry(a, {});
    const eb = ok(await fire('createAccountLedgerEntry', req({ headers: { 'idempotency-key': uid() }, body: { centre_id: b.centre, party_kind: 'credit_party', party_id: b.partyId, entry_date: '2026-11-17',
      account_particular_id: b.particularId, entry_type: 'credit', amount_paisa: 500, payment_mode: 'cash' } }), { tenant: b.tenant }), 201);
    for (const body of [{}, { reason_text: '' }, { reason_text: 'x'.repeat(501) }, { reason_text: 'ok', amount_paisa: 1 }, { reason_text: 'ok', entry_type: 'credit' }])
      rejected(await fire('reverseAccountLedgerEntry', req({ params: { account_ledger_entry_id: orig.id }, headers: { 'idempotency-key': uid() }, body })));
    notFound(await reverse(a, uid()));
    notFound(await reverse(a, eb.id));
    rejected(await fire('reverseAccountLedgerEntry', req({ params: { account_ledger_entry_id: 'nope' }, headers: { 'idempotency-key': uid() }, body: { reason_text: 'x' } })));
    expect(await dbCount(b.tenant, 'reverses_entry_id IS NOT NULL')).toBe(0);
    expect(await dbCount(TENANT_A, 'reverses_entry_id = $2', [orig.id])).toBe(0);
  }, T);

  it('a reversal nets the party balance back to what it was, and shows as its own statement row of the opposite type', async () => {
    const w = await world('a');
    const keep = await entry(w, { amount_paisa: 10_000, entry_type: 'credit', entry_date: '2026-11-10' });
    const orig = await entry(w, { amount_paisa: 4_000, entry_type: 'debit', entry_date: '2026-11-11' });
    const rev = ok(await reverse(w, orig.id), 201);
    const s = ok(await statement(w, '2026-11-01', '2026-11-30'));
    expect(s.rows.map((r: any) => r.entry_id)).toEqual([keep.id, orig.id, rev.id]);
    expect(s.rows[1]).toMatchObject({ entry_type: 'debit', debit_paisa: 4000, credit_paisa: 0, status: 'reversed' });
    expect(s.rows[2]).toMatchObject({ entry_type: 'credit', credit_paisa: 4000, debit_paisa: 0, reverses_entry_id: orig.id });
    expect(s.closing_balance_paisa).toBe(10_000);
    expect(s.closing_balance_side).toBe('credit');
    expect(ok(await summary(w))).toMatchObject({ outstanding_paisa: 10_000, outstanding_side: 'credit' });
  }, T);

  // LD-389: T0C-FINCTRL-1 grants lims_app column UPDATE on status + hold columns; trigger account_ledger_hold_guard allows only submitted<->held, else P0001 immutable_row.
  it('money columns and DELETE are refused with 42501, a status change other than hold and release is refused by the guard with P0001 immutable_row', async () => {
    const w = await world('a');
    const e = await entry(w, {});
    const [before] = await dbEntries(TENANT_A, 'id = $2', [e.id]);
    for (const sql of ['UPDATE billing.account_ledger_entries SET amount_paisa = 1 WHERE id = $1', 'DELETE FROM billing.account_ledger_entries WHERE id = $1']) {
      const err: any = await appTx(TENANT_A, async (tx: any) => { await tx.query(sql, [e.id]); }).then(() => undefined, (x: any) => x);
      expect(err?.code, sql).toBe('42501');
    }
    const err: any = await appTx(TENANT_A, async (tx: any) => { await tx.query("UPDATE billing.account_ledger_entries SET status = 'reversed' WHERE id = $1", [e.id]); }).then(() => undefined, (x: any) => x);
    expect(err?.code).toBe('P0001');
    expect(err?.message).toMatch(/immutable_row/);
    const [after] = await dbEntries(TENANT_A, 'id = $2', [e.id]);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ status: before.status, amount_paisa: before.amount_paisa });
  }, T);
});
