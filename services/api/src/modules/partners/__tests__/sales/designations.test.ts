// T0B-SALES-1: listSalesDesignations / createSalesDesignation / updateSalesDesignation (T0C-SALES-1 contract; done_when (2) level 1..8, unique per tenant, in the DOMAIN layer).
// Fails now: the 3 operations are pending (no handler). Real PG17, RLS on. Synthetic data only.
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_A, ADMIN_B, T, TENANT_A, TENANT_B, auditRows, dbRow, dbRows, fire, idem, ifm, mkDesignation, mkRep, noWrites, notFound, ok, rejected, req, wipe } from './helpers.js';

beforeEach(() => wipe(TENANT_A, TENANT_B), T);
const create = (body: unknown, who = ADMIN_A) => fire('createSalesDesignation', req({ headers: idem(), body }), who);
const update = (id: string, v: number | undefined, body: unknown, who = ADMIN_A) => fire('updateSalesDesignation', req({ params: { designation_id: id }, headers: v === undefined ? {} : ifm(v), body }), who);
const list = (query: object = {}, who = ADMIN_A) => fire('listSalesDesignations', req({ query }), who);

describe('createSalesDesignation', () => {
  it('201: levels 1 and 8 are the ends of the range; shape = contract, no tenant_id / audit columns; row + INSERT audit event written', { timeout: T }, async () => {
    for (const level of [1, 8]) {
      const b = ok(await create({ name: `Synthetic L${level}`, level }), 201);
      expect(Object.keys(b).sort()).toEqual(['created_at', 'id', 'is_active', 'level', 'name', 'updated_at', 'version']);
      expect(b).toMatchObject({ name: `Synthetic L${level}`, level, is_active: true, version: 1 });
      expect(await dbRow('partners.sales_designation', b.id)).toMatchObject({ tenant_id: TENANT_A, level });
      expect((await auditRows('partners.sales_designation', b.id)).map((r) => r.action)).toEqual(['INSERT']);
    }
  });
  it.each([[0], [9], [-1], [2.5], ['3'], [null], [Number.NaN], [1e9]])('level %j is refused in the domain layer (/level), no write attempted', { timeout: T }, async (level) => {
    const o = await create({ name: 'Synthetic', level });
    rejected(o, 'common.validation_failed', '/level');
    noWrites(o);
  });
  it.each([[''], ['   '], ['x'.repeat(121)], [42]])('name %j is refused (/name)', { timeout: T }, async (name) => {
    const o = await create({ name, level: 3 });
    rejected(o, 'common.validation_failed', '/name'); noWrites(o);
  });
  it('a second designation with the same level of the tenant is refused (/level) BEFORE any write; the first row is untouched', { timeout: T }, async () => {
    const first = ok(await create({ name: 'Synthetic first', level: 3 }), 201);
    const o = await create({ name: 'Synthetic second', level: 3 });
    rejected(o, 'common.validation_failed', '/level'); noWrites(o);
    expect(await dbRows('partners.sales_designation', 'tenant_id = $1', [TENANT_A])).toHaveLength(1);
    expect((await dbRow('partners.sales_designation', first.id)).version).toBe(1);
  });
  it('level is unique over ALL rows: an inactive designation still holds its level', { timeout: T }, async () => {
    await mkDesignation(TENANT_A, 4, { is_active: false });
    rejected(await create({ name: 'Synthetic', level: 4 }), 'common.validation_failed', '/level');
  });
  it('the same level in another tenant is fine (unique per tenant)', { timeout: T }, async () => {
    ok(await create({ name: 'Synthetic A', level: 5 }), 201);
    ok(await create({ name: 'Synthetic B', level: 5 }, ADMIN_B), 201);
    expect((await dbRows('partners.sales_designation', 'level = 5 AND tenant_id IN ($1,$2)', [TENANT_A, TENANT_B])).map((r) => r.tenant_id).sort()).toEqual([TENANT_A, TENANT_B].sort());
  });
  it('concurrency: 6 requests for the same free level -> exactly one 201, the others common.validation_failed /level (never 500), one row', { timeout: T }, async () => {
    const outs = await Promise.all(Array.from({ length: 6 }, (_, i) => create({ name: `Synthetic race ${i}`, level: 6 })));
    expect(outs.filter((o) => o.reply?.status === 201)).toHaveLength(1);
    for (const o of outs.filter((x) => x.reply?.status !== 201)) rejected(o, 'common.validation_failed', '/level');
    expect(await dbRows('partners.sales_designation', 'tenant_id = $1 AND level = 6', [TENANT_A])).toHaveLength(1);
  });
});

