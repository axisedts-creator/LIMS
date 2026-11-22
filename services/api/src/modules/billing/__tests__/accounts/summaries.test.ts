// T0D-BUILD-1 (LD-447, LD-358) listAccountSummaries: GET /v1/billing/account-summaries, read only, computed from the existing tables, real PG17 under RLS.
// Fails now: the handler is not registered. PINS the writer may dispute (say so in the ruling, do not bend them silently):
//  - the outstanding figure and side of a row equal getAccountSummary for the same party (done_when 1: one fixture asserts it); credit_limit NULL / absent = 0, is_blocked = is_locked;
//  - q = case-insensitive SUBSTRING of party_name, and % _ \ in q are literal characters (no LIKE wildcard injection);
//  - outstanding_only keeps parties with outstanding_paisa > 0 on EITHER side; blocked_only / outstanding_only = false (or absent) filter nothing; filters combine with AND;
//  - party_kind credit_party (billing.credit_accounts, name = party_display_name) and franchise (core.collection_centres of centre_kind 'franchise') are pinned; laboratory and
//    user_pocket rows are NOT pinned (their party tables are not fixed by the contract), only that a kind filter never returns another kind;
//  - page.limit echoes the effective limit (default 50), next_cursor is present only when more rows exist, the cursor is opaque (^[A-Za-z0-9_-]+$, <= 512) and the order is
//    stable: the pages concatenated equal the one big page, no row twice, none lost; the handler needs a bounded number of statements (no query per party);
//  - a cursor that does not decode, or that belongs to another list, = 400 common.invalid_cursor; a bad party_kind / limit / q / boolean = 400 common.validation_failed;
//  - an empty tenant answers 200 with data [] (never 500, never 404); another tenant's parties and balances never appear; no row is written by this read.
import { describe, expect, it } from 'vitest';
import { encode } from '../../service/accounts.service.js';
import { T, TENANT_A, TENANT_B, fire, moneyIsInteger, ok, ownerRows, post, prng, rejected, req, reverse, seed, superTx, tag, uid, world, type World } from './helpers.js';

const LIST = 'listAccountSummaries';
const list = (query: Record<string, unknown> = {}, tenant: string = TENANT_A) => fire(LIST, req({ query }), { tenant });

/** a credit party with a unique searchable name (committed by the superuser), tagged so tests never depend on what other files left in the tenant. */
async function party(tenant: string, name: string, o: { limitPaisa?: number | null; locked?: boolean } = {}): Promise<string> {
  const id = uid();
  await seed('billing.credit_accounts', {
    tenant_id: tenant, credit_party_id: id, party_code: `CP_${tag()}`, party_display_name: name,
    credit_limit_paisa: o.limitPaisa === undefined ? 5_000_000 : o.limitPaisa, is_locked: o.locked === true, lock_reason_code: o.locked ? 'overdue' : null,
  });
  return id;
}
/** a franchise centre (core.collection_centres, centre_kind 'franchise') of the tenant's first branch. */
async function franchise(tenant: string, name: string): Promise<string> {
  const branch = (await ownerRows('core.branches', 'tenant_id = $1 LIMIT 1', [tenant]))[0]?.id;
  expect(branch, 'fixture: the tenant has a branch').toBeDefined();
  const id = uid();
  await seed('core.collection_centres', { id, tenant_id: tenant, branch_id: branch, centre_code: `F${tag()}`.slice(0, 16), name, centre_kind: 'franchise', is_active: true });
  return id;
}
const book = (w: World, partyId: string, type: 'credit' | 'debit', paisa: number, kind = 'credit_party') =>
  post(w, { party_kind: kind, party_id: partyId, entry_type: type, amount_paisa: paisa }).then((o) => ok(o, 201));
const names = (b: any): string[] => b.data.map((r: any) => r.party_name);
const ids = (b: any): string[] => b.data.map((r: any) => r.party_id);

