// T0B-ACCT-2 (LD-313, LD-310) createCashTransfer / listCashTransfers / acceptCashTransfer / rejectCashTransfer / cancelCashTransfer: done_when 3, 1, 5.
// Real PG17 under RLS, requests fired with different actors (helpers.ts Who). Fails now: the operations are pending (501), no handler.
// RULES under test: a transfer starts pending and posts NOTHING; accept posts a balanced pair (debit sender pocket, credit receiver pocket, same amount) in ONE transaction with the
// status change; reject and cancel post nothing; only the RECEIVER accepts or rejects (to_kind user: actor = to_id; to_kind centre: the actor's centre scope holds to_id), never the
// creator (decided_by <> created_by, contract + migration CHECK) -> auth.forbidden; only the creator / the sender or an administrator (role tenant_admin) cancels, and only while
// pending; a decided transfer is terminal -> 409 common.immutable_record; amount may not exceed the sender pocket balance unless featureFlags.allow_negative_pockets (default off)
// -> 400 common.validation_failed (contract lists no other code), checked at create AND again at accept, under a lock.
// PINS the writer may dispute (CONV, notes/T0B-ACCT-2-tests.md): pockets are account ledger entries with party_kind user_pocket (party_id = the membership id or the centre id);
// an endpoint must be an active membership / a centre of the tenant (else 404); the pair is posted on the tenant particular with code CASH_TRANSFER, payment_mode cash, centre =
// the centre endpoint or else ctx.centreId; the pair is access-audited (account_entry.create x2) and the transfer row is audited by its row trigger.
import { describe, expect, it } from 'vitest';
import { notFound, rejected } from './helpers.js';
import { CENTRE, T, TENANT_A, accept, auditActions, cancelT, dbRows, ledgerCount, ledgerOf, listT, mkTransfer, ok, pocket, reject, staff, superTx, tBody, tWorld, uid } from './helpers2.js';

const asReceiver = (r: { id: string }) => ({ actor: r.id });
const transferRow = async (tenant: string, id: string) => (await dbRows(tenant, 'SELECT * FROM billing.cash_transfers WHERE tenant_id = $1 AND id = $2', [id]))[0];

describe('createCashTransfer', () => {
  it('starts pending and posts NOTHING; created_by is the actor; audited as an INSERT', async () => {
    const w = await tWorld('a');
    const n = await ledgerCount(w.tenant);
    const o = await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, { amount_paisa: 300_000 }), { actor: w.sender.id });
    const t = ok(o, 201);
    expect(t).toMatchObject({ from_kind: 'user', from_id: w.sender.id, to_kind: 'user', to_id: w.receiver.id, amount_paisa: 300_000, status: 'pending', remark: 'Synthetic hand over', version: 1, created_by: w.sender.id });
    expect(t.decided_by).toBeUndefined();
    expect(await ledgerCount(w.tenant)).toBe(n);
    expect(await pocket(w.tenant, w.sender.id)).toBe(1_000_000);
    expect(await auditActions(w.tenant, 'cash_transfers', t.id)).toEqual(['INSERT']);
  }, T);

  it('user -> centre and centre -> user are allowed; from and to must differ; unknown or foreign endpoints -> 404', async () => {
    const w = await tWorld('a'), b = await tWorld('b');
    ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.centre, { to_kind: 'centre' }), { actor: w.sender.id }), 201);
    ok(await mkTransfer(w.tenant, tBody(w.centre, w.receiver.id, { from_kind: 'centre' }), { actor: w.sender.id, flags: { allow_negative_pockets: true } }), 201);
    rejected(await mkTransfer(w.tenant, tBody(w.sender.id, w.sender.id), { actor: w.sender.id }));
    notFound(await mkTransfer(w.tenant, tBody(w.sender.id, uid()), { actor: w.sender.id }));
    notFound(await mkTransfer(w.tenant, tBody(uid(), w.receiver.id), { actor: w.sender.id }));
    notFound(await mkTransfer(w.tenant, tBody(w.sender.id, b.receiver.id), { actor: w.sender.id }));       // a membership of the other tenant
    notFound(await mkTransfer(w.tenant, tBody(w.sender.id, uid(), { to_kind: 'centre' }), { actor: w.sender.id }));
  }, T);

  it.each([
    ['amount 0', { amount_paisa: 0 }], ['negative', { amount_paisa: -1 }], ['float', { amount_paisa: 1.5 }], ['string', { amount_paisa: '5' }], ['over the max safe integer', { amount_paisa: 9007199254740992 }],
    ['bad from_kind', { from_kind: 'wallet' }], ['bad to_kind', { to_kind: 'bank' }], ['from_id not a uuid', { from_id: 'x' }], ['empty remark', { remark: '' }],
    ['remark over 1000', { remark: 'x'.repeat(1001) }], ['status from the client', { status: 'accepted' }], ['decided_by from the client', { decided_by: uid() }], ['tenant_id in the body', { tenant_id: uid() }],
  ])('refuses %s with 400 and writes nothing', async (_n, bad) => {
    const w = await tWorld('a');
    const before = (await dbRows(w.tenant, 'SELECT count(*)::int AS c FROM billing.cash_transfers WHERE tenant_id = $1'))[0].c;
    rejected(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, bad), { actor: w.sender.id }));
    expect((await dbRows(w.tenant, 'SELECT count(*)::int AS c FROM billing.cash_transfers WHERE tenant_id = $1'))[0].c).toBe(before);
  }, T);

  it('amount above the sender pocket balance is refused (default no negative pockets); equal to the balance is fine; the setting allows more', async () => {
    const w = await tWorld('a', 100_000);
    rejected(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, { amount_paisa: 100_001 }), { actor: w.sender.id }));
    ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, { amount_paisa: 100_000 }), { actor: w.sender.id }), 201);
    ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, { amount_paisa: 100_001 }), { actor: w.sender.id, flags: { allow_negative_pockets: true } }), 201);
  }, T);
});

