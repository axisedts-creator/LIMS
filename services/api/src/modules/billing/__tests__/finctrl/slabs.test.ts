// T0B-FINCTRL-1 (LD-321, LD-310) done_when (2) SLABS + (7) audit / integer money + (8) tenant isolation and concurrency on slab creation.
// resolveDiscountSlab returns the ONE active slab of the party whose amount range [from, to) holds the bill amount and whose dates [effective_from, effective_to] hold the day;
// an overlap is refused in the DOMAIN layer (400 common.validation_failed with a field path, no INSERT reaches the database); basis points 0..10000; amounts integer paisa.
// Real PG17 under RLS. Fails now: the 16 operations are pending (no handler).
// PINS (CONV): an unknown / foreign party -> 404 (create, resolve); the race loser of two overlapping creates gets the SAME domain answer (400 + path), never a raw 23505 / 500.
import { describe, expect, it } from 'vitest';
import { moneyIsInteger, notFound, rejected } from '../accounts/helpers.js';
import { T, TENANT_A, TENANT_B, dbRows, fire, listSlabs, mkSlab, offSlab, ok, req, resolve, rowAudit, slabBody, updSlab, uid, world } from './kit.js';

const paths = (e: any): string[] => (e.errors ?? []).map((x: any) => x.path);
const slabInserts = (o: { writes: string[] }) => o.writes.filter((s) => /^\s*insert/i.test(s) && /party_discount_slab/i.test(s));
const activeOf = (partyId: string) => dbRows(TENANT_A, `SELECT * FROM billing.party_discount_slab WHERE tenant_id = $1 AND party_id = $2 AND is_active`, [partyId]);

describe('createPartyDiscountSlab', () => {
  it('201: the slab as the contract shapes it, integer paisa, version 1, active, one INSERT audit row', async () => {
    const w = await world('a');
    const s = ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 0, amount_to_paisa: 100_000, discount_bp: 500, effective_from: '2026-01-01', effective_to: '2026-12-31' })), 201);
    expect(s).toMatchObject({ party_kind: 'credit_party', party_id: w.partyId, amount_from_paisa: 0, amount_to_paisa: 100_000, discount_bp: 500, effective_from: '2026-01-01', effective_to: '2026-12-31', is_active: true, version: 1 });
    expect(Object.keys(s).sort()).toEqual(['amount_from_paisa', 'amount_to_paisa', 'created_at', 'discount_bp', 'effective_from', 'effective_to', 'id', 'is_active', 'party_id', 'party_kind', 'updated_at', 'version']);
    expect(moneyIsInteger(s)).toEqual([]);
    expect(await rowAudit(w.tenant, 'party_discount_slab', s.id)).toEqual(['INSERT']);
  }, T);

  it('an open ended slab has no effective_to; bp 0 and bp 10000 are both valid', async () => {
    const w = await world('a');
    const a = ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 0, amount_to_paisa: 10, discount_bp: 0 })), 201);
    const b = ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 10, amount_to_paisa: 20, discount_bp: 10_000 })), 201);
    expect(a).not.toHaveProperty('effective_to');
    expect([a.discount_bp, b.discount_bp]).toEqual([0, 10_000]);
  }, T);

  it.each<[string, Record<string, unknown>, string]>([
    ['bp above 10000', { discount_bp: 10_001 }, '/discount_bp'],
    ['negative bp', { discount_bp: -1 }, '/discount_bp'],
    ['fractional bp', { discount_bp: 12.5 }, '/discount_bp'],
    ['bp as a string', { discount_bp: '500' }, '/discount_bp'],
    ['negative amount_from', { amount_from_paisa: -1 }, '/amount_from_paisa'],
    ['fractional amount_from (a float is never money)', { amount_from_paisa: 10.5 }, '/amount_from_paisa'],
    ['amount_to as a string (money never travels as a string)', { amount_to_paisa: '1000' }, '/amount_to_paisa'],
    ['amount_to equal to amount_from (empty range)', { amount_from_paisa: 500, amount_to_paisa: 500 }, '/amount_to_paisa'],
    ['amount_to below amount_from', { amount_from_paisa: 900, amount_to_paisa: 100 }, '/amount_to_paisa'],
    ['amount_to above 2^53-1', { amount_to_paisa: Number.MAX_SAFE_INTEGER + 2 }, '/amount_to_paisa'],
    ['effective_to before effective_from', { effective_from: '2026-06-01', effective_to: '2026-05-31' }, '/effective_to'],
    ['effective_from not a date', { effective_from: '2026-02-30' }, '/effective_from'],
    ['unknown party_kind', { party_kind: 'patient' }, '/party_kind'],
    ['party_id not a uuid', { party_id: 'x' }, '/party_id'],
    ['unknown field (mass assignment)', { is_active: false }, '/is_active'],
  ])('refuses %s with 400 and a field path, stores nothing', async (_n, over, path) => {
    const w = await world('a');
    const e = rejected(await mkSlab(w.tenant, slabBody(w.partyId, over)));
    expect(paths(e), JSON.stringify(e.errors)).toContain(path);
    expect(await activeOf(w.partyId)).toEqual([]);
  }, T);

  it('an unknown party and another tenant\'s party -> 404 (existence is not confirmed)', async () => {
    const a = await world('a'), b = await world('b');
    notFound(await mkSlab(a.tenant, slabBody(uid())));
    notFound(await mkSlab(a.tenant, slabBody(b.partyId)));
    expect(await dbRows(TENANT_B, `SELECT 1 FROM billing.party_discount_slab WHERE tenant_id = $1 AND party_id = $2`, [b.partyId])).toEqual([]);
  }, T);
});

