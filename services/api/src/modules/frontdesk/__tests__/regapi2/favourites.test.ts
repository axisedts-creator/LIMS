// T0B-REGAPI-2 done_when (4): favourites: add, remove, list per user. Operations: addFavouriteTest, listFavouriteTests, removeFavouriteTest.
// PINNED PICKS: adding a favourite the user already has is idempotent (200 or 201, same body, still one row); the orderable must exist for the tenant in the catalog
// (CatalogPort: an unknown or other-tenant orderable is 404 common.not_found); a favourite belongs to the calling membership: another user's list never shows it and
// another user's remove is 404 (the row survives); removing twice is 404; list is newest first.
import { describe, expect, it } from 'vitest';
import { O } from '../quote/helpers.js';
import { T, TENANT_A, codeOf, fire, forbidden, fresh, idem, notFound, ok, ownerRows, rejected, req, schemaErrors, uid, without } from './helpers.js';

const add = (who: any, orderable_id: string) => fire('addFavouriteTest', req({ headers: idem(), body: { orderable_id } }), who);
const list = (who: any, query: object = {}) => fire('listFavouriteTests', req({ query }), who);
const remove = (who: any, orderable_id: string) => fire('removeFavouriteTest', req({ params: { orderable_id } }), who);
const rows = (user: string) => ownerRows('frontdesk.favourite_tests', 'user_id = $1 ORDER BY created_at, id', [user]);

describe('addFavouriteTest', () => {
  it('201 FavouriteTest (schema valid); row carries tenant, caller and orderable', { timeout: T }, async () => {
    const u = fresh();
    const b = ok(await add(u, O.cbc), 201);
    expect(schemaErrors('FavouriteTest', b)).toEqual([]);
    expect(b.orderable_id).toBe(O.cbc);
    expect((await rows(u.membershipId))).toMatchObject([{ tenant_id: TENANT_A, user_id: u.membershipId, orderable_id: O.cbc }]);
  });
  it('idempotent: adding the same test again is 200/201 with one row; 6 parallel adds leave one row and no error', { timeout: T }, async () => {
    const u = fresh();
    ok(await add(u, O.glu), 201);
    const again = await add(u, O.glu);
    expect(again.error, `${(again.error as any)?.code}`).toBeUndefined();
    expect([200, 201]).toContain(again.reply?.status);
    expect(again.reply!.body.orderable_id).toBe(O.glu);
    const v = fresh();
    const outs = await Promise.all(Array.from({ length: 6 }, () => add(v, O.ure)));
    for (const o of outs) expect(o.error, `${(o.error as any)?.code} ${(o.error as any)?.message}`).toBeUndefined();
    expect(await rows(u.membershipId)).toHaveLength(1);
    expect(await rows(v.membershipId)).toHaveLength(1);
  });
  it('two users may favourite the same test independently', { timeout: T }, async () => {
    const a = fresh(); const b = fresh();
    ok(await add(a, O.cbc), 201); ok(await add(b, O.cbc), 201);
    expect(await rows(a.membershipId)).toHaveLength(1); expect(await rows(b.membershipId)).toHaveLength(1);
  });
  it('unknown orderable, an orderable of another tenant and a malformed id are refused; nothing stored', { timeout: T }, async () => {
    const u = fresh();
    notFound(await add(u, uid()));
    notFound(await add(u, O.tenantBOnly));
    rejected(await add(u, 'not-a-uuid'));
    expect(await rows(u.membershipId)).toHaveLength(0);
  });
  it('requires frontdesk.registration.create', { timeout: T }, async () => {
    const u = without(fresh(), 'frontdesk.registration.create');
    forbidden(await add(u, O.cbc));
    expect(await rows(u.membershipId)).toHaveLength(0);
  });
});

describe('listFavouriteTests', () => {
  it('lists only the caller\'s favourites, newest first (schema valid); another user sees none of them', { timeout: T }, async () => {
    const u = fresh();
    ok(await add(u, O.cbc), 201); await new Promise((r) => setTimeout(r, 15)); ok(await add(u, O.glu), 201);
    const b = ok(await list(u));
    expect(schemaErrors('FavouriteTestPage', b)).toEqual([]);
    expect(b.data.map((x: any) => x.orderable_id)).toEqual([O.glu, O.cbc]);
    expect(ok(await list(fresh())).data).toEqual([]);
  });
  it('limit 1 + next_cursor walks the list without repeats', { timeout: T }, async () => {
    const u = fresh();
    ok(await add(u, O.cbc), 201); await new Promise((r) => setTimeout(r, 15)); ok(await add(u, O.glu), 201);
    const p1 = ok(await list(u, { limit: '1' }));
    expect(p1.data).toHaveLength(1);
    const p2 = ok(await list(u, { limit: '1', cursor: p1.page.next_cursor }));
    expect(p2.data).toHaveLength(1);
    expect(p2.data[0].orderable_id).not.toBe(p1.data[0].orderable_id);
  });
  it('requires frontdesk.registration.create', { timeout: T }, async () => { forbidden(await list(without(fresh(), 'frontdesk.registration.create'))); });
});

describe('removeFavouriteTest', () => {
  it('204 and the row is gone; a second remove is 404; the list no longer shows it', { timeout: T }, async () => {
    const u = fresh();
    ok(await add(u, O.cbc), 201);
    expect((await remove(u, O.cbc)).reply?.status).toBe(204);
    expect(await rows(u.membershipId)).toHaveLength(0);
    notFound(await remove(u, O.cbc));
    expect(ok(await list(u)).data).toEqual([]);
  });
  it('another user cannot remove my favourite: 404 and the row survives', { timeout: T }, async () => {
    const owner = fresh();
    ok(await add(owner, O.cbc), 201);
    notFound(await remove(fresh(), O.cbc));
    expect(await rows(owner.membershipId)).toHaveLength(1);
  });
  it('requires frontdesk.registration.create; a malformed id is 400', { timeout: T }, async () => {
    const u = fresh(); ok(await add(u, O.cbc), 201);
    forbidden(await remove(without(u, 'frontdesk.registration.create'), O.cbc));
    expect(codeOf(await remove(u, 'nope'))).toBe('common.validation_failed');
    expect(await rows(u.membershipId)).toHaveLength(1);
  });
});