describe('acceptCashTransfer: one transaction, a balanced pair', () => {
  it('posts a debit on the sender pocket and a credit on the receiver pocket of the same amount, sets accepted + decided_by/at, version 2', async () => {
    const w = await tWorld('a');
    const t = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, { amount_paisa: 400_000 }), { actor: w.sender.id }), 201);
    const n = await ledgerCount(w.tenant);
    const o = await accept(w.tenant, t.id, asReceiver(w.receiver));
    const a = ok(o);
    expect(a).toMatchObject({ id: t.id, status: 'accepted', decided_by: w.receiver.id, version: 2, amount_paisa: 400_000 });
    expect(typeof a.decided_at).toBe('string');
    expect(await ledgerCount(w.tenant)).toBe(n + 2);
    const out = (await ledgerOf(w.tenant, w.sender.id)).filter((r: any) => r.entry_type === 'debit').at(-1);
    const inn = (await ledgerOf(w.tenant, w.receiver.id)).at(-1);
    expect(out).toMatchObject({ party_kind: 'user_pocket', entry_type: 'debit', amount_paisa: '400000', payment_mode: 'cash', reverses_entry_id: null });
    expect(inn).toMatchObject({ party_kind: 'user_pocket', entry_type: 'credit', amount_paisa: '400000', payment_mode: 'cash', reverses_entry_id: null });
    expect(out.account_particular_id).toBe(inn.account_particular_id);
    const [p] = await dbRows(w.tenant, `SELECT p.code FROM billing.account_particulars p WHERE p.tenant_id = $1 AND p.id = $2`, [out.account_particular_id]);
    expect(p.code).toBe('CASH_TRANSFER');
    expect(await pocket(w.tenant, w.sender.id)).toBe(600_000);
    expect(await pocket(w.tenant, w.receiver.id)).toBe(400_000);
    expect(o.writes.filter((s) => /update|delete/i.test(s) && /account_ledger_entries/i.test(s))).toEqual([]);
    expect(await auditActions(w.tenant, 'cash_transfers', t.id)).toEqual(['INSERT', 'UPDATE']);
  }, T);

  it('audit: the pair is access-audited (account_entry.create x2, ids only, no remark text)', async () => {
    const w = await tWorld('a');
    const remark = `Synthetic remark ${uid()}`;
    const t = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, { remark }), { actor: w.sender.id }), 201);
    const o = await accept(w.tenant, t.id, asReceiver(w.receiver));
    ok(o);
    const ids = [(await ledgerOf(w.tenant, w.sender.id)).at(-1).id, (await ledgerOf(w.tenant, w.receiver.id)).at(-1).id];
    const rows = await superTx(async (tx) => (await tx.query(`SELECT to_jsonb(x) AS j FROM audit.access_log x WHERE tenant_id = $1 AND action = 'account_entry.create' AND entity_id = ANY($2::uuid[])`, [TENANT_A, ids])).rows.map((r: any) => r.j), TENANT_A);
    expect(rows.map((r: any) => r.entity_id).sort()).toEqual([...ids].sort());
    expect(JSON.stringify(rows) + o.logs.join('\n')).not.toContain(remark);
  }, T);

  it('a double accept is refused (409 common.immutable_record) and posts no second pair; concurrent accepts post exactly one', async () => {
    const w = await tWorld('a');
    const t = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, { amount_paisa: 100_000 }), { actor: w.sender.id }), 201);
    ok(await accept(w.tenant, t.id, asReceiver(w.receiver)));
    const n = await ledgerCount(w.tenant);
    rejected(await accept(w.tenant, t.id, asReceiver(w.receiver)), 'common.immutable_record');
    expect(await ledgerCount(w.tenant)).toBe(n);
    const t2 = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, { amount_paisa: 100_000 }), { actor: w.sender.id }), 201);
    const outs = await Promise.all(Array.from({ length: 6 }, () => accept(w.tenant, t2.id, asReceiver(w.receiver))));
    expect(outs.filter((o) => o.reply?.status === 200)).toHaveLength(1);
    expect(outs.filter((o) => o.error && o.error.code !== 'common.immutable_record'), 'a 500 / pg error is a failure').toEqual([]);
    expect(await ledgerCount(w.tenant)).toBe(n + 2);
    expect(await pocket(w.tenant, w.sender.id)).toBe(1_000_000 - 200_000);
  }, T);

  it('only the receiver decides: the sender, a stranger and the creator get auth.forbidden; nothing is posted and the transfer stays pending', async () => {
    const w = await tWorld('a');
    const t = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id), { actor: w.sender.id }), 201);
    const n = await ledgerCount(w.tenant);
    for (const who of [w.sender, w.stranger]) {
      rejected(await accept(w.tenant, t.id, asReceiver(who)), 'auth.forbidden');
      rejected(await reject(w.tenant, t.id, asReceiver(who)), 'auth.forbidden');
    }
    // the receiver as creator (a pull request): decided_by <> created_by -> forbidden even though the actor is the receiver
    const pull = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id), { actor: w.receiver.id }), 201);
    rejected(await accept(w.tenant, pull.id, asReceiver(w.receiver)), 'auth.forbidden');
    expect(await ledgerCount(w.tenant)).toBe(n);
    expect((await transferRow(w.tenant, t.id)).status).toBe('pending');
    expect((await transferRow(w.tenant, pull.id)).status).toBe('pending');
  }, T);

  it('centre receiver: an actor whose centre scope holds the centre accepts; an actor without it does not; the centre pocket is credited', async () => {
    const w = await tWorld('a');
    const t = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.centre, { to_kind: 'centre', amount_paisa: 200_000 }), { actor: w.sender.id }), 201);
    rejected(await accept(w.tenant, t.id, { actor: w.stranger.id, centreIds: [] }), 'auth.forbidden');
    ok(await accept(w.tenant, t.id, { actor: w.stranger.id, centreIds: [CENTRE.a] }));
    expect(await pocket(w.tenant, w.centre)).toBe(200_000);
    expect(await pocket(w.tenant, w.sender.id)).toBe(800_000);
  }, T);

  it('balance rule at accept: the sender pocket may have been drained since create -> 400, nothing posted, still pending; the flag lets it go negative', async () => {
    const w = await tWorld('a', 500_000);
    const t1 = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, { amount_paisa: 400_000 }), { actor: w.sender.id }), 201);
    const t2 = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.stranger.id, { amount_paisa: 400_000 }), { actor: w.sender.id }), 201);
    ok(await accept(w.tenant, t1.id, asReceiver(w.receiver)));
    const n = await ledgerCount(w.tenant);
    rejected(await accept(w.tenant, t2.id, asReceiver(w.stranger)));
    expect(await ledgerCount(w.tenant)).toBe(n);
    expect((await transferRow(w.tenant, t2.id)).status).toBe('pending');
    ok(await accept(w.tenant, t2.id, { actor: w.stranger.id, flags: { allow_negative_pockets: true } }));
    expect(await pocket(w.tenant, w.sender.id)).toBe(500_000 - 800_000);
  }, T);

  it('exact balance drains the pocket to 0; two concurrent accepts that together exceed the balance: exactly one succeeds, the pocket never goes negative', async () => {
    const w = await tWorld('a', 600_000);
    const a = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, { amount_paisa: 400_000 }), { actor: w.sender.id }), 201);
    const b = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.stranger.id, { amount_paisa: 400_000 }), { actor: w.sender.id }), 201);
    const [x, y] = await Promise.all([accept(w.tenant, a.id, asReceiver(w.receiver)), accept(w.tenant, b.id, asReceiver(w.stranger))]);
    expect([x, y].filter((o) => o.reply?.status === 200)).toHaveLength(1);
    expect([x, y].filter((o) => o.error && o.error.code !== 'common.validation_failed'), 'the loser is a clean 400, not a pg error').toEqual([]);
    expect(await pocket(w.tenant, w.sender.id)).toBe(200_000);
    const w2 = await tWorld('a', 250_000);
    const t = ok(await mkTransfer(w2.tenant, tBody(w2.sender.id, w2.receiver.id, { amount_paisa: 250_000 }), { actor: w2.sender.id }), 201);
    ok(await accept(w2.tenant, t.id, asReceiver(w2.receiver)));
    expect(await pocket(w2.tenant, w2.sender.id)).toBe(0);
  }, T);

  it('tenant isolation: the other tenant cannot accept (404) and no ledger row appears', async () => {
    const a = await tWorld('a'), b = await tWorld('b');
    const t = ok(await mkTransfer(a.tenant, tBody(a.sender.id, a.receiver.id), { actor: a.sender.id }), 201);
    const nA = await ledgerCount(a.tenant), nB = await ledgerCount(b.tenant);
    notFound(await accept(b.tenant, t.id, { actor: b.receiver.id }));
    notFound(await accept(b.tenant, t.id, { actor: a.receiver.id }));
    notFound(await accept(a.tenant, uid(), asReceiver(a.receiver)));
    expect(await ledgerCount(a.tenant)).toBe(nA);
    expect(await ledgerCount(b.tenant)).toBe(nB);
  }, T);

});