describe('overlap: refused in the domain layer with a field path, before the database constraint can fire', () => {
  it('the same amount range on overlapping dates -> 400 + path, and no INSERT statement was even sent', async () => {
    const w = await world('a');
    ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 1000, amount_to_paisa: 5000, effective_from: '2026-01-01', effective_to: '2026-12-31' })), 201);
    const o = await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 4999, amount_to_paisa: 9000, effective_from: '2026-12-31' }));
    const e = rejected(o);
    expect(paths(e).some((p) => /^\/(amount_from_paisa|amount_to_paisa|effective_from|effective_to)$/.test(p)), JSON.stringify(e.errors)).toBe(true);
    expect(slabInserts(o), 'the domain layer must refuse before the INSERT (the DB trigger is only the backstop)').toEqual([]);
    expect(String(e.message) + JSON.stringify(e.errors)).not.toMatch(/23505|party_discount_slab__no_overlap|duplicate key/i);
    expect(await activeOf(w.partyId)).toHaveLength(1);
  }, T);

  it('a slab inside another, and an open ended slab against a dated one, overlap too', async () => {
    const w = await world('a');
    ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 0, amount_to_paisa: 10_000 })), 201);                    // open ended since 2026-01-01
    rejected(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 2000, amount_to_paisa: 3000, effective_from: '2031-05-05', effective_to: '2031-05-06' })));
    expect(await activeOf(w.partyId)).toHaveLength(1);
  }, T);

  it('half open amounts and inclusive dates: touching ranges do NOT overlap, a shared date DOES', async () => {
    const w = await world('a');
    ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 0, amount_to_paisa: 1000, effective_from: '2026-01-01', effective_to: '2026-06-30' })), 201);
    ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 1000, amount_to_paisa: 2000, effective_from: '2026-01-01', effective_to: '2026-06-30' })), 201);   // amount_to is excluded
    ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 0, amount_to_paisa: 1000, effective_from: '2026-07-01', effective_to: '2026-12-31' })), 201);   // next day
    rejected(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 0, amount_to_paisa: 1000, effective_from: '2026-12-31', effective_to: '2027-03-01' }))); // 2026-12-31 is shared
    expect(await activeOf(w.partyId)).toHaveLength(3);
  }, T);

  it('another party, and an inactive slab, never block a creation', async () => {
    const a = await world('a'), b = await world('a');
    ok(await mkSlab(a.tenant, slabBody(a.partyId)), 201);
    ok(await mkSlab(b.tenant, slabBody(b.partyId)), 201);                                                                          // same ranges, other party
    const old = ok(await mkSlab(a.tenant, slabBody(a.partyId, { amount_from_paisa: 100_000, amount_to_paisa: 200_000 })), 201);
    ok(await offSlab(a.tenant, old.id, 1));
    ok(await mkSlab(a.tenant, slabBody(a.partyId, { amount_from_paisa: 150_000, amount_to_paisa: 250_000 })), 201);                 // overlaps only the inactive one
  }, T);

  it('an update that would overlap is refused the same way; an update that does not is applied (version + 1, audited)', async () => {
    const w = await world('a');
    const s1 = ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 0, amount_to_paisa: 1000 })), 201);
    const s2 = ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 1000, amount_to_paisa: 2000 })), 201);
    const e = rejected(await updSlab(w.tenant, s2.id, 1, { amount_from_paisa: 999 }));
    expect(paths(e).length).toBeGreaterThan(0);
    const u = ok(await updSlab(w.tenant, s1.id, 1, { discount_bp: 750, amount_to_paisa: 900 }));
    expect(u).toMatchObject({ id: s1.id, discount_bp: 750, amount_to_paisa: 900, amount_from_paisa: 0, version: 2, party_id: w.partyId });
    expect(await rowAudit(w.tenant, 'party_discount_slab', s1.id)).toEqual(['INSERT', 'UPDATE']);
  }, T);
});

