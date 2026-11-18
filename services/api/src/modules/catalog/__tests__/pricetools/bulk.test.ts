// T0B-PRICETOOLS-1 bulkUpdatePriceListDraft + copyPriceList over a real PG17 under RLS (done_when 2, 4, 6, 7): integer arithmetic only, round half up in paisa, the four rounding modes, results only in a DRAFT,
// a result below 0 (or above the 999999999 ceiling) refuses the WHOLE request, tenant isolation, permission, races.
// PINNED: bulk result counts: unchanged_count = items of the version that did not change (outside the scope or same value); status 422 for a request the service refuses (code not pinned).
import { beforeAll, describe, expect, it } from 'vitest';
import { NONE, READ, T, TENANT_A, TENANT_B, auditOf, bulkOf, copyOf, detail, draftOf, expectCode, itemRows, listSnapshot, mkList, mkTest, mkTests, pfails, percentPaisa, priceMap, publishedList, putItems, roundTo,
  schemaErrors, uid, versionRows, world, req, type TestRef } from './helpers.js';
import type { World } from '../testmgmt/helpers.js';

let w: World; let tests: TestRef[]; let dept2Test: TestRef;
beforeAll(async () => { w = await world(TENANT_A); tests = await mkTests(w, 16); const t = await mkTest(w, { department_id: w.dept2.id, tags: undefined }); dept2Test = { id: t.id, code: t.code }; }, T);

/** a list with an open draft holding `prices` (by index into `tests`) */
async function draftWith(prices: Array<[number, number]>): Promise<{ list: any; draftId: string }> {
  const { list } = await mkList(); const dr = await draftOf(list.id);
  await putItems(dr.id, prices.map(([i, paisa]) => ({ id: tests[i]!.id, paisa })));
  return { list, draftId: dr.id };
}
const err422 = async (versionId: string, body: object) => { const e = await pfails('bulkUpdatePriceListDraft', req({ params: { price_list_version_id: versionId }, headers: { 'idempotency-key': uid() }, body })); expect(e.statusCode, `${e.code}`).toBe(422); return e; };

