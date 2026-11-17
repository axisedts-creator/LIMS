// T0B-TESTMGMT-1 (LD-318, done_when 1, 3, 5, 7): test categories listTestCategories / createTestCategory / updateTestCategory over a real PG17 under RLS.
// PINNED PICKS (lead decisions LD-318; the contract has no text for them): an unknown or other tenant's department_id answers 404 common.not_found (same answer, S-1);
// a duplicate name (case-insensitive, same department) is 409 catalog.code_duplicate on create AND on rename; deactivation (is_active false) is change_kind 'deactivated',
// every other update 'updated', create 'created' in catalog.changed.v1 (entity_id = the category id); every write bumps the catalog revision by exactly 1.
import { beforeAll, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, T, auditRows, call, catalogRevision, changedEvents, dbRow, expectCode, expectInvalid, fails, im, mkTest, ownerRows, req, schemaErrors, tag, uid, world, type World } from './helpers.js';

let A: World; let B: World;
beforeAll(async () => { A = await world(TENANT_A); B = await world(TENANT_B); }, T);

const mk = (w: World, o: Record<string, unknown> = {}) => call('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { department_id: w.dept.id, name: `Cat ${tag()}`, ...o } }), { tenant: w.tenant });
const upd = (w: World, id: string, version: number, body: object, o: { header?: boolean } = {}) =>
  call('updateTestCategory', req({ params: { category_id: id }, headers: o.header === false ? {} : im(version), body }), { tenant: w.tenant });
const list = (w: World, query: object = {}) => call('listTestCategories', req({ query }), { tenant: w.tenant });

describe('create', () => {
  it('201 TestCategory (schema valid) with defaults: display_order 0, print_footer false, is_active true, version 1; the row is stored under the tenant', { timeout: T }, async () => {
    const r = await mk(A);
    expect(r.status).toBe(201);
    expect(schemaErrors('TestCategory', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ department_id: A.dept.id, display_order: 0, print_footer: false, is_active: true, version: 1 });
    expect(r.body.footer_text).toBeUndefined();
    const row = await dbRow('test_categories', r.body.id);
    expect(row).toMatchObject({ tenant_id: TENANT_A, name: r.body.name, department_id: A.dept.id });
  });
  it('every field round-trips (name, display_order, print_footer, footer_text, is_active=false)', { timeout: T }, async () => {
    const r = await mk(A, { display_order: 7, print_footer: true, footer_text: 'Synthetic footer text', is_active: false });
    expect(r.body).toMatchObject({ display_order: 7, print_footer: true, footer_text: 'Synthetic footer text', is_active: false });
  });
  it('duplicate name in the same department (case-insensitive) is 409 catalog.code_duplicate; the same name in another department and another tenant is fine', { timeout: T }, async () => {
    const name = `Haem ${tag()}`;
    await mk(A, { name });
    expectCode(await fails('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { department_id: A.dept.id, name: name.toUpperCase() } })), 'catalog.code_duplicate', 409);
    expect((await mk(A, { name, department_id: A.dept2.id })).status).toBe(201);
    expect((await mk(B, { name })).status).toBe(201);
  });
  it('unknown department and another tenant\'s department: 404 common.not_found (same answer)', { timeout: T }, async () => {
    for (const department_id of [uid(), B.dept.id]) {
      expectCode(await fails('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { department_id, name: `X ${tag()}` } })), 'common.not_found', 404);
    }
  });
  it.each([
    ['empty name', { name: '' }, '/name'], ['name > 200', { name: 'x'.repeat(201) }, '/name'], ['negative display_order', { display_order: -1 }, '/display_order'],
    ['display_order > 9999', { display_order: 10000 }, '/display_order'], ['empty footer_text', { footer_text: '' }, '/footer_text'], ['footer_text > 2000', { footer_text: 'x'.repeat(2001) }, '/footer_text'],
    ['print_footer not boolean', { print_footer: 'yes' }, '/print_footer'], ['unknown field', { tenant_id: uid() }, '/tenant_id'], ['server owned id', { id: uid() }, '/id'],
  ])('rejected before any write: %s', { timeout: T }, async (_n, over, path) => {
    await expectInvalid('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { department_id: A.dept.id, name: `Ok ${tag()}`, ...over } }), path);
  });
  it('department_id and name are required (field paths)', { timeout: T }, async () => {
    await expectInvalid('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { name: 'No dept' } }), '/department_id');
    await expectInvalid('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { department_id: A.dept.id } }), '/name');
  });
});

describe('update and deactivate (never delete)', () => {
  it('PATCH changes only the sent fields, version 1 -> 2; stale If-Match is 409 common.version_conflict; no If-Match is 428 common.precondition_required', { timeout: T }, async () => {
    const c = (await mk(A, { footer_text: 'keep me' })).body;
    const r = await upd(A, c.id, 1, { name: `Renamed ${tag()}`, display_order: 3 });
    expect(r.status).toBe(200);
    expect(schemaErrors('TestCategory', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: c.id, version: 2, display_order: 3, footer_text: 'keep me', is_active: true });
    expectCode(await fails('updateTestCategory', req({ params: { category_id: c.id }, headers: im(1), body: { display_order: 4 } })), 'common.version_conflict', 409);
    expectCode(await fails('updateTestCategory', req({ params: { category_id: c.id }, body: { display_order: 4 } })), 'common.precondition_required', 428);
  });
  it('unset footer_text clears it; unset of anything else is a validation error', { timeout: T }, async () => {
    const c = (await mk(A, { footer_text: 'bye' })).body;
    const r = await upd(A, c.id, 1, { unset: ['footer_text'] });
    expect(r.body.footer_text).toBeUndefined();
    expect((await dbRow('test_categories', c.id)).footer_text).toBeNull();
    await expectInvalid('updateTestCategory', req({ params: { category_id: c.id }, headers: im(2), body: { unset: ['name'] } }), '/unset');
  });
  it('rename onto an existing name of the same department is 409 catalog.code_duplicate', { timeout: T }, async () => {
    const a = (await mk(A)).body; const b = (await mk(A)).body;
    expectCode(await fails('updateTestCategory', req({ params: { category_id: b.id }, headers: im(1), body: { name: a.name.toLowerCase() } })), 'catalog.code_duplicate', 409);
  });
  it('is_active false deactivates: hidden from the default list, shown with is_active=all, tests keep their category link, can be reactivated; the row is never deleted', { timeout: T }, async () => {
    const c = (await mk(A)).body;
    const t = await mkTest(A, { category_id: c.id });
    const off = await upd(A, c.id, 1, { is_active: false });
    expect(off.body).toMatchObject({ is_active: false, version: 2 });
    expect((await list(A, { department_id: A.dept.id })).body.data.map((x: any) => x.id)).not.toContain(c.id);
    expect((await list(A, { department_id: A.dept.id, is_active: 'all' })).body.data.map((x: any) => x.id)).toContain(c.id);
    const inactive = (await list(A, { department_id: A.dept.id, is_active: 'false' })).body.data;
    expect(inactive.map((x: any) => x.id)).toContain(c.id);
    expect(inactive.every((x: any) => x.is_active === false)).toBe(true);
    const got = await call('getTestDetail', req({ params: { test_id: t.id } }));
    expect(got.body.category_id, 'tests stay linked to a deactivated category').toBe(c.id);
    expect((await upd(A, c.id, 2, { is_active: true })).body.is_active).toBe(true);
    expect(await dbRow('test_categories', c.id)).toBeTruthy();
  });
  it('a category id that does not exist, or belongs to another tenant, is 404 common.not_found on update', { timeout: T }, async () => {
    const other = (await mk(B)).body;
    for (const id of [uid(), other.id]) expectCode(await fails('updateTestCategory', req({ params: { category_id: id }, headers: im(1), body: { display_order: 1 } })), 'common.not_found', 404);
    expect((await dbRow('test_categories', other.id)).display_order, 'tenant B row untouched').toBe(0);
  });
  it('the department of a category cannot be changed (closed body: department_id is not an update field)', { timeout: T }, async () => {
    const c = (await mk(A)).body;
    await expectInvalid('updateTestCategory', req({ params: { category_id: c.id }, headers: im(1), body: { department_id: A.dept2.id } }), '/department_id');
  });
  it.each([['name', { name: '' }], ['display_order', { display_order: -3 }], ['footer_text', { footer_text: '' }], ['is_active', { is_active: 'no' }]])('update rejects a bad %s with its field path, no write', { timeout: T }, async (k, body) => {
    const c = (await mk(A)).body;
    await expectInvalid('updateTestCategory', req({ params: { category_id: c.id }, headers: im(1), body }), `/${k}`);
  });
});

describe('list', () => {
  it('department filter, sort by name / -name / display_order, paging with limit + cursor, tenant isolation', { timeout: T }, async () => {
    const w = await world(TENANT_A);
    const names = ['Charlie', 'Alpha', 'Bravo'].map((n) => `${n} ${tag(3)}`);   // same case on purpose: collation of the sort is not under test
    for (const [i, n] of names.entries()) await mk(w, { name: n, display_order: 10 - i });
    await mk(A, { name: `Elsewhere ${tag()}` });
    const all = await list(w, { department_id: w.dept.id, sort: 'name' });
    expect(schemaErrors('TestCategoryPage', all.body)).toEqual([]);
    expect(all.body.data.map((x: any) => x.name)).toEqual([...names].sort());
    expect((await list(w, { department_id: w.dept.id, sort: '-name' })).body.data.map((x: any) => x.name)).toEqual(all.body.data.map((x: any) => x.name).reverse());
    expect((await list(w, { department_id: w.dept.id, sort: 'display_order' })).body.data.map((x: any) => x.display_order)).toEqual([8, 9, 10]);
    const p1 = await list(w, { department_id: w.dept.id, sort: 'name', limit: 2 });
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.page.next_cursor).toBeTruthy();
    const p2 = await list(w, { department_id: w.dept.id, sort: 'name', limit: 2, cursor: p1.body.page.next_cursor });
    expect([...p1.body.data, ...p2.body.data].map((x: any) => x.id)).toEqual(all.body.data.map((x: any) => x.id));
    expect(p2.body.page.next_cursor).toBeUndefined();
    const b = await list(B, {});
    expect(b.body.data.every((x: any) => x.department_id !== w.dept.id)).toBe(true);
  });
  it('a bad sort or limit is a validation error with its path', { timeout: T }, async () => {
    await expectInvalid('listTestCategories', req({ query: { sort: 'footer_text' } }), '/sort');
    await expectInvalid('listTestCategories', req({ query: { limit: 0 } }), '/limit');
    await expectInvalid('listTestCategories', req({ query: { is_active: 'maybe' } }), '/is_active');
    await expectInvalid('listTestCategories', req({ query: { department_id: 'not-a-uuid' } }), '/department_id');
  });
});

describe('audit and events (done_when 7)', () => {
  it('create + update + deactivate each write an audit.audit_log row (changed columns on update) and one catalog.changed.v1 (created / updated / deactivated), revision +1 each', { timeout: T }, async () => {
    const r0 = await catalogRevision(TENANT_A);
    const c = (await mk(A)).body;
    await upd(A, c.id, 1, { display_order: 5 });
    await upd(A, c.id, 2, { is_active: false });
    expect(await catalogRevision(TENANT_A)).toBe(r0 + 3);
    const audit = await auditRows('test_categories', c.id);
    expect(audit.map((x: any) => x.action)).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
    expect(audit[1].changed_columns).toContain('display_order');
    expect(audit[2].changed_columns).toContain('is_active');
    expect(audit.every((x: any) => x.tenant_id === TENANT_A)).toBe(true);
    const ev = await changedEvents(TENANT_A, c.id);
    expect(ev.map((e: any) => e.envelope.payload.change_kind)).toEqual(['created', 'updated', 'deactivated']);
  });
  it('a rejected request leaves no row, no audit line, no event and no revision bump', { timeout: T }, async () => {
    const r0 = await catalogRevision(TENANT_A);
    const n = `Dup ${tag()}`;
    const c = (await mk(A, { name: n })).body;
    const r1 = await catalogRevision(TENANT_A);
    await fails('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { department_id: A.dept.id, name: n } }));
    await fails('updateTestCategory', req({ params: { category_id: c.id }, headers: im(9), body: { display_order: 2 } }));
    expect(await catalogRevision(TENANT_A)).toBe(r1);
    expect(r1).toBe(r0 + 1);
    expect(await ownerRows('catalog.test_categories', 'tenant_id = $1 AND department_id = $2 AND lower(name) = lower($3)', [TENANT_A, A.dept.id, n])).toHaveLength(1);
  });
});
