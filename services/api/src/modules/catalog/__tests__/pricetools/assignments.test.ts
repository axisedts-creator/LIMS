// T0B-PRICETOOLS-1 dated price list assignments over a real PG17 under RLS (done_when 5, 7): replacePriceListAssignments takes effective_from / effective_to, two assignments of one party never overlap
// (409 catalog.code_duplicate, nothing changed, whole call atomic, race safe), periods may touch or have gaps, and the list a party resolves on a date (quotePrices `at`) is deterministic.
// Credit parties stand for all three party kinds here (the DB trigger covers referrer and centre: db/tests/catalog/T0C-PRICETOOLS-1_price_list_tools.test.sql).
import { beforeAll, describe, expect, it } from 'vitest';
import { NONE, READ, SYS_ACTOR, T, TENANT_A, TENANT_B, detail, expectCode, mkList, mkParty, mkTests, ownerRows, pcall, pfails, publishedList, schemaErrors, superTx, uid, world, req, type TestRef } from './helpers.js';

let tests: TestRef[];
beforeAll(async () => {
  tests = await mkTests(await world(TENANT_A), 3);
  // Ruling 4: quotes fail closed with catalog.tax_config_missing without a tenant_default tax rule (contracts/errors.yaml:72): seed one synthetic rule for TENANT_A (only when none exists).
  await superTx(async (tx) => {
    const has = (await tx.query(`SELECT 1 FROM catalog.tax_rules WHERE tenant_id = $1 AND scope = 'tenant_default' LIMIT 1`, [TENANT_A])).rows.length;
    if (!has) await tx.query(`INSERT INTO catalog.tax_rules (id, tenant_id, scope, vat_treatment, effective_from, created_by, updated_by) VALUES ($1, $2, 'tenant_default', 'exempt', '2000-01-01T00:00:00Z', $3, $3)`, [uid(), TENANT_A, SYS_ACTOR]);
  }, TENANT_A);
}, T);

const BASE = Date.now();                                    // one fixed origin: day(20) is the SAME instant everywhere, so "touching" really touches
const day = (n: number) => new Date(BASE + n * 86_400_000).toISOString();
/** replace the owners (and the period) of a list; If-Match = the list's current version */
async function replace(listId: string, owners: string[], period: { effective_from?: string; effective_to?: string } = {}, o: { tenant?: string; grants?: readonly string[] } = {}) {
  const d = await detail(listId, o.tenant ?? TENANT_A);
  return pcall('replacePriceListAssignments', req({ params: { price_list_id: listId }, headers: { 'if-match': `"${d.version}"` }, body: { owner_ids: owners, ...period } }), o);
}
const replaceFails = async (listId: string, owners: string[], period: { effective_from?: string; effective_to?: string } = {}, o: { tenant?: string; grants?: readonly string[] } = {}) => {
  const d = await detail(listId, o.tenant ?? TENANT_A);
  return pfails('replacePriceListAssignments', req({ params: { price_list_id: listId }, headers: { 'if-match': `"${d.version}"` }, body: { owner_ids: owners, ...period } }), o);
};
const rowsOf = (listId: string) => ownerRows('catalog.price_list_assignments', 'price_list_id = $1 ORDER BY effective_from', [listId]);

