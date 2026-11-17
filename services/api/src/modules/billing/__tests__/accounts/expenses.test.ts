// T0B-ACCT-2 (LD-313, LD-310) createExpense / listExpenses / cancelExpense: done_when 2 (a create posts ONE debit entry in the same transaction using the expense type's particular;
// a cancel posts the reversal; an expense is never deleted), 1 (tenant isolation), 5 (audit on every write). Real PG17 under RLS. Fails now: the operations are pending (501), no handler.
// PINS the writer may dispute (CONV, listed in notes/T0B-ACCT-2-tests.md): the debit entry is on party_kind user_pocket, party_id = the actor (the pocket that paid), payment_mode cash,
// centre_id = expense centre, entry_date = the local (Asia/Kathmandu) date of expense_at, comments null, and expense.ledger_entry_id = that entry; the cancel is
// reverseAccountLedgerEntry semantics (one opposite credit row, reverses_entry_id = ledger_entry_id) and the expense row keeps its ledger_entry_id. Posted entries are access-audited
// (account_entry.create / account_entry.reverse, ids only).
import { describe, expect, it } from 'vitest';
import { notFound, rejected } from './helpers.js';
import { SYS_ACTOR, T, TENANT_A, auditActions, cancelExpense, createExpense, createType, dbRows, expWorld, ledgerCount, ledgerOf, listExpenses, ok, superTx, tag, uid } from './helpers2.js';

describe('createExpense', () => {
  it('posts ONE debit entry on the type particular in the same transaction, links it, and records only (no other ledger row)', async () => {
    const w = await expWorld('a');
    const before = await ledgerCount(w.tenant);
    const o = await createExpense(w, { amount_paisa: 25_000, description: 'Synthetic electricity bill' });
    const e = ok(o, 201);
    expect(e).toMatchObject({ centre_id: w.centre, expense_type_id: w.typeId, amount_paisa: 25_000, description: 'Synthetic electricity bill', version: 1, created_by: SYS_ACTOR });
    expect(e.cancelled_at).toBeUndefined();
    expect(typeof e.ledger_entry_id).toBe('string');
    expect(await ledgerCount(w.tenant)).toBe(before + 1);
    const [le] = await dbRows(w.tenant, 'SELECT *, entry_date::text AS entry_date_text FROM billing.account_ledger_entries WHERE tenant_id = $1 AND id = $2', [e.ledger_entry_id]);
    expect(le).toMatchObject({ entry_type: 'debit', amount_paisa: '25000', account_particular_id: w.expenseParticularId, centre_id: w.centre, party_kind: 'user_pocket', party_id: SYS_ACTOR, payment_mode: 'cash', reverses_entry_id: null });
    expect(le.entry_date_text).toBe('2026-11-17');
    expect(o.writes.filter((s) => /update|delete/i.test(s) && /account_ledger_entries/i.test(s))).toEqual([]);
    expect(await auditActions(w.tenant, 'expenses', e.id)).toEqual(['INSERT']);
  }, T);

  it('the expense and its debit entry commit together: a refused create leaves neither (unknown type, inactive type, bad amount)', async () => {
    const w = await expWorld('a');
    const before = await ledgerCount(w.tenant), expBefore = (await dbRows(w.tenant, 'SELECT count(*)::int AS c FROM billing.expenses WHERE tenant_id = $1'))[0].c;
    notFound(await createExpense(w, { expense_type_id: uid() }));
    const off = ok(await createType(w.tenant, { name: `Synthetic Off ${tag()}`, account_particular_id: w.expenseParticularId, is_active: false }), 201);
    rejected(await createExpense(w, { expense_type_id: off.id }));
    rejected(await createExpense(w, { amount_paisa: 0 }));
    expect(await ledgerCount(w.tenant)).toBe(before);
    expect((await dbRows(w.tenant, 'SELECT count(*)::int AS c FROM billing.expenses WHERE tenant_id = $1'))[0].c).toBe(expBefore);
  }, T);

  it('unknown centre and another tenant centre / type -> 404, nothing written', async () => {
    const a = await expWorld('a'), b = await expWorld('b');
    const before = await ledgerCount(a.tenant);
    notFound(await createExpense(a, { centre_id: uid() }));
    notFound(await createExpense(a, { centre_id: b.centre }));
    notFound(await createExpense(a, { expense_type_id: b.typeId }));
    expect(await ledgerCount(a.tenant)).toBe(before);
  }, T);

  it.each([
    ['amount 0', { amount_paisa: 0 }], ['negative amount', { amount_paisa: -5 }], ['float amount', { amount_paisa: 10.5 }], ['string amount', { amount_paisa: '100' }],
    ['over the max safe integer', { amount_paisa: 9007199254740992 }], ['empty description', { description: '' }], ['description over 2000', { description: 'x'.repeat(2001) }],
    ['expense_at not a date', { expense_at: 'yesterday' }], ['expense_at without Z', { expense_at: '2026-11-17T04:15:00' }], ['unknown field', { status: 'posted' }],
    ['ledger_entry_id from the client', { ledger_entry_id: uid() }], ['created_by from the client', { created_by: uid() }],
  ])('refuses %s with 400 common.validation_failed and posts nothing', async (_n, bad) => {
    const w = await expWorld('a');
    const before = await ledgerCount(w.tenant);
    rejected(await createExpense(w, bad));
    expect(await ledgerCount(w.tenant)).toBe(before);
  }, T);

  it('an amount above the tenant limit LIMS_BILLING_ACCOUNT_ENTRY_MAX_PAISA is refused like a ledger entry (400), the maximum itself is accepted', async () => {
    const w = await expWorld('a');
    const max = Number(process.env['LIMS_BILLING_ACCOUNT_ENTRY_MAX_PAISA'] ?? 500_000_000);
    rejected(await createExpense(w, { amount_paisa: max + 1 }));
    ok(await createExpense(w, { amount_paisa: max }), 201);
  }, T);

  it('audit: ONE access row account_entry.create on the debit entry id, ids only, no description text', async () => {
    const w = await expWorld('a');
    const note = `Synthetic note ${uid()}`;
    const o = await createExpense(w, { description: note });
    const e = ok(o, 201);
    const rows = await superTx(async (tx) => (await tx.query(`SELECT to_jsonb(a) AS j FROM audit.access_log a WHERE tenant_id = $1 AND action = 'account_entry.create' AND entity_id = $2`, [TENANT_A, e.ledger_entry_id])).rows.map((r: any) => r.j), TENANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: 'account_ledger_entry', outcome: 'allowed' });
    expect(JSON.stringify(rows) + o.logs.join('\n')).not.toContain(note);
  }, T);
});