describe('concurrency: two simultaneous overlapping slabs, exactly one wins', () => {
  it('2 racers on the same range -> one 201, one domain refusal (never a 500 / raw constraint error), one active row', async () => {
    for (let round = 0; round < 3; round++) {
      const w = await world('a');
      const outs = await Promise.all([mkSlab(w.tenant, slabBody(w.partyId)), mkSlab(w.tenant, slabBody(w.partyId, { discount_bp: 900 }))]);
      const won = outs.filter((o) => o.reply?.status === 201), lost = outs.filter((o) => o.reply === undefined);
      expect(won, `round ${round}`).toHaveLength(1);
      expect(lost, `round ${round}`).toHaveLength(1);
      rejected(lost[0]!);
      expect(await activeOf(w.partyId), `round ${round}`).toHaveLength(1);
    }
  }, T * 2);

  it('8 racers with staggered overlapping ranges -> exactly one winner for the group', async () => {
    const w = await world('a');
    const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: i * 100, amount_to_paisa: i * 100 + 1000, discount_bp: 100 + i }))));
    expect(outs.filter((o) => o.reply?.status === 201)).toHaveLength(1);
    for (const o of outs.filter((x) => x.reply === undefined)) rejected(o);
    expect(await activeOf(w.partyId)).toHaveLength(1);
  }, T * 2);

  it('disjoint slabs created at the same moment all succeed (the lock is per party, not a global refusal)', async () => {
    const w = await world('a');
    const outs = await Promise.all(Array.from({ length: 5 }, (_, i) => mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: i * 1000, amount_to_paisa: (i + 1) * 1000 }))));
    for (const o of outs) ok(o, 201);
    expect(await activeOf(w.partyId)).toHaveLength(5);
  }, T * 2);

  it('an update racing a create for the same range: at most one active slab holds it', async () => {
    const w = await world('a');
    const base = ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 5000, amount_to_paisa: 6000 })), 201);
    const outs = await Promise.all([mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 0, amount_to_paisa: 1500 })), updSlab(w.tenant, base.id, 1, { amount_from_paisa: 1000, amount_to_paisa: 2000 })]);
    expect(outs.filter((o) => o.reply && o.reply.status < 300)).toHaveLength(1);
    for (const o of outs.filter((x) => x.reply === undefined)) rejected(o);
  }, T * 2);
});