describe('dated assignments', () => {
  it('effective_from / effective_to are stored and returned (response is a PriceList; the detail carries the dates); effective_to absent = open ended', { timeout: T }, async () => {
    const party = await mkParty(); const { list } = await mkList(TENANT_A, { party, noParty: true });
    const r = await replace(list.id, [party.id], { effective_from: day(10), effective_to: day(20) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(schemaErrors('PriceList', r.body)).toEqual([]);
    const a = (await detail(list.id)).assignments.find((x: any) => x.owner_id === party.id);
    expect(new Date(a.effective_from).getTime()).toBe(new Date(day(10)).getTime());
    expect(new Date(a.effective_to).getTime()).toBe(new Date(day(20)).getTime());
    const open = await mkList(TENANT_A, { noParty: true }); const p2 = await mkParty();
    await replace(open.list.id, [p2.id], { effective_from: day(1) });
    expect((await detail(open.list.id)).assignments[0].effective_to, 'open ended').toBeUndefined();
    expect((await rowsOf(open.list.id))[0].effective_to).toBeNull();
  });
  it('without effective_from the period starts now', { timeout: T }, async () => {
    const party = await mkParty(); const { list } = await mkList(TENANT_A, { noParty: true });
    await replace(list.id, [party.id]);
    const row = (await rowsOf(list.id))[0];
    expect(Math.abs(new Date(row.effective_from).getTime() - Date.now())).toBeLessThan(60_000);
  });
  it('one party may hold several lists over time: touching periods [a,b) [b,open) and a period after a gap are accepted', { timeout: T }, async () => {
    const party = await mkParty();
    const l1 = await mkList(TENANT_A, { noParty: true }); const l2 = await mkList(TENANT_A, { noParty: true }); const l3 = await mkList(TENANT_A, { noParty: true });
    expect((await replace(l1.list.id, [party.id], { effective_from: day(10), effective_to: day(20) })).status).toBe(200);
    expect((await replace(l2.list.id, [party.id], { effective_from: day(20), effective_to: day(30) })).status, 'touching').toBe(200);
    expect((await replace(l3.list.id, [party.id], { effective_from: day(40) })).status, 'after a gap, open ended').toBe(200);
  });
  it('an overlap is 409 catalog.code_duplicate and NOTHING changes (including the other owners of the same call: the call is atomic)', { timeout: T }, async () => {
    const p1 = await mkParty(); const p2 = await mkParty();
    const l1 = await mkList(TENANT_A, { noParty: true }); const l2 = await mkList(TENANT_A, { noParty: true });
    await replace(l1.list.id, [p1.id], { effective_from: day(10), effective_to: day(30) });
    const before = await rowsOf(l2.list.id); const detailBefore = await detail(l2.list.id);
    expectCode(await replaceFails(l2.list.id, [p2.id, p1.id], { effective_from: day(20), effective_to: day(40) }), 'catalog.code_duplicate', 409);
    expect(await rowsOf(l2.list.id), 'p2 was not assigned either').toEqual(before);
    expect((await detail(l2.list.id)).version, 'list version unchanged').toBe(detailBefore.version);
  });
  it('open ended periods overlap everything after them; the same list may re-set its own period', { timeout: T }, async () => {
    const p = await mkParty(); const l1 = await mkList(TENANT_A, { noParty: true }); const l2 = await mkList(TENANT_A, { noParty: true });
    await replace(l1.list.id, [p.id], { effective_from: day(10) });
    expectCode(await replaceFails(l2.list.id, [p.id], { effective_from: day(500), effective_to: day(501) }), 'catalog.code_duplicate', 409);
    expect((await replace(l1.list.id, [p.id], { effective_from: day(10), effective_to: day(15) })).status, 're-setting its own period').toBe(200);
    expect((await replace(l2.list.id, [p.id], { effective_from: day(15) })).status, 'free after the shortened period').toBe(200);
  });
  it('an empty or inverted period (effective_to <= effective_from) is refused (400 / 422), never a 500, nothing changes', { timeout: T }, async () => {
    const p = await mkParty(); const { list } = await mkList(TENANT_A, { noParty: true });
    for (const period of [{ effective_from: day(10), effective_to: day(10) }, { effective_from: day(10), effective_to: day(5) }]) {
      const e = await replaceFails(list.id, [p.id], period);
      expect([400, 422], `${e.code}`).toContain(e.statusCode);
    }
    expect(await rowsOf(list.id)).toEqual([]);
  });
  it('CONCURRENCY: two lists given the same party and the same period at once: exactly one wins, the loser is a clean 409 catalog.code_duplicate', { timeout: T }, async () => {
    const p = await mkParty(); const l1 = await mkList(TENANT_A, { noParty: true }); const l2 = await mkList(TENANT_A, { noParty: true });
    const period = { effective_from: day(10), effective_to: day(30) };
    const res = await Promise.allSettled([replace(l1.list.id, [p.id], period), replace(l2.list.id, [p.id], period)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lose = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect([lose.reason?.code, lose.reason?.statusCode]).toEqual(['catalog.code_duplicate', 409]);
    expect((await rowsOf(l1.list.id)).length + (await rowsOf(l2.list.id)).length).toBe(1);
  });
  it('permission and isolation: 403 without catalog.price_list.manage; another tenant\'s list is the same 404 as an unknown id', { timeout: T }, async () => {
    const p = await mkParty(); const { list } = await mkList(TENANT_A, { noParty: true });
    for (const grants of [NONE, READ]) expectCode(await replaceFails(list.id, [p.id], {}, { grants }), 'auth.forbidden', 403);
    const e1 = await pfails('replacePriceListAssignments', req({ params: { price_list_id: list.id }, headers: { 'if-match': '"1"' }, body: { owner_ids: [] } }), { tenant: TENANT_B });
    const e2 = await pfails('replacePriceListAssignments', req({ params: { price_list_id: uid() }, headers: { 'if-match': '"1"' }, body: { owner_ids: [] } }), { tenant: TENANT_B });
    expectCode(e1, 'common.not_found', 404); expect([e1.code, e1.statusCode, e1.detail]).toEqual([e2.code, e2.statusCode, e2.detail]);
    expect(await rowsOf(list.id)).toEqual([]);
  });
});

describe('the price list a party resolves on a date is deterministic (quotePrices `at`)', () => {
  /** party with list1 for [+10d,+20d) at 1000 paisa and list2 for [+20d, open) at 2000 paisa, both versions published now */
  async function twoPeriods() {
    const party = await mkParty();
    const l1 = await publishedList([{ id: tests[0]!.id, paisa: 1000 }], { list: (await mkList(TENANT_A, { noParty: true })).list });
    const l2 = await publishedList([{ id: tests[0]!.id, paisa: 2000 }], { list: (await mkList(TENANT_A, { noParty: true })).list });
    expect((await replace(l1.list.id, [party.id], { effective_from: day(10), effective_to: day(20) })).status).toBe(200);
    expect((await replace(l2.list.id, [party.id], { effective_from: day(20) })).status).toBe(200);
    return { party, l1: l1.list.id as string, l2: l2.list.id as string };
  }
  const quote = async (partyId: string, at: string) => (await pcall('quotePrices', req({ body: { items: [{ orderable_id: tests[0]!.id, priority: 'routine' }], context: { credit_party_id: partyId }, at } }))).body.quotes[0];
  it('inside period one the party gets list one, inside period two list two; the boundary instant belongs to the LATER period (half open)', { timeout: T }, async () => {
    const { party, l1, l2 } = await twoPeriods();
    const q1 = await quote(party.id, day(15)); expect([q1.price_list_id, q1.unit_price.amount_paisa, q1.source]).toEqual([l1, 1000, 'credit_party']);
    const qb = await quote(party.id, day(20)); expect(qb.price_list_id, 'at the boundary instant').toBe(l2);
    const qa = await quote(party.id, new Date(new Date(day(20)).getTime() - 1).toISOString()); expect(qa.price_list_id, 'one ms before').toBe(l1);
    const q2 = await quote(party.id, day(30)); expect([q2.price_list_id, q2.unit_price.amount_paisa]).toEqual([l2, 2000]);
  });
  it('before the first period neither of the two lists is used', { timeout: T }, async () => {
    const { party, l1, l2 } = await twoPeriods();
    let id: string | undefined;
    try { id = (await quote(party.id, day(5)))?.price_list_id; } catch { id = undefined; }
    expect([l1, l2]).not.toContain(id);
  });
  it('the same question asked 8 times at once gets the same list every time', { timeout: T }, async () => {
    const { party, l1 } = await twoPeriods();
    const answers = await Promise.all(Array.from({ length: 8 }, () => quote(party.id, day(15))));
    expect(new Set(answers.map((a) => `${a.price_list_id}|${a.unit_price.amount_paisa}`))).toEqual(new Set([`${l1}|1000`]));
  });
});