describe('rejectCashTransfer / cancelCashTransfer post nothing', () => {
  it('reject: receiver only, status rejected, decided_by set, no ledger row, terminal (a second reject, accept or cancel -> 409)', async () => {
    const w = await tWorld('a');
    const t = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id), { actor: w.sender.id }), 201);
    const n = await ledgerCount(w.tenant);
    const r = ok(await reject(w.tenant, t.id, asReceiver(w.receiver)));
    expect(r).toMatchObject({ status: 'rejected', decided_by: w.receiver.id, version: 2 });
    expect(await ledgerCount(w.tenant)).toBe(n);
    rejected(await reject(w.tenant, t.id, asReceiver(w.receiver)), 'common.immutable_record');
    rejected(await accept(w.tenant, t.id, asReceiver(w.receiver)), 'common.immutable_record');
    rejected(await cancelT(w.tenant, t.id, { actor: w.sender.id }), 'common.immutable_record');
    expect(await auditActions(w.tenant, 'cash_transfers', t.id)).toEqual(['INSERT', 'UPDATE']);
  }, T);

  it('cancel: the creator / sender cancels while pending; an administrator may too; the receiver and a stranger may not; no ledger row; terminal', async () => {
    const w = await tWorld('a');
    const mk = async () => ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id), { actor: w.sender.id }), 201);
    const n = await ledgerCount(w.tenant);
    const t1 = await mk();
    rejected(await cancelT(w.tenant, t1.id, { actor: w.receiver.id }), 'auth.forbidden');
    rejected(await cancelT(w.tenant, t1.id, { actor: w.stranger.id }), 'auth.forbidden');
    expect(ok(await cancelT(w.tenant, t1.id, { actor: w.sender.id }))).toMatchObject({ status: 'cancelled', decided_by: w.sender.id, version: 2 });
    const t2 = await mk();
    const admin = await staff(w.tenant);
    expect(ok(await cancelT(w.tenant, t2.id, { actor: admin.id, roles: ['tenant_admin'] }))).toMatchObject({ status: 'cancelled', decided_by: admin.id });
    const t3 = await mk();
    rejected(await cancelT(w.tenant, t3.id, { actor: w.stranger.id, roles: ['finance'] }), 'auth.forbidden');   // finance alone is not an administrator
    expect(await ledgerCount(w.tenant)).toBe(n);
    rejected(await cancelT(w.tenant, t1.id, { actor: w.sender.id }), 'common.immutable_record');
    rejected(await accept(w.tenant, t1.id, asReceiver(w.receiver)), 'common.immutable_record');
    expect(await ledgerCount(w.tenant)).toBe(n);
  }, T);

  it('an accepted transfer cannot be cancelled afterwards (409) and cancel of another tenant id is 404', async () => {
    const a = await tWorld('a'), b = await tWorld('b');
    const t = ok(await mkTransfer(a.tenant, tBody(a.sender.id, a.receiver.id), { actor: a.sender.id }), 201);
    ok(await accept(a.tenant, t.id, asReceiver(a.receiver)));
    rejected(await cancelT(a.tenant, t.id, { actor: a.sender.id }), 'common.immutable_record');
    notFound(await cancelT(b.tenant, t.id, { actor: b.sender.id }));
    notFound(await reject(b.tenant, t.id, { actor: b.receiver.id }));
  }, T);

  it('accept vs cancel race: exactly one wins, and a cancelled transfer never leaves a posted pair', async () => {
    const w = await tWorld('a');
    const t = ok(await mkTransfer(w.tenant, tBody(w.sender.id, w.receiver.id, { amount_paisa: 100_000 }), { actor: w.sender.id }), 201);
    const n = await ledgerCount(w.tenant);
    const [x, y] = await Promise.all([accept(w.tenant, t.id, asReceiver(w.receiver)), cancelT(w.tenant, t.id, { actor: w.sender.id })]);
    expect([x, y].filter((o) => o.reply?.status === 200)).toHaveLength(1);
    expect([x, y].filter((o) => o.error && o.error.code !== 'common.immutable_record'), 'the loser is a clean 409').toEqual([]);
    const status = (await transferRow(w.tenant, t.id)).status;
    expect(await ledgerCount(w.tenant)).toBe(status === 'accepted' ? n + 2 : n);
  }, T);
});