describe('listAccountSummaries: rows (done_when 1)', () => {
  it('a row equals getAccountSummary of the same party (limit, outstanding with side, blocked) plus the party name; money is integer paisa', async () => {
    const w = await world('a'); const tg = tag();
    const p = await party(TENANT_A, `Synthetic Equality ${tg}`, { limitPaisa: 7_500_000 });
    await book(w, p, 'credit', 150_000); await book(w, p, 'debit', 250_000);
    const wrongWay = await book(w, p, 'debit', 31_337); ok(await reverse(w, wrongWay.id), 201);   // a reversed pair nets to zero and must not change the figure
    const row = ok(await list({ q: tg })).data;
    expect(row).toHaveLength(1);
    const sm = ok(await fire('getAccountSummary', req({ query: { party_kind: 'credit_party', party_id: p } })));
    expect(row[0]).toEqual({ ...sm, party_name: `Synthetic Equality ${tg}` });
    expect(row[0]).toEqual({ party_kind: 'credit_party', party_id: p, party_name: `Synthetic Equality ${tg}`, credit_limit_paisa: 7_500_000, outstanding_paisa: 100_000, outstanding_side: 'debit', is_blocked: false });
    expect(moneyIsInteger(ok(await list({ q: tg })))).toEqual([]);
  }, T);

  it('200 random entries over 12 parties: every row equals getAccountSummary of its party (seeded PRNG, replayable)', async () => {
    const SEED = 20261122; const rnd = prng(SEED);
    const w = await world('a'); const tg = tag();
    const parties: string[] = [];
    for (let i = 0; i < 12; i++) parties.push(await party(TENANT_A, `Synthetic Random ${tg} ${String(i).padStart(2, '0')}`, { limitPaisa: i % 3 === 0 ? null : 1_000_000 * (i + 1), locked: i % 5 === 0 }));
    for (let i = 0; i < 200; i++) await book(w, parties[Math.floor(rnd() * parties.length)]!, rnd() < 0.5 ? 'credit' : 'debit', 1 + Math.floor(rnd() * 900_000));
    const rows = ok(await list({ q: tg })).data;
    expect(rows.length, `seed ${SEED}`).toBe(12);
    for (const r of rows) {
      const sm = ok(await fire('getAccountSummary', req({ query: { party_kind: 'credit_party', party_id: r.party_id } })));
      expect(r, `seed ${SEED} party ${r.party_name}`).toEqual({ ...sm, party_name: r.party_name });
    }
  }, T * 4);

  it('a locked party is blocked, a party without a credit limit shows 0, a party without entries shows 0 outstanding', async () => {
    const tg = tag();
    const a = await party(TENANT_A, `Synthetic Locked ${tg}`, { limitPaisa: 1_000, locked: true });
    const b = await party(TENANT_A, `Synthetic NoLimit ${tg}`, { limitPaisa: null });
    const rows = Object.fromEntries(ok(await list({ q: tg })).data.map((r: any) => [r.party_id, r]));
    expect(rows[a]).toMatchObject({ credit_limit_paisa: 1_000, is_blocked: true, outstanding_paisa: 0 });
    expect(rows[b]).toMatchObject({ credit_limit_paisa: 0, is_blocked: false, outstanding_paisa: 0 });
  }, T);

  it('a franchise row is listed with kind franchise, limit 0, not blocked; its balance is the getAccountSummary figure', async () => {
    const w = await world('a'); const tg = tag();
    const f = await franchise(TENANT_A, `Synthetic Franchise ${tg}`);
    ok(await post(w, { party_kind: 'franchise', party_id: f, entry_type: 'debit', amount_paisa: 64_000 }), 201);
    const rows = ok(await list({ q: tg })).data;
    expect(rows).toHaveLength(1);
    const sm = ok(await fire('getAccountSummary', req({ query: { party_kind: 'franchise', party_id: f } })));
    expect(rows[0]).toEqual({ ...sm, party_name: `Synthetic Franchise ${tg}` });
    expect(rows[0]).toMatchObject({ party_kind: 'franchise', credit_limit_paisa: 0, is_blocked: false, outstanding_paisa: 64_000, outstanding_side: 'debit' });
  }, T);

  it('read only: no row is written by the list (an access log row is the only write allowed), and no statement per party', async () => {
    const tg = tag();
    for (let i = 0; i < 12; i++) await party(TENANT_A, `Synthetic Reads ${tg} ${i}`);
    const o = await list({ q: tg });
    expect(ok(o).data).toHaveLength(12);
    expect(o.writes.filter((s) => !/access_log/i.test(s)), 'a read must not write business rows').toEqual([]);
    expect(o.stmts.length, `12 parties answered with ${o.stmts.length} statements: one set based read, not one query per party`).toBeLessThanOrEqual(6);
  }, T);
});