describe('bulk update: integer arithmetic, round half up in paisa, the rounding modes', () => {
  const CASES: Array<[number, string, number | undefined, number | undefined, string, number]> = [
    // paisa, change_kind, percent_bp, amount_paisa, rounding, expected
    [1005, 'percent', 1000, undefined, 'none', 1106],        // 1105.5 -> half up
    [1005, 'percent', -1000, undefined, 'none', 905],        // 904.5 -> half up
    [3, 'percent', 5000, undefined, 'none', 5],              // 4.5 -> 5
    [1, 'percent', 5000, undefined, 'none', 2],              // 1.5 -> 2
    [29, 'percent', 1000, undefined, 'none', 32],            // 31.9 -> 32 (float trap territory)
    [5050, 'percent', 0, undefined, 'nearest_rupee', 5100],  // 50.50 rupees -> 51
    [5049, 'percent', 0, undefined, 'nearest_rupee', 5000],
    [1250, 'percent', 0, undefined, 'nearest_5', 1500],      // 12.50 rupees -> 15 (half up)
    [1249, 'percent', 0, undefined, 'nearest_5', 1000],
    [1500, 'percent', 0, undefined, 'nearest_10', 2000],     // 15 rupees -> 20 (half up)
    [1499, 'percent', 0, undefined, 'nearest_10', 1000],
    [1005, 'percent', 1000, undefined, 'nearest_rupee', 1100], // 1106 paisa -> 11 rupees
    [1005, 'fixed_amount', undefined, 500, 'none', 1505],
    [1005, 'fixed_amount', undefined, -5, 'none', 1000],
    [1005, 'fixed_amount', undefined, -1005, 'none', 0],     // exactly 0 is allowed
    [123456789, 'percent', 1234, undefined, 'none', percentPaisa(123456789, 1234)],
    [999999490, 'percent', 0, undefined, 'nearest_10', 999999000],
  ];
  it.each(CASES)('price %i paisa, %s bp=%s amount=%s rounding=%s -> %i', { timeout: T }, async (paisa, kind, bp, amt, rounding, expected) => {
    const { draftId } = await draftWith([[0, paisa], [1, 7777]]);
    const r = await bulkOf(draftId, { change_kind: kind, ...(bp !== undefined ? { percent_bp: bp } : {}), ...(amt !== undefined ? { amount_paisa: amt } : {}), rounding, scope: 'listed_tests', orderable_ids: [tests[0]!.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(schemaErrors('PriceListBulkUpdateResult', r.body)).toEqual([]);
    const pm = await priceMap(draftId);
    expect(pm[tests[0]!.code]).toBe(expected);
    expect(pm[tests[1]!.code], 'an item outside the scope is untouched').toBe(7777);
    expect(r.body.price_list_version_id).toBe(draftId);
    expect(r.body.changed_count + r.body.unchanged_count, 'all items of the version').toBe(2);
    expect(r.body.changed_count).toBe(expected === paisa ? 0 : 1);
  });
  it('the 10 % rise of a whole list matches an independent BigInt computation for every price (scope all)', { timeout: T }, async () => {
    const prices: Array<[number, number]> = [[0, 1005], [1, 29], [2, 99999], [3, 123456], [4, 5], [5, 87654321]];
    const { draftId } = await draftWith(prices);
    expect((await bulkOf(draftId, { change_kind: 'percent', percent_bp: 1000, rounding: 'none', scope: 'all' })).status).toBe(200);
    const pm = await priceMap(draftId);
    for (const [i, p] of prices) expect(pm[tests[i]!.code], `${p}`).toBe(percentPaisa(p, 1000));
  });
  it('scope department: only the tests of that department change; scope listed_tests: only the listed ones', { timeout: T }, async () => {
    const { list } = await mkList(); const dr = await draftOf(list.id);
    await putItems(dr.id, [{ id: tests[0]!.id, paisa: 1000 }, { id: dept2Test.id, paisa: 1000 }, { id: tests[1]!.id, paisa: 1000 }]);
    const r = await bulkOf(dr.id, { change_kind: 'percent', percent_bp: 1000, rounding: 'none', scope: 'department', department_id: w.dept2.id });
    expect(r.body).toMatchObject({ changed_count: 1, unchanged_count: 2 });
    let pm = await priceMap(dr.id);
    expect([pm[dept2Test.code], pm[tests[0]!.code], pm[tests[1]!.code]]).toEqual([1100, 1000, 1000]);
    await bulkOf(dr.id, { change_kind: 'fixed_amount', amount_paisa: 50, rounding: 'none', scope: 'listed_tests', orderable_ids: [tests[0]!.id, tests[1]!.id] });
    pm = await priceMap(dr.id);
    expect([pm[tests[0]!.code], pm[tests[1]!.code], pm[dept2Test.code]]).toEqual([1050, 1050, 1100]);
  });
});

describe('bulk update refusals change NOTHING (whole request refused)', () => {
  it('one result below 0 refuses the whole request with 422: every other price is unchanged too', { timeout: T }, async () => {
    const { list, draftId } = await draftWith([[0, 100], [1, 6000]]);
    const before = await listSnapshot(list.id);
    await err422(draftId, { change_kind: 'fixed_amount', amount_paisa: -500, rounding: 'none', scope: 'all' });
    expect(await listSnapshot(list.id)).toEqual(before);
  });
  it('a result above the 999999999 paisa ceiling is 422 (never a database error, never a 500) and changes nothing', { timeout: T }, async () => {
    const { list, draftId } = await draftWith([[0, 999999990], [1, 100]]);
    const before = await listSnapshot(list.id);
    await err422(draftId, { change_kind: 'percent', percent_bp: 100000, rounding: 'none', scope: 'all' });
    await err422(draftId, { change_kind: 'fixed_amount', amount_paisa: 10, rounding: 'none', scope: 'all' });
    expect(await listSnapshot(list.id)).toEqual(before);
  });
  it('the service checks the shape: percent needs percent_bp, fixed_amount needs amount_paisa, department needs department_id, listed_tests needs orderable_ids -> 422', { timeout: T }, async () => {
    const { list, draftId } = await draftWith([[0, 100]]);
    const before = await listSnapshot(list.id);
    await err422(draftId, { change_kind: 'percent', rounding: 'none', scope: 'all' });
    await err422(draftId, { change_kind: 'fixed_amount', rounding: 'none', scope: 'all' });
    await err422(draftId, { change_kind: 'percent', percent_bp: 10, rounding: 'none', scope: 'department' });
    await err422(draftId, { change_kind: 'percent', percent_bp: 10, rounding: 'none', scope: 'listed_tests' });
    expect(await listSnapshot(list.id)).toEqual(before);
  });
  it('a listed test that is not in the draft: refused (404 or 422) and nothing changed', { timeout: T }, async () => {
    const { list, draftId } = await draftWith([[0, 100]]);
    const before = await listSnapshot(list.id);
    const e = await pfails('bulkUpdatePriceListDraft', req({ params: { price_list_version_id: draftId }, headers: { 'idempotency-key': uid() }, body: { change_kind: 'percent', percent_bp: 10, rounding: 'none', scope: 'listed_tests', orderable_ids: [uid()] } }));
    expect([404, 422]).toContain(e.statusCode);
    expect(await listSnapshot(list.id)).toEqual(before);
  });
  it('a PUBLISHED version is never changed: 409 catalog.version_in_use', { timeout: T }, async () => {
    const pub = await publishedList([{ id: tests[0]!.id, paisa: 1000 }]);
    const before = await listSnapshot(pub.list.id);
    expectCode(await pfails('bulkUpdatePriceListDraft', req({ params: { price_list_version_id: pub.versionId }, headers: { 'idempotency-key': uid() }, body: { change_kind: 'percent', percent_bp: 1000, rounding: 'none', scope: 'all' } })), 'catalog.version_in_use', 409);
    expect(await listSnapshot(pub.list.id)).toEqual(before);
  });
  it('the published version stays as it was when its DRAFT is bulk updated', { timeout: T }, async () => {
    const pub = await publishedList([{ id: tests[0]!.id, paisa: 1000 }]);
    const dr = await draftOf(pub.list.id); await putItems(dr.id, [{ id: tests[0]!.id, paisa: 1000 }]);
    expect((await bulkOf(dr.id, { change_kind: 'percent', percent_bp: 2000, rounding: 'none', scope: 'all' })).status).toBe(200);
    expect((await priceMap(pub.versionId))[tests[0]!.code]).toBe(1000);
    expect((await priceMap(dr.id))[tests[0]!.code]).toBe(1200);
    expect((await detail(pub.list.id)).current_version.id).toBe(pub.versionId);
  });
  it('another tenant\'s version and an unknown id: the same 404; permission: 403 without catalog.price_list.manage', { timeout: T }, async () => {
    const { list, draftId } = await draftWith([[0, 100]]);
    const before = await listSnapshot(list.id);
    const body = { change_kind: 'percent', percent_bp: 10, rounding: 'none', scope: 'all' };
    const e1 = await pfails('bulkUpdatePriceListDraft', req({ params: { price_list_version_id: draftId }, headers: { 'idempotency-key': uid() }, body }), { tenant: TENANT_B });
    const e2 = await pfails('bulkUpdatePriceListDraft', req({ params: { price_list_version_id: uid() }, headers: { 'idempotency-key': uid() }, body }), { tenant: TENANT_B });
    expectCode(e1, 'common.not_found', 404); expect([e1.code, e1.statusCode, e1.detail]).toEqual([e2.code, e2.statusCode, e2.detail]);
    for (const grants of [NONE, READ]) expectCode(await pfails('bulkUpdatePriceListDraft', req({ params: { price_list_version_id: draftId }, headers: { 'idempotency-key': uid() }, body }), { grants }), 'auth.forbidden', 403);
    expect(await listSnapshot(list.id)).toEqual(before);
  });
  it('every changed item has an audit line (an update row)', { timeout: T }, async () => {
    const { draftId } = await draftWith([[0, 1000], [1, 2000]]);
    await bulkOf(draftId, { change_kind: 'percent', percent_bp: 1000, rounding: 'none', scope: 'all' });
    for (const it of await itemRows(draftId)) expect((await auditOf('price_list_items', it.id)).map((a: any) => a.action).join(','), `item ${it.id}`).toContain('UPDATE');
  });
  it('CONCURRENCY: two +10 % bulk updates at once on one draft both apply (no lost update): the price is the double rise', { timeout: T }, async () => {
    const { draftId } = await draftWith([[0, 1005], [1, 2000]]);
    const body = { change_kind: 'percent', percent_bp: 1000, rounding: 'none', scope: 'all' };
    const res = await Promise.allSettled([bulkOf(draftId, body), bulkOf(draftId, body)]);
    for (const r of res) expect(r.status, r.status === 'rejected' ? String((r.reason as any)?.code) : '').toBe('fulfilled');
    const pm = await priceMap(draftId);
    expect(pm[tests[0]!.code]).toBe(percentPaisa(percentPaisa(1005, 1000), 1000));
    expect(pm[tests[1]!.code]).toBe(2420);
  });
});

describe('copyPriceList: a new DRAFT on the target list (never publishes)', () => {
  async function pair() {
    const src = await publishedList([{ id: tests[0]!.id, paisa: 1000 }, { id: tests[1]!.id, paisa: 2000 }]);
    const dst = await publishedList([{ id: tests[1]!.id, paisa: 5000 }, { id: tests[2]!.id, paisa: 6000 }]);
    return { src, dst };
  }
  it('mode replace: the draft holds ONLY the source items; 201 PriceListVersion draft on the target; the target\'s published version is unchanged', { timeout: T }, async () => {
    const { src, dst } = await pair();
    const r = await copyOf(dst.list.id, { source_price_list_version_id: src.versionId, mode: 'replace' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(schemaErrors('PriceListVersion', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ price_list_id: dst.list.id, status: 'draft', item_count: 2 });
    expect(await priceMap(r.body.id)).toEqual({ [tests[0]!.code]: 1000, [tests[1]!.code]: 2000 });
    expect(await priceMap(dst.versionId)).toEqual({ [tests[1]!.code]: 5000, [tests[2]!.code]: 6000 });
    expect((await versionRows(dst.list.id)).map((v: any) => v.status)).toEqual(['published', 'draft']);
  });
  it('mode merge: starts from the target\'s CURRENT version, the source items overwrite or add', { timeout: T }, async () => {
    const { src, dst } = await pair();
    const r = await copyOf(dst.list.id, { source_price_list_version_id: src.versionId, mode: 'merge' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await priceMap(r.body.id)).toEqual({ [tests[0]!.code]: 1000, [tests[1]!.code]: 2000, [tests[2]!.code]: 6000 });
  });
  it('percent_bp + rounding adjust the COPIED prices only (integer paisa, half up); merged target items stay as they were', { timeout: T }, async () => {
    const { src, dst } = await pair();
    const r = await copyOf(dst.list.id, { source_price_list_version_id: src.versionId, mode: 'merge', percent_bp: 1234, rounding: 'nearest_rupee' });
    const pm = await priceMap(r.body.id);
    expect(pm[tests[0]!.code]).toBe(roundTo(percentPaisa(1000, 1234), 100));
    expect(pm[tests[1]!.code]).toBe(roundTo(percentPaisa(2000, 1234), 100));
    expect(pm[tests[2]!.code], 'a target item the source does not hold is not adjusted').toBe(6000);
  });
  it('the source may be a DRAFT or any list of this tenant; a target with no current version starts from the source alone', { timeout: T }, async () => {
    const { list: s } = await mkList(); const sd = await draftOf(s.id); await putItems(sd.id, [{ id: tests[5]!.id, paisa: 4200 }]);
    const { list: t } = await mkList();
    const r = await copyOf(t.id, { source_price_list_version_id: sd.id, mode: 'merge' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await priceMap(r.body.id)).toEqual({ [tests[5]!.code]: 4200 });
  });
  it('a result above the ceiling is 422 and creates nothing; the target already holding a draft is 409 common.version_conflict', { timeout: T }, async () => {
    const big = await publishedList([{ id: tests[0]!.id, paisa: 999999990 }]);
    const { list: t } = await mkList();
    const before = await listSnapshot(t.id);
    const e = await pfails('copyPriceList', req({ params: { price_list_id: t.id }, headers: { 'idempotency-key': uid() }, body: { source_price_list_version_id: big.versionId, mode: 'replace', percent_bp: 100000 } }));
    expect(e.statusCode, e.code).toBe(422);
    expect(await listSnapshot(t.id)).toEqual(before);
    const { src, dst } = await pair();
    expect((await copyOf(dst.list.id, { source_price_list_version_id: src.versionId, mode: 'replace' })).status).toBe(201);
    const snap = await listSnapshot(dst.list.id);
    expectCode(await pfails('copyPriceList', req({ params: { price_list_id: dst.list.id }, headers: { 'idempotency-key': uid() }, body: { source_price_list_version_id: src.versionId, mode: 'merge' } })), 'common.version_conflict', 409);
    expect(await listSnapshot(dst.list.id)).toEqual(snap);
  });
  it('CONCURRENCY: two copies into one target at once: exactly one draft, the loser is a clean 409 common.version_conflict', { timeout: T }, async () => {
    const { src, dst } = await pair();
    const res = await Promise.allSettled([copyOf(dst.list.id, { source_price_list_version_id: src.versionId, mode: 'replace' }), copyOf(dst.list.id, { source_price_list_version_id: src.versionId, mode: 'merge' })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lose = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect([lose.reason?.code, lose.reason?.statusCode]).toEqual(['common.version_conflict', 409]);
    expect((await versionRows(dst.list.id)).filter((v: any) => v.status === 'draft')).toHaveLength(1);
  });
  it('another tenant\'s source or target and an unknown id answer the same 404; 403 without catalog.price_list.manage; the new version is audited', { timeout: T }, async () => {
    const { src, dst } = await pair();
    const snap = await listSnapshot(dst.list.id);
    const body = { source_price_list_version_id: src.versionId, mode: 'replace' };
    const e1 = await pfails('copyPriceList', req({ params: { price_list_id: dst.list.id }, headers: { 'idempotency-key': uid() }, body }), { tenant: TENANT_B });
    const e2 = await pfails('copyPriceList', req({ params: { price_list_id: uid() }, headers: { 'idempotency-key': uid() }, body }), { tenant: TENANT_B });
    expectCode(e1, 'common.not_found', 404); expect([e1.code, e1.statusCode, e1.detail]).toEqual([e2.code, e2.statusCode, e2.detail]);
    const e3 = await pfails('copyPriceList', req({ params: { price_list_id: dst.list.id }, headers: { 'idempotency-key': uid() }, body: { source_price_list_version_id: uid(), mode: 'replace' } }));
    expectCode(e3, 'common.not_found', 404);
    for (const grants of [NONE, READ]) expectCode(await pfails('copyPriceList', req({ params: { price_list_id: dst.list.id }, headers: { 'idempotency-key': uid() }, body }), { grants }), 'auth.forbidden', 403);
    expect(await listSnapshot(dst.list.id)).toEqual(snap);
    const ok = await copyOf(dst.list.id, body);
    expect((await auditOf('price_list_versions', ok.body.id)).length).toBeGreaterThanOrEqual(1);
  });
});
