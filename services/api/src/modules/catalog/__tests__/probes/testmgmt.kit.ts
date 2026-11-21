// T0B-TESTMGMT-1 probe kit (helper, not a test), the catalog twin of frontdesk/__tests__/probes/kit.ts: one request per operation of T0C-TESTMGMT-1 naming a given tenant's objects,
// the two tables of migration 20261117170000 and an owner-side snapshot. Needs LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL (tests/catalog/T0B-TESTMGMT-1.pg.sh). Synthetic data only.
import { join } from 'node:path';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { TENANT_A, TENANT_B, call, im, mkTest, req, superTx, tag, uid, world, type World } from '../testmgmt/helpers.js';

export { TENANT_A, TENANT_B, superTx, tag, uid };
export const T = 120_000;
/** the tables created by migration 20261117170000 (probe-rows/catalog.sql, db/meta/tables.yaml and db/policies/catalog.sql must name them too: registry.static) */
export const NEW_TABLES = ['test_categories', 'test_stage_tat_targets'] as const;
export const NEW_OPS = ['listTestCategories', 'createTestCategory', 'updateTestCategory'] as const;

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
export const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

export interface Objs { tenant: string; w: World; category: any; test: any }
/** one category and one test with seven stage targets of `tenant`, built through the real handlers */
export async function objs(tenant: string): Promise<Objs> {
  const w = await world(tenant);
  const category = (await call('createTestCategory', req({ headers: { 'idempotency-key': uid() }, body: { department_id: w.dept.id, name: `Probe ${tag()}`, footer_text: 'Probe footer' } }), { tenant })).body;
  const test = await mkTest(w, { category_id: category.id });
  const stage_targets = ['registration', 'sample_collection', 'accession', 'result', 'approval_1', 'approval_2', 'release'].map((stage, i) => ({ stage, target_minutes: 5 + i }));
  await call('setTestTatTargets', req({ params: { test_id: test.id }, headers: im(1), body: { targets: [{ priority: 'routine', segment: 'total', target_seconds: 3600 }], stage_targets } }), { tenant });
  return { tenant, w, category, test };
}
/** the request each new operation receives when it names `S`'s objects */
export function requestFor(id: string, S: Objs): ReturnType<typeof req> {
  switch (id) {
    case 'listTestCategories': return req({ query: { department_id: S.w.dept.id, is_active: 'all' } });
    case 'createTestCategory': return req({ headers: { 'idempotency-key': uid() }, body: { department_id: S.w.dept.id, name: `Probe new ${tag()}` } });
    case 'updateTestCategory': return req({ params: { category_id: S.category.id }, headers: im(S.category.version), body: { display_order: 9 } });
    default: throw new Error(`no probe request for ${id}`);
  }
}
/** md5 over every row of both new tables of `tenant` (superuser, no RLS) + the audit and event counts of the tenant */
export async function snapshot(tenant: string): Promise<Record<string, string>> {
  return superTx(async (tx) => {
    const out: Record<string, string> = {};
    for (const t of NEW_TABLES) out[t] = (await tx.query(`SELECT coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') AS h FROM catalog.${t} x WHERE tenant_id = $1`, [tenant])).rows[0].h;
    out['audit_log'] = (await tx.query(`SELECT count(*)::text AS h FROM audit.audit_log WHERE tenant_id = $1 AND schema_name = 'catalog'`, [tenant])).rows[0].h;
    out['event_log'] = (await tx.query(`SELECT count(*)::text AS h FROM core.event_log WHERE tenant_id = $1`, [tenant])).rows[0].h;
    out['catalog_state'] = (await tx.query(`SELECT coalesce(max(catalog_revision), 0)::text AS h FROM catalog.catalog_state WHERE tenant_id = $1`, [tenant])).rows[0].h;
    return out;
  }, tenant);
}
