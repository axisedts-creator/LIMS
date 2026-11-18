// T0B-ACCT-1 (LD-313, T0C-ACCT-1 contract) account groups + particulars: listAccountGroups, createAccountGroup, updateAccountGroup,
// listAccountParticulars, createAccountParticular, updateAccountParticular. Real PG17 under RLS (helpers.ts). Fails now: the 6 handlers do not exist.
// PINS the writer may dispute: duplicate code -> 400 common.validation_failed (the contract text says so); PATCH without If-Match -> 428 common.precondition_required,
// stale If-Match -> 409 common.version_conflict; a body naming code / nature / account_group_id on PATCH -> 400 (additionalProperties false); every master write leaves an
// audit.audit_log row written by the row audit trigger (table_name, row_id, action INSERT / UPDATE).
import { describe, expect, it } from 'vitest';
import { T, fire, idem, ifm, moneyIsInteger, notFound, ok, rejected, req, seed, superTx, tag, uid, world, TENANT_A, TENANT_B } from './helpers.js';

const mkGroup = (code: string, over: Record<string, unknown> = {}, tenant = TENANT_A) =>
  fire('createAccountGroup', req({ headers: idem(), body: { code, name: 'Synthetic group', nature: 'income', ...over } }), { tenant });
const mkPart = (groupId: string, code: string, over: Record<string, unknown> = {}, tenant = TENANT_A) =>
  fire('createAccountParticular', req({ headers: idem(), body: { account_group_id: groupId, code, name: 'Synthetic particular', ...over } }), { tenant });
const auditRows = (table: string, rowId: string) => superTx(async (tx) =>
  (await tx.query('SELECT action FROM audit.audit_log WHERE schema_name = $1 AND table_name = $2 AND row_id = $3 ORDER BY occurred_at, id', ['billing', table, rowId])).rows.map((r: any) => r.action));

describe('account groups', () => {
  it('createAccountGroup: 201 with the contract shape, version 1, active by default; one audit INSERT row', async () => {
    const code = `G_${tag()}`;
    const g = ok(await mkGroup(code, { nature: 'expense' }), 201);
    expect(g).toMatchObject({ code, name: 'Synthetic group', nature: 'expense', is_active: true, version: 1 });
    expect(Object.keys(g).sort()).toEqual(['code', 'created_at', 'id', 'is_active', 'name', 'nature', 'updated_at', 'version']);
    expect(await auditRows('account_groups', g.id)).toEqual(['INSERT']);
  }, T);

  it('validation: lower case / empty / too long code, unknown nature, empty name, extra field, is_active=false accepted', async () => {
    for (const body of [{ code: 'lower' }, { code: '' }, { code: 'A'.repeat(33) }, { code: 'A B' }, { nature: 'equity' }, { name: '' }, { name: 'x'.repeat(201) }, { tenant_id: uid() }])
      rejected(await mkGroup(`G_${tag()}`, body));
    expect(ok(await mkGroup(`G_${tag()}`, { is_active: false }), 201).is_active).toBe(false);
  }, T);

  it('a duplicate code in the same tenant is 400 common.validation_failed; the same code in tenant B is fine (per tenant unique)', async () => {
    const code = `G_${tag()}`;
    ok(await mkGroup(code), 201);
    rejected(await mkGroup(code));
    ok(await mkGroup(code, {}, TENANT_B), 201);
  }, T);

  it('updateAccountGroup: name and is_active change, version +1, code and nature never; audit UPDATE row', async () => {
    const g = ok(await mkGroup(`G_${tag()}`), 201);
    const u = ok(await fire('updateAccountGroup', req({ params: { account_group_id: g.id }, headers: ifm(1), body: { name: 'Renamed', is_active: false } })));
    expect(u).toMatchObject({ id: g.id, code: g.code, nature: g.nature, name: 'Renamed', is_active: false, version: 2 });
    expect(await auditRows('account_groups', g.id)).toEqual(['INSERT', 'UPDATE']);
    for (const body of [{ code: 'OTHER' }, { nature: 'asset' }, {}])
      rejected(await fire('updateAccountGroup', req({ params: { account_group_id: g.id }, headers: ifm(2), body })));
  }, T);

  it('updateAccountGroup: stale If-Match 409 version_conflict, missing If-Match 428 precondition_required, unknown id 404, tenant B id 404', async () => {
    const g = ok(await mkGroup(`G_${tag()}`), 201);
    ok(await fire('updateAccountGroup', req({ params: { account_group_id: g.id }, headers: ifm(1), body: { name: 'v2' } })));
    rejected(await fire('updateAccountGroup', req({ params: { account_group_id: g.id }, headers: ifm(1), body: { name: 'stale' } })), 'common.version_conflict');
    rejected(await fire('updateAccountGroup', req({ params: { account_group_id: g.id }, headers: {}, body: { name: 'x' } })), 'common.precondition_required');
    notFound(await fire('updateAccountGroup', req({ params: { account_group_id: uid() }, headers: ifm(1), body: { name: 'x' } })));
    const b = await world('b');
    notFound(await fire('updateAccountGroup', req({ params: { account_group_id: b.groupId }, headers: ifm(1), body: { name: 'hijack' } })));
    expect((await superTx(async (tx) => (await tx.query('SELECT name FROM billing.account_groups WHERE id = $1', [b.groupId])).rows[0], TENANT_B)).name).toBe('Synthetic income group');
  }, T);

  it('listAccountGroups: filters nature / is_active, cursor pages cover every row once, bad cursor 400 invalid_cursor, tenant B rows never appear', async () => {
    const a = await world('a'); const b = await world('b');
    const mine = [a.groupId];
    for (let i = 0; i < 4; i++) mine.push(ok(await mkGroup(`G_${tag()}`, { nature: 'liability' }), 201).id);
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const body = ok(await fire('listAccountGroups', req({ query: { nature: 'liability', limit: 2, ...(cursor ? { cursor } : {}) } })));
      expect(body.data.length).toBeLessThanOrEqual(2);
      for (const g of body.data) { expect(g.nature).toBe('liability'); seen.push(g.id); }
      cursor = body.page.next_cursor; pages++;
    } while (cursor && pages < 200);
    expect(new Set(seen).size).toBe(seen.length);                                  // no duplicate across pages
    expect(seen).toEqual(expect.arrayContaining(mine.slice(1)));
    expect(seen).not.toContain(b.groupId);
    const inactive = ok(await mkGroup(`G_${tag()}`, { is_active: false }), 201);
    const act = ok(await fire('listAccountGroups', req({ query: { is_active: false, limit: 200 } })));
    expect(act.data.every((g: any) => g.is_active === false)).toBe(true);
    expect(act.data.map((g: any) => g.id)).toContain(inactive.id);
    rejected(await fire('listAccountGroups', req({ query: { cursor: '!!!not-a-cursor' } })), 'common.invalid_cursor');
  }, T);
});