describe('updateSalesDesignation', () => {
  it('rename: 200, version 2, UPDATE audit event naming the changed column', { timeout: T }, async () => {
    const d = await mkDesignation(TENANT_A, 2);
    const b = ok(await update(d.id, 1, { name: 'Synthetic renamed' }));
    expect(b).toMatchObject({ id: d.id, name: 'Synthetic renamed', level: 2, version: 2 });
    const a = (await auditRows('partners.sales_designation', d.id)).filter((r) => r.action === 'UPDATE');
    expect(a).toHaveLength(1); expect(a[0].changed_columns).toContain('name');
  });
  it('If-Match: missing -> 428 precondition_required, stale -> 409 version_conflict, malformed -> 400; nothing written', { timeout: T }, async () => {
    const d = await mkDesignation(TENANT_A, 2);
    const m = await update(d.id, undefined, { name: 'X' }); rejected(m, 'common.precondition_required'); noWrites(m);
    ok(await update(d.id, 1, { name: 'Synthetic v2' }));
    rejected(await update(d.id, 1, { name: 'Synthetic stale' }), 'common.version_conflict');
    rejected(await fire('updateSalesDesignation', req({ params: { designation_id: d.id }, headers: { 'if-match': 'abc' }, body: { name: 'X' } }), ADMIN_A));
    expect((await dbRow('partners.sales_designation', d.id)).name).toBe('Synthetic v2');
  });
  it('changing level to a level another designation holds -> /level, before any write; to a free level -> ok; to its own level -> ok', { timeout: T }, async () => {
    const d2 = await mkDesignation(TENANT_A, 2); await mkDesignation(TENANT_A, 3, { is_active: false });
    const o = await update(d2.id, 1, { level: 3 }); rejected(o, 'common.validation_failed', '/level'); noWrites(o);
    expect(ok(await update(d2.id, 1, { level: 2 })).level).toBe(2);
    expect(ok(await update(d2.id, (await dbRow('partners.sales_designation', d2.id)).version, { level: 7 })).level).toBe(7);
  });
  it.each([[0], [9], [1.5]])('level %j refused (/level)', { timeout: T }, async (level) => {
    const d = await mkDesignation(TENANT_A, 2);
    const o = await update(d.id, 1, { level }); rejected(o, 'common.validation_failed', '/level'); noWrites(o);
  });
  it('a level change shows in every representative of the designation (designation_level)', { timeout: T }, async () => {
    const d = await mkDesignation(TENANT_A, 2); const r = await mkRep(TENANT_A, d.id);
    ok(await update(d.id, 1, { level: 5 }));
    const b = ok((await fire('listSalesRepresentatives', req(), ADMIN_A)));
    expect(b.data.find((x: any) => x.id === r.id).designation_level).toBe(5);
  });
  it('is_active false then true again', { timeout: T }, async () => {
    const d = await mkDesignation(TENANT_A, 2);
    expect(ok(await update(d.id, 1, { is_active: false })).is_active).toBe(false);
    expect(ok(await update(d.id, 2, { is_active: true })).is_active).toBe(true);
  });
  it('unknown id and another tenant id are the same common.not_found; nothing changes', { timeout: T }, async () => {
    const d = await mkDesignation(TENANT_A, 2);
    notFound(await update(d.id, 1, { name: 'Synthetic hijack' }, ADMIN_B));
    notFound(await update('01a1a98a-ac40-7000-8000-00000000ffff', 1, { name: 'X' }));
    expect(await dbRow('partners.sales_designation', d.id)).toMatchObject({ version: 1 });
  });
});

describe('listSalesDesignations', () => {
  it('own tenant only, ordered by level ascending; filters level / is_active / q (prefix, case-insensitive); paged', { timeout: T }, async () => {
    for (const [l, n, a] of [[3, 'Zone Head', true], [1, 'Director', true], [5, 'Field Officer', false], [2, 'Regional Head', true]] as const) await mkDesignation(TENANT_A, l, { name: n, is_active: a });
    await mkDesignation(TENANT_B, 4, { name: 'Other tenant' });
    const all = ok(await list());
    expect(all.data.map((d: any) => d.level)).toEqual([1, 2, 3, 5]);
    expect(all.page.limit).toBeGreaterThan(0);
    expect(ok(await list({ level: 3 })).data.map((d: any) => d.name)).toEqual(['Zone Head']);
    expect(ok(await list({ is_active: false })).data.map((d: any) => d.level)).toEqual([5]);
    expect(ok(await list({ q: 'REGIONAL' })).data.map((d: any) => d.level)).toEqual([2]);
    const p1 = ok(await list({ limit: 2 }));
    expect(p1.data.map((d: any) => d.level)).toEqual([1, 2]); expect(typeof p1.page.next_cursor).toBe('string');
    const p2 = ok(await list({ limit: 2, cursor: p1.page.next_cursor }));
    expect(p2.data.map((d: any) => d.level)).toEqual([3, 5]);
    rejected(await list({ cursor: 'not-a-cursor' }), 'common.invalid_cursor');
    expect(ok(await list({}, ADMIN_B)).data.map((d: any) => d.name)).toEqual(['Other tenant']);
  });
});