describe('listAccountSummaries: filters (done_when 2)', () => {
  it('party_kind keeps only that kind, and no kind filter returns both', async () => {
    const tg = tag();
    const c = await party(TENANT_A, `Synthetic Kind ${tg} credit`); const f = await franchise(TENANT_A, `Synthetic Kind ${tg} franchise`);
    expect(ids(ok(await list({ q: tg })))).toEqual(expect.arrayContaining([c, f]));
    expect(ids(ok(await list({ q: tg, party_kind: 'credit_party' })))).toEqual([c]);
    const fr = ok(await list({ q: tg, party_kind: 'franchise' }));
    expect(ids(fr)).toEqual([f]);
    expect(fr.data[0].party_kind).toBe('franchise');
    for (const k of ['laboratory', 'user_pocket']) for (const r of ok(await list({ q: tg, party_kind: k })).data) expect(r.party_kind).toBe(k);
  }, T);

  it('q: case-insensitive substring of the party name; no match = empty 200; leading / trailing spaces do not break it', async () => {
    const tg = tag();
    const p = await party(TENANT_A, `Synthetic Himal Diagnostics ${tg}`); await party(TENANT_A, `Synthetic Everest Clinic ${tg}`);
    expect(ids(ok(await list({ q: `himal diag` }))).includes(p)).toBe(true);
    expect(names(ok(await list({ q: `HIMAL DIAGNOSTICS ${tg.toLowerCase()}` })))).toEqual([`Synthetic Himal Diagnostics ${tg}`]);
    expect(names(ok(await list({ q: tg }))).sort()).toEqual([`Synthetic Everest Clinic ${tg}`, `Synthetic Himal Diagnostics ${tg}`]);
    expect(ok(await list({ q: `NoSuchParty${tg}` })).data).toEqual([]);
  }, T);

  it("q treats % _ \\ and quotes as plain characters: no wildcard match, no SQL error, never a 500", async () => {
    const tg = tag(); await party(TENANT_A, `Synthetic Plain ${tg}`);
    for (const evil of ['%', '_', '\\', '%%', "'; DROP TABLE billing.credit_accounts; --", '" OR 1=1 --', 'a\u0000b']) {
      const o = await list({ q: evil });
      if (o.error) rejected(o);                                         // a typed 400 is acceptable for a value the contract cannot take (NUL), a 500 or a pg error is not
      else for (const r of o.reply!.body.data) expect(r.party_name.toLowerCase(), `q=${JSON.stringify(evil)} must be a literal substring`).toContain(evil.toLowerCase());
    }
    expect(ok(await list({ q: tg })).data, 'the table is still there').toHaveLength(1);
  }, T);

  it('blocked_only: only blocked parties; false or absent filters nothing', async () => {
    const tg = tag();
    const lk = await party(TENANT_A, `Synthetic Blocked ${tg}`, { locked: true }); const fine = await party(TENANT_A, `Synthetic Fine ${tg}`);
    expect(ids(ok(await list({ q: tg, blocked_only: true })))).toEqual([lk]);
    expect(ids(ok(await list({ q: tg, blocked_only: false }))).sort()).toEqual([lk, fine].sort());
    expect(ids(ok(await list({ q: tg }))).sort()).toEqual([lk, fine].sort());
  }, T);

  it('outstanding_only: parties with outstanding above 0 on either side; zero balances and reversed pairs are left out', async () => {
    const w = await world('a'); const tg = tag();
    const owes = await party(TENANT_A, `Synthetic Owes ${tg}`); const ahead = await party(TENANT_A, `Synthetic Ahead ${tg}`);
    const zero = await party(TENANT_A, `Synthetic Zero ${tg}`); const undone = await party(TENANT_A, `Synthetic Undone ${tg}`); await party(TENANT_A, `Synthetic Untouched ${tg}`);
    await book(w, owes, 'debit', 70_000); await book(w, ahead, 'credit', 5_000);
    await book(w, zero, 'debit', 900); await book(w, zero, 'credit', 900);
    ok(await reverse(w, (await book(w, undone, 'credit', 4_200)).id), 201);
    const got = ok(await list({ q: tg, outstanding_only: true }));
    expect(ids(got).sort()).toEqual([owes, ahead].sort());
    expect(Object.fromEntries(got.data.map((r: any) => [r.party_id, r.outstanding_side]))).toEqual({ [owes]: 'debit', [ahead]: 'credit' });
    expect(got.data.every((r: any) => r.outstanding_paisa > 0)).toBe(true);
    expect(ok(await list({ q: tg, outstanding_only: false })).data).toHaveLength(5);
  }, T);

  it('filters combine with AND: blocked_only + outstanding_only + q + party_kind', async () => {
    const w = await world('a'); const tg = tag();
    const both = await party(TENANT_A, `Synthetic Both ${tg}`, { locked: true }); const lockedZero = await party(TENANT_A, `Synthetic LockedZero ${tg}`, { locked: true });
    const owesOnly = await party(TENANT_A, `Synthetic OwesOnly ${tg}`);
    await book(w, both, 'debit', 10_000); await book(w, owesOnly, 'debit', 10_000);
    expect(ids(ok(await list({ q: tg, blocked_only: true, outstanding_only: true })))).toEqual([both]);
    expect(ids(ok(await list({ q: tg, blocked_only: true }))).sort()).toEqual([both, lockedZero].sort());
    expect(ok(await list({ q: tg, blocked_only: true, outstanding_only: true, party_kind: 'franchise' })).data).toEqual([]);
    expect(ok(await list({ q: `${tg} nomatch`, blocked_only: true, outstanding_only: true })).data).toEqual([]);
  }, T);
});