describe('account particulars', () => {
  it('createAccountParticular: 201 shape, group must exist in the tenant (unknown and tenant B group -> 404), duplicate code -> 400; audit INSERT row', async () => {
    const w = await world('a'); const b = await world('b');
    const code = `P_${tag()}`;
    const p = ok(await mkPart(w.groupId, code), 201);
    expect(p).toMatchObject({ account_group_id: w.groupId, code, name: 'Synthetic particular', is_active: true, version: 1 });
    expect(await auditRows('account_particulars', p.id)).toEqual(['INSERT']);
    rejected(await mkPart(w.groupId, code));
    notFound(await mkPart(uid(), `P_${tag()}`));
    notFound(await mkPart(b.groupId, `P_${tag()}`));
    for (const body of [{ code: 'lower' }, { name: '' }, { account_group_id: 'not-a-uuid' }]) rejected(await mkPart(w.groupId, `P_${tag()}`, body));
  }, T);

  it('updateAccountParticular: name / is_active only (group and code never), If-Match rules, tenant B id 404', async () => {
    const w = await world('a'); const b = await world('b');
    const u = ok(await fire('updateAccountParticular', req({ params: { account_particular_id: w.particularId }, headers: ifm(1), body: { name: 'Renamed', is_active: false } })));
    expect(u).toMatchObject({ id: w.particularId, account_group_id: w.groupId, code: w.particularCode, name: 'Renamed', is_active: false, version: 2 });
    rejected(await fire('updateAccountParticular', req({ params: { account_particular_id: w.particularId }, headers: ifm(2), body: { account_group_id: uid() } })));
    rejected(await fire('updateAccountParticular', req({ params: { account_particular_id: w.particularId }, headers: ifm(2), body: { code: 'NEWCODE' } })));
    rejected(await fire('updateAccountParticular', req({ params: { account_particular_id: w.particularId }, headers: ifm(1), body: { name: 'stale' } })), 'common.version_conflict');
    rejected(await fire('updateAccountParticular', req({ params: { account_particular_id: w.particularId }, headers: {}, body: { name: 'x' } })), 'common.precondition_required');
    notFound(await fire('updateAccountParticular', req({ params: { account_particular_id: b.particularId }, headers: ifm(1), body: { name: 'hijack' } })));
  }, T);

  it('listAccountParticulars: tenant scoped, paged, contract shape, no tenant B row', async () => {
    const a = await world('a'); const b = await world('b');
    ok(await mkPart(a.groupId, `P_${tag()}`), 201);
    const body = ok(await fire('listAccountParticulars', req({ query: { limit: 200, account_group_id: a.groupId } })));
    const ids = body.data.map((p: any) => p.id);
    expect(ids).toContain(a.particularId);
    expect(ids).not.toContain(b.particularId);
    expect(body.page.limit).toBe(200);
    const first = ok(await fire('listAccountParticulars', req({ query: { limit: 1 } })));
    expect(first.data).toHaveLength(1);
    expect(typeof first.page.next_cursor).toBe('string');
    rejected(await fire('listAccountParticulars', req({ query: { cursor: '!!!' } })), 'common.invalid_cursor');
    expect(moneyIsInteger(body)).toEqual([]);
  }, T);

  it('masters are written as the caller tenant only: RLS keeps tenant B rows unreadable and unwritable for tenant A', async () => {
    const b = await world('b');
    await seed('billing.account_groups', { id: uid(), tenant_id: TENANT_B, code: `G_${tag()}`, name: 'B only', nature: 'asset' });
    const all = ok(await fire('listAccountGroups', req({ query: { limit: 200 } })));
    expect(all.data.map((g: any) => g.id)).not.toContain(b.groupId);
    expect(all.data.map((g: any) => g.code)).not.toContain(b.groupCode);
  }, T);
});