describe('listCashTransfers', () => {
  it('lists the tenant transfers only, filters by status / from_id / to_id, pages', async () => {
    const a = await tWorld('a'), b = await tWorld('b');
    const t1 = ok(await mkTransfer(a.tenant, tBody(a.sender.id, a.receiver.id), { actor: a.sender.id }), 201);
    const t2 = ok(await mkTransfer(a.tenant, tBody(a.sender.id, a.stranger.id), { actor: a.sender.id }), 201);
    ok(await reject(a.tenant, t2.id, asReceiver(a.stranger)));
    const foreign = ok(await mkTransfer(b.tenant, tBody(b.sender.id, b.receiver.id), { actor: b.sender.id }), 201);
    const ids = async (q: Record<string, unknown>) => ok(await listT(a.tenant, { limit: 200, ...q })).data.map((x: any) => x.id) as string[];
    const all = await ids({ from_id: a.sender.id });
    expect(all).toEqual(expect.arrayContaining([t1.id, t2.id]));
    expect(all).not.toContain(foreign.id);
    expect(await ids({ from_id: a.sender.id, status: 'pending' })).toEqual([t1.id]);
    expect(await ids({ from_id: a.sender.id, status: 'rejected' })).toEqual([t2.id]);
    expect(await ids({ to_id: a.stranger.id })).toEqual([t2.id]);
    expect(await ids({ from_id: b.sender.id })).toEqual([]);
    expect(ok(await listT(a.tenant, { limit: 1 })).data).toHaveLength(1);
    rejected(await listT(a.tenant, { status: 'done' }));
    rejected(await listT(a.tenant, { cursor: '!!!' }), 'common.invalid_cursor');
  }, T);
});