describe('listAccountSummaries: paging (done_when 2)', () => {
  it('cursor paging across pages: no row twice, none lost, stable order, next_cursor only while rows remain, the cursor is opaque', async () => {
    const tg = tag(); const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push(await party(TENANT_A, `Synthetic Page ${tg} ${i}`));
    const whole = ok(await list({ q: tg, limit: 200 }));
    expect(ids(whole).sort()).toEqual([...made].sort());
    expect(whole.page.next_cursor, 'all rows fit: no cursor').toBeUndefined();
    expect(whole.page.limit).toBe(200);

    const p1 = ok(await list({ q: tg, limit: 2 }));
    expect(p1.data).toHaveLength(2);
    expect(p1.page.limit).toBe(2);
    expect(p1.page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(p1.page.next_cursor.length).toBeLessThanOrEqual(512);
    const p2 = ok(await list({ q: tg, limit: 2, cursor: p1.page.next_cursor }));
    expect(p2.data).toHaveLength(2);
    expect(p2.page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const p3 = ok(await list({ q: tg, limit: 2, cursor: p2.page.next_cursor }));
    expect(p3.data).toHaveLength(1);
    expect(p3.page.next_cursor, 'last page has no cursor').toBeUndefined();

    const paged = [...ids(p1), ...ids(p2), ...ids(p3)];
    expect(new Set(paged).size, 'no row on two pages').toBe(5);
    expect(paged, 'the pages concatenated are the one big page, same order').toEqual(ids(whole));
    expect(ids(ok(await list({ q: tg, limit: 2 }))), 'same request, same order (stable)').toEqual(ids(p1));
  }, T);

  it('a page that ends exactly on the last row has no next_cursor; limit 1 walks every row; the default limit is 50', async () => {
    const tg = tag();
    for (let i = 0; i < 3; i++) await party(TENANT_A, `Synthetic Edge ${tg} ${i}`);
    expect(ok(await list({ q: tg, limit: 3 })).page.next_cursor).toBeUndefined();
    let cursor: string | undefined; const seen: string[] = [];
    for (let guard = 0; guard < 6; guard++) {
      const b = ok(await list({ q: tg, limit: 1, ...(cursor ? { cursor } : {}) }));
      expect(b.data.length).toBeLessThanOrEqual(1);
      seen.push(...ids(b)); cursor = b.page.next_cursor; if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(3);
    expect(ok(await list({ q: tg })).page.limit).toBe(50);
  }, T);

  it('a party created between two page reads does not duplicate or drop a row of the walk', async () => {
    const tg = tag();
    for (let i = 0; i < 4; i++) await party(TENANT_A, `Synthetic Walk ${tg} ${i}`);
    const p1 = ok(await list({ q: tg, limit: 2 }));
    await party(TENANT_A, `Synthetic Walk ${tg} 9 late`);
    const p2 = ok(await list({ q: tg, limit: 2, cursor: p1.page.next_cursor }));
    expect(ids(p2).filter((i) => ids(p1).includes(i)), 'no row repeated across the pages').toEqual([]);
    expect(ids(p1)).toHaveLength(2);
  }, T);
});

describe('listAccountSummaries: bad input is a typed 400, never a 500 (done_when 2)', () => {
  it.each([
    ['garbage that is valid base64url', 'zzzzzzzz'],
    ['not base64 json', 'bm90LWpzb24'],
    ['a cursor of another list (account_groups)', encode('account_groups', 'ABC')],
    ['a cursor with a wrong key type', Buffer.from(JSON.stringify(['account_summaries', { $gt: 1 }]), 'utf8').toString('base64url')],
    ['an empty json array', Buffer.from('[]', 'utf8').toString('base64url')],
    ['a cursor with a character outside the contract pattern', 'abc def'],
    ['a cursor of 600 characters', 'a'.repeat(600)],
  ])('invalid cursor: %s -> 400 common.invalid_cursor', async (_n, cursor) => {
    const o = await list({ cursor });
    const e = rejected(o, 'common.invalid_cursor');
    expect(e.code).toBe('common.invalid_cursor');
  }, T);

  it.each([
    ['party_kind', 'supplier'], ['party_kind', ''], ['party_kind', 'CREDIT_PARTY'], ['party_kind', ['credit_party', 'franchise']],
    ['limit', 0], ['limit', 201], ['limit', -1], ['limit', 1.5], ['limit', 'abc'],
    ['q', 'x'.repeat(81)], ['q', { a: 1 }],
    ['blocked_only', 'maybe'], ['outstanding_only', 'maybe'], ['blocked_only', 2],
  ])('bad %s=%j -> 400 common.validation_failed', async (key, value) => {
    rejected(await list({ [key]: value }));
  }, T);

  it('an unknown query key is refused (the contract has no other filter) and nothing leaks in the error', async () => {
    const e = rejected(await list({ tenant_id: TENANT_B }));
    expect(JSON.stringify(e.problem ?? e.details ?? e.message ?? '')).not.toContain(TENANT_B);
  }, T);

  it('a request body or header the contract does not define changes nothing', async () => {
    const tg = tag(); await party(TENANT_A, `Synthetic Body ${tg}`);
    const o = await fire(LIST, { ...req({ query: { q: tg } }), body: { party_kind: 'franchise' }, headers: { 'x-tenant-id': TENANT_B } } as any, { tenant: TENANT_A });
    expect(ok(o).data).toHaveLength(1);
  }, T);
});

describe('listAccountSummaries: tenant scope (done_when 2)', () => {
  it('another tenant: its parties and balances never appear in tenant A, and A parties never appear in B', async () => {
    const wa = await world('a'); const wb = await world('b'); const tg = tag();
    const a = await party(TENANT_A, `Synthetic Shared ${tg} A`); const b = await party(TENANT_B, `Synthetic Shared ${tg} B`);
    await book(wa, a, 'debit', 111);
    ok(await post(wb, { party_id: b, entry_type: 'debit', amount_paisa: 999_999 }, { tenant: wb.tenant }), 201);
    const asA = ok(await list({ q: tg })); const asB = ok(await list({ q: tg }, TENANT_B));
    expect(ids(asA)).toEqual([a]); expect(ids(asB)).toEqual([b]);
    expect(asA.data[0].outstanding_paisa).toBe(111);
    expect(JSON.stringify(asA)).not.toContain(b);
    expect(ok(await list({ q: tg, outstanding_only: true, blocked_only: false, limit: 200 })).data.map((r: any) => r.party_id)).not.toContain(b);
  }, T);

  it('a franchise of another tenant is not listed either, and the cursor of tenant B opens nothing in tenant A', async () => {
    const tg = tag();
    const fb = await franchise(TENANT_B, `Synthetic Foreign Franchise ${tg}`);
    for (let i = 0; i < 3; i++) await party(TENANT_B, `Synthetic Foreign ${tg} ${i}`);
    expect(ids(ok(await list({ q: tg, party_kind: 'franchise' }))), 'tenant A sees no foreign franchise').toEqual([]);
    const b1 = ok(await list({ q: tg, limit: 2 }, TENANT_B));
    expect(b1.page.next_cursor).toBeDefined();
    const asA = await list({ q: tg, limit: 2, cursor: b1.page.next_cursor }, TENANT_A);
    if (asA.error) rejected(asA, 'common.invalid_cursor'); else expect(ids(asA.reply!.body), 'a foreign cursor never yields foreign rows').not.toContain(fb);
  }, T);

  it('an empty tenant (no party, no entry) answers 200 with an empty list and the default limit, not 404 and not 500', async () => {
    const o = await fire(LIST, req({ query: {} }), { tenant: uid() });
    const b = ok(o);
    expect(b.data).toEqual([]);
    expect(b.page).toEqual({ limit: 50 });
    for (const q of [{ blocked_only: true }, { outstanding_only: true }, { party_kind: 'franchise' }, { q: 'anything' }, { limit: 200 }]) {
      expect(ok(await fire(LIST, req({ query: q }), { tenant: uid() })).data, JSON.stringify(q)).toEqual([]);
    }
  }, T);

  it('direct database truth: the number of rows the list can show for a tag equals the committed credit accounts of the tenant with that tag', async () => {
    const tg = tag();
    for (let i = 0; i < 4; i++) await party(TENANT_A, `Synthetic Truth ${tg} ${i}`);
    const truth = await superTx(async (tx) => (await tx.query('SELECT count(*)::int AS n FROM billing.credit_accounts WHERE tenant_id = $1 AND party_display_name LIKE $2', [TENANT_A, `%${tg}%`])).rows[0].n, TENANT_A);
    expect(ok(await list({ q: tg })).data).toHaveLength(truth);
  }, T);
});
