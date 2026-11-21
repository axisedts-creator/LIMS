// T0B-TESTMGMT-1 cross tenant probes (07-SECURITY S-1; the frontdesk crossTenant.live twin) for the three category operations and the stage TAT write path, as the real handlers
// over a real PG17 under RLS: tenant B names tenant A's objects and must get the SAME answer as for an id that does not exist (404 common.not_found, never 403, never a hint),
// must see none of A's rows, and A's data (both tables, audit lines, events, revision) stays byte-identical.
import { beforeAll, describe, expect, it } from 'vitest';
import { call, errPaths, expectCode, fails, im, req } from '../testmgmt/helpers.js';
import { NEW_OPS, T, TENANT_A, TENANT_B, objs, requestFor, snapshot, tag, uid, type Objs } from './testmgmt.kit.js';

let A: Objs; let B: Objs;
beforeAll(async () => { A = await objs(TENANT_A); B = await objs(TENANT_B); }, T);

describe('listTestCategories', () => {
  it('each tenant sees only its own categories, also with the other tenant\'s department_id; the total of foreign rows is zero', { timeout: T }, async () => {
    const own = await call('listTestCategories', requestFor('listTestCategories', A), { tenant: TENANT_A });
    expect(own.body.data.map((x: any) => x.id)).toContain(A.category.id);
    const attack = await call('listTestCategories', requestFor('listTestCategories', A), { tenant: TENANT_B });
    expect(attack.status).toBe(200);
    expect(attack.body.data).toEqual([]);
    const all = await call('listTestCategories', req({ query: { is_active: 'all', limit: 200 } }), { tenant: TENANT_B });
    expect(all.body.data.map((x: any) => x.id)).not.toContain(A.category.id);
    expect(all.body.data.map((x: any) => x.id)).toContain(B.category.id);
  });
});

describe('createTestCategory / updateTestCategory / setTestTatTargets with the other tenant\'s ids', () => {
  it('create under the other tenant\'s department: 404 common.not_found, identical to a made up department; A is byte-identical afterwards', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A);
    const e1 = await fails('createTestCategory', requestFor('createTestCategory', A), { tenant: TENANT_B });
    const e2 = await fails('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { department_id: uid(), name: `Probe ${tag()}` } }), { tenant: TENANT_B });
    expectCode(e1, 'common.not_found', 404); expectCode(e2, 'common.not_found', 404);
    expect([e1.code, e1.statusCode, e1.detail]).toEqual([e2.code, e2.statusCode, e2.detail]);
    expect(await snapshot(TENANT_A)).toEqual(before);
  });
  it('update of the other tenant\'s category: 404, same answer as a made up id, nothing changes (rows, audit, events, revision)', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A);
    const e1 = await fails('updateTestCategory', requestFor('updateTestCategory', A), { tenant: TENANT_B });
    const e2 = await fails('updateTestCategory', req({ params: { category_id: uid() }, headers: im(1), body: { display_order: 9 } }), { tenant: TENANT_B });
    expectCode(e1, 'common.not_found', 404);
    expect([e1.code, e1.statusCode, e1.detail]).toEqual([e2.code, e2.statusCode, e2.detail]);
    expect(await snapshot(TENANT_A)).toEqual(before);
    const ok = await call('updateTestCategory', requestFor('updateTestCategory', A), { tenant: TENANT_A });
    expect(ok.status).toBe(200);                                   // the very same request works for its owner
  });
  it('a test of tenant B cannot be linked to a category of tenant A, nor can A\'s stage targets be written or read by B', { timeout: T }, async () => {
    const before = await snapshot(TENANT_A);
    expectCode(await fails('createTest', req({ headers: { 'idempotency-key': uid() }, body: { code: `X${tag()}`, name: 'Cross link', department_id: B.w.dept.id, workflow_type: 'standard',
      specimen_requirements: [{ specimen_type_id: B.w.spec.id, is_preferred: true }], category_id: A.category.id } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expectCode(await fails('updateTest', req({ params: { test_id: B.test.id }, headers: im(B.test.version), body: { category_id: A.category.id } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expectCode(await fails('setTestTatTargets', req({ params: { test_id: A.test.id }, headers: im(1), body: { targets: [{ priority: 'routine', segment: 'total', target_seconds: 3600 }], stage_targets: [{ stage: 'result', target_minutes: 1 }] } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expectCode(await fails('getTestDetail', req({ params: { test_id: A.test.id } }), { tenant: TENANT_B }), 'common.not_found', 404);
    expect(await snapshot(TENANT_A)).toEqual(before);
  });
  it('the Test of tenant A carries its seven stage targets and its category; B\'s own test carries B\'s', { timeout: T }, async () => {
    const a = (await call('getTestDetail', req({ params: { test_id: A.test.id } }), { tenant: TENANT_A })).body;
    const b = (await call('getTestDetail', req({ params: { test_id: B.test.id } }), { tenant: TENANT_B })).body;
    expect(a.stage_targets).toHaveLength(7); expect(b.stage_targets).toHaveLength(7);
    expect(a.category_id).toBe(A.category.id); expect(b.category_id).toBe(B.category.id);
  });
  it('a rejected cross tenant call leaks no field path of the foreign object (errors[] never names the other tenant\'s ids)', { timeout: T }, async () => {
    const e = await fails('createTestCategory', requestFor('createTestCategory', A), { tenant: TENANT_B });
    expect(JSON.stringify([e.detail, errPaths(e)])).not.toContain(A.w.dept.id);
  });
});

describe('coverage', () => {
  it('every new operation was attacked above (the kit has a request for each)', () => { for (const id of NEW_OPS) expect(() => requestFor(id, A), id).not.toThrow(); });
});
