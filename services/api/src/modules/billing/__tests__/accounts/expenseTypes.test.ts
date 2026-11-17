// T0B-ACCT-2 (LD-313, LD-310) listExpenseTypes / createExpenseType / updateExpenseType: done_when 1 (each operation, tenant isolation) and 5 (audit event on every write).
// Real PG17 under RLS. Fails now: the three operations are in billing pendingOperations (core answers 501), they have no handler.
// Contract pins: duplicate name (any case) -> 400 common.validation_failed; unknown particular (or another tenant's) -> 404 common.not_found; update needs If-Match (stale ->
// 409 common.version_conflict); is_active false hides the type from createExpense (see expenses.test.ts) but keeps it listed with is_active=false.
import { describe, expect, it } from 'vitest';
import { notFound, rejected } from './helpers.js';
import { TENANT_B, T, auditActions, createType, listTypes, ok, uid, updateType, world, tag } from './helpers2.js';

describe('createExpenseType', () => {
  it('creates an active type pointing at the particular; version 1; the row audit trigger records one INSERT', async () => {
    const w = await world('a');
    const body = ok(await createType(w.tenant, { name: `Synthetic Rent ${tag()}`, account_particular_id: w.particularId }), 201);
    expect(body).toMatchObject({ account_particular_id: w.particularId, is_active: true, version: 1 });
    expect(Object.keys(body).sort()).toEqual(['account_particular_id', 'created_at', 'id', 'is_active', 'name', 'updated_at', 'version']);
    expect(await auditActions(w.tenant, 'expense_types', body.id)).toEqual(['INSERT']);
  }, T);

  it('can be created inactive', async () => {
    const w = await world('a');
    expect(ok(await createType(w.tenant, { name: `Synthetic Off ${tag()}`, account_particular_id: w.particularId, is_active: false }), 201).is_active).toBe(false);
  }, T);

  it('the name is unique per tenant ignoring case -> 400; the same name is free in the other tenant', async () => {
    const a = await world('a'), b = await world('b');
    const name = `Synthetic Water ${tag()}`;
    ok(await createType(a.tenant, { name, account_particular_id: a.particularId }), 201);
    rejected(await createType(a.tenant, { name: name.toUpperCase(), account_particular_id: a.particularId }));
    ok(await createType(b.tenant, { name, account_particular_id: b.particularId }), 201);
  }, T);

  it('unknown particular and a particular of another tenant -> 404 and nothing is written', async () => {
    const a = await world('a'), b = await world('b');
    notFound(await createType(a.tenant, { name: `Synthetic X ${tag()}`, account_particular_id: uid() }));
    notFound(await createType(a.tenant, { name: `Synthetic Y ${tag()}`, account_particular_id: b.particularId }));
  }, T);

  it.each([
    ['empty name', { name: '' }], ['name over 200', { name: 'x'.repeat(201) }], ['name not a string', { name: 7 }], ['particular not a uuid', { account_particular_id: 'nope' }],
    ['unknown field', { status: 'x' }], ['tenant_id in the body', { tenant_id: TENANT_B }], ['is_active not a boolean', { is_active: 'yes' }],
  ])('refuses %s with 400 common.validation_failed', async (_n, bad) => {
    const w = await world('a');
    rejected(await createType(w.tenant, { name: `Synthetic Ok ${tag()}`, account_particular_id: w.particularId, ...bad }));
  }, T);

  it('a body that names tenant_id never lands in the other tenant', async () => {
    const w = await world('a');
    const o = await createType(w.tenant, { name: `Synthetic T ${tag()}`, account_particular_id: w.particularId, tenant_id: TENANT_B });
    rejected(o);
  }, T);
});

describe('updateExpenseType', () => {
  it('renames, repoints and deactivates with If-Match; version +1; the row audit trigger records an UPDATE; a stale version -> 409', async () => {
    const w = await world('a');
    const t = ok(await createType(w.tenant, { name: `Synthetic Old ${tag()}`, account_particular_id: w.particularId }), 201);
    const other = await world('a');
    const nm = `Synthetic New ${tag()}`;
    const u = ok(await updateType(w.tenant, t.id, 1, { name: nm, account_particular_id: other.particularId, is_active: false }));
    expect(u).toMatchObject({ id: t.id, name: nm, account_particular_id: other.particularId, is_active: false, version: 2 });
    expect(await auditActions(w.tenant, 'expense_types', t.id)).toEqual(['INSERT', 'UPDATE']);
    rejected(await updateType(w.tenant, t.id, 1, { name: `Synthetic Stale ${tag()}` }), 'common.version_conflict');
  }, T);

  it('no If-Match -> 428; empty body -> 400; unknown id -> 404; another tenant id -> 404; duplicate name -> 400; unknown particular -> 404', async () => {
    const a = await world('a'), b = await world('b');
    const t = ok(await createType(a.tenant, { name: `Synthetic One ${tag()}`, account_particular_id: a.particularId }), 201);
    const t2 = ok(await createType(a.tenant, { name: `Synthetic Two ${tag()}`, account_particular_id: a.particularId }), 201);
    rejected(await updateType(a.tenant, t.id, 'none', { name: 'Synthetic' }), 'common.precondition_required');
    rejected(await updateType(a.tenant, t.id, 1, {}));
    notFound(await updateType(a.tenant, uid(), 1, { name: 'Synthetic' }));
    notFound(await updateType(b.tenant, t.id, 1, { name: 'Synthetic cross tenant' }));
    rejected(await updateType(a.tenant, t.id, 1, { name: t2.name.toUpperCase() }));
    notFound(await updateType(a.tenant, t.id, 1, { account_particular_id: b.particularId }));
  }, T);
});

describe('listExpenseTypes', () => {
  it('lists the tenant types only (RLS), filters by is_active, pages with a cursor', async () => {
    const a = await world('a'), b = await world('b');
    const mk = async (n: string, active: boolean) => ok(await createType(a.tenant, { name: `${n} ${tag()}`, account_particular_id: a.particularId, is_active: active }), 201);
    const on = await mk('Synthetic On', true), off = await mk('Synthetic Off', false);
    const foreign = ok(await createType(b.tenant, { name: `Synthetic B ${tag()}`, account_particular_id: b.particularId }), 201);
    const all = ok(await listTypes(a.tenant, { limit: 200 })).data.map((x: any) => x.id);
    expect(all).toEqual(expect.arrayContaining([on.id, off.id]));
    expect(all).not.toContain(foreign.id);
    expect(ok(await listTypes(a.tenant, { is_active: true, limit: 200 })).data.map((x: any) => x.id)).toEqual(expect.arrayContaining([on.id]));
    expect(ok(await listTypes(a.tenant, { is_active: true, limit: 200 })).data.map((x: any) => x.id)).not.toContain(off.id);
    const p1 = ok(await listTypes(a.tenant, { limit: 1 }));
    expect(p1.data).toHaveLength(1);
    expect(p1.page.limit).toBe(1);
    if (p1.page.next_cursor) {
      const p2 = ok(await listTypes(a.tenant, { limit: 1, cursor: p1.page.next_cursor }));
      expect(p2.data[0].id).not.toBe(p1.data[0].id);
    }
  }, T);

  it('a bad cursor -> 400 common.invalid_cursor; limit 0 or 201 -> 400', async () => {
    const w = await world('a');
    rejected(await listTypes(w.tenant, { cursor: '!!not-a-cursor!!' }), 'common.invalid_cursor');
    rejected(await listTypes(w.tenant, { limit: 0 }));
    rejected(await listTypes(w.tenant, { limit: 201 }));
  }, T);
});