describe('updatePartyDiscountSlab / deactivatePartyDiscountSlab', () => {
  it('missing If-Match -> 428 common.precondition_required; stale version -> 409 common.version_conflict; nothing changed', async () => {
    const w = await world('a');
    const s = ok(await mkSlab(w.tenant, slabBody(w.partyId)), 201);
    rejected(await updSlab(w.tenant, s.id, 'none', { discount_bp: 1 }), 'common.precondition_required');
    rejected(await updSlab(w.tenant, s.id, 7, { discount_bp: 1 }), 'common.version_conflict');
    rejected(await offSlab(w.tenant, s.id, 'none'), 'common.precondition_required');
    rejected(await offSlab(w.tenant, s.id, 3), 'common.version_conflict');
    expect(Number((await activeOf(w.partyId))[0].discount_bp)).toBe(500);
  }, T);

  it('an empty patch, bp 10001 and a party change are 400; party_kind / party_id never change', async () => {
    const w = await world('a'), other = await world('a');
    const s = ok(await mkSlab(w.tenant, slabBody(w.partyId)), 201);
    rejected(await updSlab(w.tenant, s.id, 1, {}));
    rejected(await updSlab(w.tenant, s.id, 1, { discount_bp: 10_001 }));
    rejected(await updSlab(w.tenant, s.id, 1, { party_id: other.partyId }));
    rejected(await updSlab(w.tenant, s.id, 1, { amount_to_paisa: '5' }));
  }, T);

  it('deactivate: is_active false, version + 1, audited, the slab no longer resolves, and its range is free again', async () => {
    const w = await world('a');
    const s = ok(await mkSlab(w.tenant, slabBody(w.partyId)), 201);
    expect(ok(await resolve(w.tenant, w.partyId, 50_000, '2026-11-17')).matched).toBe(true);
    const d = ok(await offSlab(w.tenant, s.id, 1));
    expect(d).toMatchObject({ id: s.id, is_active: false, version: 2 });
    expect(await rowAudit(w.tenant, 'party_discount_slab', s.id)).toEqual(['INSERT', 'UPDATE']);
    expect(ok(await resolve(w.tenant, w.partyId, 50_000, '2026-11-17'))).toEqual({ matched: false });
    ok(await mkSlab(w.tenant, slabBody(w.partyId, { discount_bp: 900 })), 201);
  }, T);

  it('an unknown id -> 404', async () => {
    const w = await world('a');
    notFound(await updSlab(w.tenant, uid(), 1, { discount_bp: 1 }));
    notFound(await offSlab(w.tenant, uid(), 1));
  }, T);
});

describe('resolveDiscountSlab: the one active slab holding the amount and the day', () => {
  async function ladder() {
    const w = await world('a');
    const low = ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 0, amount_to_paisa: 100_000, discount_bp: 500, effective_from: '2026-01-01', effective_to: '2026-12-31' })), 201);
    const high = ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: 100_000, amount_to_paisa: 500_000, discount_bp: 800, effective_from: '2026-01-01', effective_to: '2026-12-31' })), 201);
    return { w, low, high };
  }

  it('amount range is half open: from included, to excluded; above the last slab there is no match', async () => {
    const { w, low, high } = await ladder();
    const at = async (amount: number) => ok(await resolve(w.tenant, w.partyId, amount, '2026-06-15'));
    expect(await at(0)).toMatchObject({ matched: true, discount_bp: 500, slab: { id: low.id } });
    expect(await at(99_999)).toMatchObject({ matched: true, discount_bp: 500, slab: { id: low.id } });
    expect(await at(100_000)).toMatchObject({ matched: true, discount_bp: 800, slab: { id: high.id } });
    expect(await at(499_999)).toMatchObject({ matched: true, discount_bp: 800 });
    expect(await at(500_000)).toEqual({ matched: false });
    expect(await at(9_007_199_254_740_991)).toEqual({ matched: false });
    expect(moneyIsInteger(await at(5))).toEqual([]);
  }, T);

  it('dates are inclusive: the last day matches, the day before the first and the day after the last do not', async () => {
    const { w } = await ladder();
    expect(ok(await resolve(w.tenant, w.partyId, 10, '2026-01-01')).matched).toBe(true);
    expect(ok(await resolve(w.tenant, w.partyId, 10, '2026-12-31')).matched).toBe(true);
    expect(ok(await resolve(w.tenant, w.partyId, 10, '2025-12-31'))).toEqual({ matched: false });
    expect(ok(await resolve(w.tenant, w.partyId, 10, '2027-01-01'))).toEqual({ matched: false });
  }, T);

  it('without on_date the day is today in the tenant time zone (2026-11-17 at the kit clock)', async () => {
    const w = await world('a');
    ok(await mkSlab(w.tenant, slabBody(w.partyId, { effective_from: '2026-11-17', effective_to: '2026-11-17' })), 201);
    expect(ok(await resolve(w.tenant, w.partyId, 10)).matched).toBe(true);
    const later = await world('a');
    ok(await mkSlab(later.tenant, slabBody(later.partyId, { effective_from: '2026-11-18' })), 201);
    expect(ok(await resolve(later.tenant, later.partyId, 10))).toEqual({ matched: false });
  }, T);

  it('an inactive slab and another party\'s slab never match; the bill amount may arrive as a number or a query string', async () => {
    const { w, low } = await ladder();
    const other = await world('a');
    expect(ok(await resolve(w.tenant, other.partyId, 10, '2026-06-15'))).toEqual({ matched: false });
    expect(ok(await resolve(w.tenant, w.partyId, 10 as unknown as string, '2026-06-15')).matched).toBe(true);
    ok(await offSlab(w.tenant, low.id, 1));
    expect(ok(await resolve(w.tenant, w.partyId, 10, '2026-06-15'))).toEqual({ matched: false });
  }, T);

  it.each<[string, Record<string, unknown>]>([
    ['no amount', { amount_paisa: undefined }], ['negative amount', { amount_paisa: '-1' }], ['fractional amount', { amount_paisa: '10.5' }], ['amount in words', { amount_paisa: 'ten' }],
    ['amount above 2^53-1', { amount_paisa: '9007199254740992' }], ['bad date', { on_date: '2026-13-01' }], ['unknown party_kind', { party_kind: 'patient' }], ['unknown param', { tenant_id: TENANT_A }],
  ])('refuses %s with 400', async (_n, over) => {
    const w = await world('a');
    const query: Record<string, unknown> = { party_kind: 'credit_party', party_id: w.partyId, amount_paisa: '100', ...over };
    for (const k of Object.keys(query)) if (query[k] === undefined) delete query[k];
    rejected(await fire('resolveDiscountSlab', req({ query }), { tenant: w.tenant }));
  }, T);

  it('an unknown party -> 404', async () => {
    notFound(await resolve(TENANT_A, uid(), 100, '2026-06-15'));
  }, T);
});