describe('cancelExpense (reversal; never a delete)', () => {
  it('sets cancelled_at + reason, version 2, and posts ONE opposite credit entry linked to the debit; the expense row is kept', async () => {
    const w = await expWorld('a');
    const e = ok(await createExpense(w, { amount_paisa: 77_000 }), 201);
    const o = await cancelExpense(w.tenant, e.id, { reason_text: 'Synthetic duplicate entry' });
    const c = ok(o);
    expect(c).toMatchObject({ id: e.id, version: 2, cancel_reason_text: 'Synthetic duplicate entry', ledger_entry_id: e.ledger_entry_id, amount_paisa: 77_000 });
    expect(typeof c.cancelled_at).toBe('string');
    const rev = (await ledgerOf(w.tenant, SYS_ACTOR)).filter((r: any) => r.reverses_entry_id === e.ledger_entry_id);
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ entry_type: 'credit', amount_paisa: '77000', account_particular_id: w.expenseParticularId, centre_id: w.centre });
    expect(o.writes.filter((s) => /delete\s+from\s+billing\.expenses|truncate/i.test(s))).toEqual([]);
    expect(o.writes.filter((s) => /update|delete/i.test(s) && /account_ledger_entries/i.test(s))).toEqual([]);
    expect(await auditActions(w.tenant, 'expenses', e.id)).toEqual(['INSERT', 'UPDATE']);
    expect((await dbRows(w.tenant, 'SELECT count(*)::int AS c FROM billing.expenses WHERE tenant_id = $1 AND id = $2', [e.id]))[0].c).toBe(1);
  }, T);

  it('the reason is optional; a second cancel -> 409 common.immutable_record and posts no second reversal', async () => {
    const w = await expWorld('a');
    const e = ok(await createExpense(w), 201);
    ok(await cancelExpense(w.tenant, e.id, {}));
    const n = await ledgerCount(w.tenant);
    rejected(await cancelExpense(w.tenant, e.id), 'common.immutable_record');
    expect(await ledgerCount(w.tenant)).toBe(n);
  }, T);

  it('concurrent cancels: exactly one 200, the rest 409, exactly one reversal row', async () => {
    const w = await expWorld('a');
    const e = ok(await createExpense(w), 201);
    const outs = await Promise.all(Array.from({ length: 5 }, () => cancelExpense(w.tenant, e.id)));
    expect(outs.filter((o) => o.reply?.status === 200)).toHaveLength(1);
    expect(outs.filter((o) => o.error?.code === 'common.immutable_record')).toHaveLength(4);
    expect(outs.filter((o) => o.error && o.error.code !== 'common.immutable_record'), 'a 500 / pg error is a failure').toEqual([]);
    expect((await ledgerOf(w.tenant, SYS_ACTOR)).filter((r: any) => r.reverses_entry_id === e.ledger_entry_id)).toHaveLength(1);
  }, T);

  it('unknown id, another tenant id -> 404; bad id / reason -> 400; the reversal is access-audited as account_entry.reverse', async () => {
    const a = await expWorld('a'), b = await expWorld('b');
    const e = ok(await createExpense(a), 201);
    notFound(await cancelExpense(a.tenant, uid()));
    notFound(await cancelExpense(b.tenant, e.id));
    rejected(await cancelExpense(a.tenant, e.id, { reason_text: '' }));
    rejected(await cancelExpense(a.tenant, e.id, { reason_text: 'x'.repeat(501) }));
    rejected(await cancelExpense(a.tenant, e.id, { amount_paisa: 1 }));
    const note = `Synthetic reason ${uid()}`;
    const o = await cancelExpense(a.tenant, e.id, { reason_text: note });
    ok(o);
    const rev = (await ledgerOf(a.tenant, SYS_ACTOR)).find((r: any) => r.reverses_entry_id === e.ledger_entry_id);
    const rows = await superTx(async (tx) => (await tx.query(`SELECT to_jsonb(x) AS j FROM audit.access_log x WHERE tenant_id = $1 AND action = 'account_entry.reverse' AND entity_id = $2`, [TENANT_A, rev.id])).rows.map((r: any) => r.j), TENANT_A);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows) + o.logs.join('\n')).not.toContain(note);
  }, T);

  it('no expense can be deleted or edited through the API: only create / list / cancel operations exist on /v1/billing/expenses', async () => {
    const w = await expWorld('a');
    const e = ok(await createExpense(w), 201);
    expect(Object.keys(e)).not.toContain('updated_at');                       // contract: amount, type, centre are immutable; no update operation
    const m = (await import('../../handlers/index.js')).handlers as Record<string, unknown>;
    for (const op of ['updateExpense', 'deleteExpense', 'removeExpense']) expect(m[op], op).toBeUndefined();
  }, T);
});

