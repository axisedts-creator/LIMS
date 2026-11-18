// T0B-SALES-1: listServiceAreas / createServiceArea / updateServiceArea / deactivateServiceArea (free text district + area_text, no pincode; optional centre of the tenant).
// Real PG17, RLS on. Fails now: operations pending. Synthetic data only.
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_A, ADMIN_B, CENTRE, T, TENANT_A, TENANT_B, auditRows, dbRow, fire, idem, ifm, mkArea, noWrites, notFound, ok, rejected, req, uid, wipe } from './helpers.js';

beforeEach(() => wipe(TENANT_A, TENANT_B), T);
const create = (body: object, who = ADMIN_A) => fire('createServiceArea', req({ headers: idem(), body }), who);
const update = (id: string, v: number | undefined, body: object, who = ADMIN_A) => fire('updateServiceArea', req({ params: { service_area_id: id }, headers: v === undefined ? {} : ifm(v), body }), who);
const deactivate = (id: string, v: number | undefined, who = ADMIN_A) => fire('deactivateServiceArea', req({ params: { service_area_id: id }, headers: v === undefined ? {} : ifm(v) }), who);
const list = (query: object = {}, who = ADMIN_A) => fire('listServiceAreas', req({ query }), who);

describe('createServiceArea', () => {
  it('201: name + district (free text), optional area_text and centre of the tenant; no pincode key; INSERT audit event', { timeout: T }, async () => {
    const b = ok(await create({ name: 'Synthetic ward 4', district: 'Kathmandu', area_text: 'Synthetic municipality, ward 4', centre_id: CENTRE.a }), 201);
    expect(b).toMatchObject({ name: 'Synthetic ward 4', district: 'Kathmandu', area_text: 'Synthetic municipality, ward 4', centre_id: CENTRE.a, is_active: true, version: 1 });
    expect(Object.keys(b).some((k) => /pin/i.test(k))).toBe(false);
    expect((await auditRows('partners.service_area', b.id)).map((r) => r.action)).toEqual(['INSERT']);
    const bare = ok(await create({ name: 'Synthetic whole tenant', district: 'Lalitpur' }), 201); expect('centre_id' in bare).toBe(false); expect('area_text' in bare).toBe(false);
  });
  it.each([['name', ''], ['name', '   '], ['name', 'x'.repeat(201)], ['district', ''], ['district', ' '], ['district', 'x'.repeat(101)], ['area_text', ''], ['area_text', 'x'.repeat(501)]])('%s %j is refused (/%s)', { timeout: T }, async (k, v) => {
    const o = await create({ name: 'Synthetic', district: 'Kathmandu', [k]: v }); rejected(o, 'common.validation_failed', `/${k}`); noWrites(o);
  });
  it('centre_id must be a centre of the tenant (/centre_id): unknown and tenant B centre refused', { timeout: T }, async () => {
    for (const id of [uid(), CENTRE.b]) { const o = await create({ name: 'Synthetic', district: 'Kathmandu', centre_id: id }); rejected(o, 'common.validation_failed', '/centre_id'); noWrites(o); }
  });
});

describe('updateServiceArea / deactivateServiceArea', () => {
  it('update: partial change, unset area_text + centre_id, version 2, UPDATE audit; If-Match 428 / 409', { timeout: T }, async () => {
    const a = await mkArea(TENANT_A, { area_text: 'Synthetic text', centre_id: CENTRE.a });
    expect(ok(await update(a.id, 1, { district: 'Bhaktapur' }))).toMatchObject({ district: 'Bhaktapur', version: 2, area_text: 'Synthetic text' });
    const c = ok(await update(a.id, 2, { unset: ['area_text', 'centre_id'] })); expect('area_text' in c).toBe(false); expect('centre_id' in c).toBe(false);
    expect((await auditRows('partners.service_area', a.id)).filter((r) => r.action === 'UPDATE')).toHaveLength(2);
    rejected(await update(a.id, undefined, { name: 'X' }), 'common.precondition_required'); rejected(await update(a.id, 1, { name: 'X' }), 'common.version_conflict');
  });
  it('update with a foreign centre -> /centre_id; unknown / other tenant id -> not_found', { timeout: T }, async () => {
    const a = await mkArea(TENANT_A); const o = await update(a.id, 1, { centre_id: CENTRE.b }); rejected(o, 'common.validation_failed', '/centre_id'); noWrites(o);
    notFound(await update(a.id, 1, { name: 'Synthetic hijack' }, ADMIN_B)); notFound(await update(uid(), 1, { name: 'X' }));
  });
  it('deactivate: is_active false, version +1, row kept; stale / missing If-Match; other tenant -> not_found; second deactivate does not 5xx', { timeout: T }, async () => {
    const a = await mkArea(TENANT_A);
    expect(ok(await deactivate(a.id, 1))).toMatchObject({ is_active: false, version: 2 }); expect(await dbRow('partners.service_area', a.id)).toBeTruthy();
    rejected(await deactivate(a.id, undefined), 'common.precondition_required'); rejected(await deactivate(a.id, 1), 'common.version_conflict');
    notFound(await deactivate(a.id, 2, ADMIN_B));
  });
});

describe('listServiceAreas', () => {
  it('own tenant only; filters district (case-insensitive) / centre_id / is_active / q prefix; paged', { timeout: T }, async () => {
    await mkArea(TENANT_A, { name: 'Alpha', district: 'Kathmandu', centre_id: CENTRE.a }); await mkArea(TENANT_A, { name: 'Beta', district: 'Lalitpur' }); await mkArea(TENANT_A, { name: 'Gamma', district: 'Lalitpur', is_active: false });
    await mkArea(TENANT_B, { name: 'Other tenant', district: 'Kathmandu' });
    const names = (b: any) => b.data.map((x: any) => x.name).sort();
    expect(names(ok(await list()))).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(names(ok(await list({ district: 'lalitpur' })))).toEqual(['Beta', 'Gamma']);
    expect(names(ok(await list({ centre_id: CENTRE.a })))).toEqual(['Alpha']);
    expect(names(ok(await list({ is_active: false })))).toEqual(['Gamma']);
    expect(names(ok(await list({ q: 'BET' })))).toEqual(['Beta']);
    const p1 = ok(await list({ limit: 2 })); expect(p1.data).toHaveLength(2); const p2 = ok(await list({ limit: 2, cursor: p1.page.next_cursor })); expect(p2.data).toHaveLength(1);
    expect(names(ok(await list({}, ADMIN_B)))).toEqual(['Other tenant']);
  });
});
