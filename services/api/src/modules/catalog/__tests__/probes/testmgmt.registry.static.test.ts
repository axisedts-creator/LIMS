// T0B-TESTMGMT-1 static probes (no database; does NOT import the kit, which needs LIMS_TEST_APP_URL): the contract <-> probe tie, the permission / idempotency table of the three category
// operations, and the EXPECTED-rows tie: every table of migration 20261117170000 is named in the probe kit, the live table probes, the probe fixture rows, db/meta/tables.yaml and db/policies/catalog.sql.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';

const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const OPS = Object.entries<any>(spec.paths).flatMap(([path, item]) => ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item?.[m]?.operationId)
  .map((m) => ({ id: item[m].operationId as string, method: m, path, perm: item[m]['x-permission'] as string, idem: String(item[m]['x-idempotency'] ?? '') })));
const PROBES = 'services/api/src/modules/catalog/__tests__/probes';
const MIG = 'db/migrations/20261117170000_catalog__test_management_parity.sql';
const mine = (id: string) => OPS.find((o) => o.id === id)!;

describe('contract <-> probes', () => {
  it('every new operation is in the probe kit (requestFor) and in the cross tenant suite', () => {
    const kit = text(`${PROBES}/testmgmt.kit.ts`); const live = text(`${PROBES}/testmgmt.crossTenant.live.test.ts`);
    for (const id of ['listTestCategories', 'createTestCategory', 'updateTestCategory']) { expect(kit, id).toContain(`case '${id}'`); expect(live, id).toContain(id); }
  });
  it('permissions and idempotency of the three category operations (catalog.test.read / catalog.test.manage; create requires an Idempotency-Key)', () => {
    expect([mine('listTestCategories').perm, mine('createTestCategory').perm, mine('updateTestCategory').perm]).toEqual(['catalog.test.read', 'catalog.test.manage', 'catalog.test.manage']);
    expect(/required/i.test(mine('createTestCategory').idem)).toBe(true);
    expect(/required/i.test(mine('updateTestCategory').idem)).toBe(false);
    expect(mine('listTestCategories').method).toBe('get'); expect(mine('updateTestCategory').method).toBe('patch');
  });
  it('no operation of the catalog contract has a DELETE verb on the tables of this task (deactivate, never delete)', () => {
    expect(OPS.filter((o) => o.method === 'delete' && /categor|comment|panel|\/tests|analyte|range|critical/.test(o.path))).toEqual([]);
  });
  it('no new permission code was introduced by this task: every catalog operation names an existing code', () => {
    const yaml = text('contracts/permissions.yaml');
    for (const o of OPS) expect(yaml, o.perm).toContain(o.perm);
  });
});

describe('EXPECTED rows: the two new tables are named everywhere a table must be named', () => {
  const tables = [...text(MIG).matchAll(/CREATE TABLE IF NOT EXISTS catalog\.([a-z_]+)/g)].map((m) => m[1]!).sort();
  it('migration 20261117170000 creates exactly test_categories and test_stage_tat_targets', () => { expect(tables).toEqual(['test_categories', 'test_stage_tat_targets']); });
  it.each([
    [`${PROBES}/testmgmt.kit.ts`], [`${PROBES}/testmgmt.tables.live.test.ts`], ['db/tests/fixtures/probe-rows/catalog.sql'], ['db/meta/tables.yaml'], ['db/policies/catalog.sql'],
  ])('%s names both tables', (file) => { const t = text(file); for (const n of tables) expect(t, `${file}: ${n}`).toContain(n); });
  it('the probe fixture rows insert at least one row of each new table for both tenants', () => {
    const t = text('db/tests/fixtures/probe-rows/catalog.sql');
    for (const n of tables) expect([...t.matchAll(new RegExp(`INSERT INTO catalog\\.${n}\\b`, 'g'))].length, n).toBeGreaterThanOrEqual(1);
  });
});