describe('listPartyDiscountSlabs', () => {
  it('filters by party and activity, newest page first stable, integer money, no foreign rows', async () => {
    const w = await world('a');
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(ok(await mkSlab(w.tenant, slabBody(w.partyId, { amount_from_paisa: i * 1000, amount_to_paisa: (i + 1) * 1000, discount_bp: i })), 201));
    ok(await offSlab(w.tenant, rows[4].id, 1));
    const all = ok(await listSlabs(w.tenant, { party_kind: 'credit_party', party_id: w.partyId }));
    expect(all.data.map((x: any) => x.id).sort()).toEqual(rows.map((x) => x.id).sort());
    expect(ok(await listSlabs(w.tenant, { party_id: w.partyId, is_active: 'false' })).data.map((x: any) => x.id)).toEqual([rows[4].id]);
    expect(ok(await listSlabs(w.tenant, { party_id: w.partyId, is_active: 'true' })).data).toHaveLength(4);
    expect(moneyIsInteger(all)).toEqual([]);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const p = ok(await listSlabs(w.tenant, { party_id: w.partyId, limit: '2', ...(cursor ? { cursor } : {}) }));
      seen.push(...p.data.map((x: any) => x.id));
      cursor = p.page.next_cursor;
      if (!cursor) break;
    }
    expect(seen.sort(), 'paging yields every row once').toEqual(rows.map((x) => x.id).sort());
  }, T);

  it('tenant isolation: B cannot read, resolve against, update or deactivate A\'s slabs (404) and never sees them in a list', async () => {
    const a = await world('a'), b = await world('b');
    const s = ok(await mkSlab(a.tenant, slabBody(a.partyId)), 201);
    ok(await mkSlab(b.tenant, slabBody(b.partyId, { discount_bp: 333 })), 201);
    expect(ok(await listSlabs(b.tenant, { party_id: a.partyId })).data).toEqual([]);
    expect(JSON.stringify(ok(await listSlabs(b.tenant, {})))).not.toContain(s.id);
    notFound(await resolve(b.tenant, a.partyId, 10, '2026-06-15'));
    notFound(await updSlab(b.tenant, s.id, 1, { discount_bp: 1 }));
    notFound(await offSlab(b.tenant, s.id, 1));
    expect(Number((await activeOf(a.partyId))[0].discount_bp)).toBe(500);
    expect(ok(await resolve(a.tenant, a.partyId, 10, '2026-06-15')).discount_bp).toBe(500);
  }, T);
});