describe('listExpenses', () => {
  it('lists the tenant expenses only, filters by centre / type / time window / include_cancelled, default hides cancelled', async () => {
    const a = await expWorld('a'), b = await expWorld('b');
    const e1 = ok(await createExpense(a, { expense_at: '2026-11-10T06:00:00.000Z' }), 201);
    const e2 = ok(await createExpense(a, { expense_at: '2026-11-12T06:00:00.000Z' }), 201);
    const gone = ok(await createExpense(a, { expense_at: '2026-11-12T07:00:00.000Z' }), 201);
    ok(await cancelExpense(a.tenant, gone.id));
    const foreign = ok(await createExpense(b), 201);
    const ids = async (q: Record<string, unknown>) => ok(await listExpenses(a.tenant, { limit: 200, ...q })).data.map((x: any) => x.id) as string[];
    const all = await ids({ expense_type_id: a.typeId });
    expect(all).toEqual(expect.arrayContaining([e1.id, e2.id]));
    expect(all).not.toContain(gone.id);
    expect(all).not.toContain(foreign.id);
    expect(await ids({ expense_type_id: a.typeId, include_cancelled: true })).toContain(gone.id);
    expect(await ids({ expense_type_id: a.typeId, expense_at_from: '2026-11-11T00:00:00.000Z', expense_at_to: '2026-11-13T00:00:00.000Z' })).toEqual([e2.id]);
    expect(await ids({ centre_id: b.centre })).toEqual([]);                      // another tenant's centre: nothing, not an error leak
    const page = ok(await listExpenses(a.tenant, { limit: 1 }));
    expect(page.data).toHaveLength(1);
  }, T);

  it('bad filters -> 400; bad cursor -> 400 common.invalid_cursor', async () => {
    const w = await expWorld('a');
    rejected(await listExpenses(w.tenant, { centre_id: 'nope' }));
    rejected(await listExpenses(w.tenant, { expense_at_from: 'x' }));
    rejected(await listExpenses(w.tenant, { limit: 0 }));
    rejected(await listExpenses(w.tenant, { cursor: '!!!' }), 'common.invalid_cursor');
  }, T);
});