describe('property: any sequence of transfers keeps the ledger balanced', () => {
  it('after random accepts / rejects / cancels the sum of all user pocket balances is unchanged (a pair never creates or destroys money)', async () => {
    const w = await tWorld('a', 2_000_000);
    const people = [w.sender, w.receiver, w.stranger, await staff(w.tenant)];
    const total = async () => (await Promise.all(people.map((p) => pocket(w.tenant, p.id)))).reduce((s, x) => s + x, 0);
    expect(await total()).toBe(2_000_000);
    let seed0 = 7;
    const rnd = () => { seed0 = (seed0 * 48271) % 2147483647; return seed0 / 2147483647; };
    for (let i = 0; i < 12; i++) {
      const from = people[Math.floor(rnd() * 4)]!, to = people[Math.floor(rnd() * 4)]!;
      if (from.id === to.id) continue;
      const amount = 1 + Math.floor(rnd() * 900_000);
      const c = await mkTransfer(w.tenant, tBody(from.id, to.id, { amount_paisa: amount }), { actor: from.id });
      if (!c.reply) { expect(c.error?.code, 'only a balance refusal is acceptable').toBe('common.validation_failed'); continue; }
      const t = c.reply.body;
      const pick = rnd();
      await (pick < 0.6 ? accept(w.tenant, t.id, asReceiver(to)) : pick < 0.8 ? reject(w.tenant, t.id, asReceiver(to)) : cancelT(w.tenant, t.id, { actor: from.id }));
      expect(await total(), `after step ${i} (seed 7)`).toBe(2_000_000);
      for (const p of people) expect(await pocket(w.tenant, p.id), `pocket never negative (seed 7, step ${i})`).toBeGreaterThanOrEqual(0);
    }
  }, T * 2);
});
