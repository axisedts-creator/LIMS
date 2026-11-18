// T0B-PRICETOOLS-1 probe kit (helper, not a test), the price tool twin of testmgmt.kit.ts: one request per operation of T0C-PRICETOOLS-1 naming a given tenant's objects, the two tables of migration
// 20261117200000 (catalog.price_list_import_batch, catalog.price_list_import_error) and an owner-side snapshot. Needs LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL (tests/catalog/T0B-PRICETOOLS-1.pg.sh). Synthetic data only.
import { join } from 'node:path';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { TENANT_A, TENANT_B, superTx, tag, uid, world, req, type World } from '../testmgmt/helpers.js';
import { XLSX_CT, draftOf, dry, mkList, mkTests, priceBook, publishedList, type TestRef } from '../pricetools/helpers.js';

export { TENANT_A, TENANT_B, superTx, tag, uid };
export const T = 120_000;
/** the tables created by migration 20261117200000 (probe-rows/catalog.sql, db/meta/tables.yaml and db/policies/catalog.sql must name them too: registry.static) */
export const NEW_TABLES = ['price_list_import_batch', 'price_list_import_error'] as const;
export const NEW_OPS = ['downloadPriceListTemplate', 'dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList', 'comparePriceLists', 'listPriceListImportBatches'] as const;

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
export const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

export interface Objs { tenant: string; w: World; tests: TestRef[]; list: any; versionId: string; draftVersionId: string; targetList: any; batch: any; badBatch: any }
/** a list with a published version, one clean dry run batch and one batch that holds an error row, of `tenant`, built through the real handlers */
export async function objs(tenant: string): Promise<Objs> {
  const w = await world(tenant); const tests = await mkTests(w, 2);
  const pub = await publishedList([{ id: tests[0]!.id, paisa: 1000 }], { tenant });
  const batch = (await dry(pub.list.id, priceBook([{ code: tests[0]!.code, price: 12.5 }]), { tenant })).batch;
  const badBatch = (await dry(pub.list.id, priceBook([{ code: 'NOSUCHPROBE', price: 1 }]), { tenant })).batch;
  // ruling 5: bulk needs an open DRAFT (a published version is 409 catalog.version_in_use); copy needs a fresh target list (no common.version_conflict)
  const draftVersionId = (await draftOf((await mkList(tenant, { noParty: true })).list.id, tenant)).id as string;
  const targetList = (await mkList(tenant, { noParty: true })).list;
  return { tenant, w, tests, list: pub.list, versionId: pub.versionId, draftVersionId, targetList, batch, badBatch };
}
/** the request each new operation receives when it names `S`'s objects */
export function requestFor(id: string, S: Objs): ReturnType<typeof req> {
  switch (id) {
    case 'downloadPriceListTemplate': return req({ query: { price_list_id: S.list.id } });
    case 'dryRunPriceListImport': return req({ params: { price_list_id: S.list.id }, headers: { 'idempotency-key': uid() }, body: { file: { filename: 'probe.xlsx', mimeType: XLSX_CT, bytes: priceBook([{ code: S.tests[0]!.code, price: 1 }]) } } });
    case 'commitPriceListImport': return req({ params: { batch_id: S.batch.id }, headers: { 'idempotency-key': uid() }, body: { change_reason: 'probe' } });
    case 'bulkUpdatePriceListDraft': return req({ params: { price_list_version_id: S.draftVersionId }, headers: { 'idempotency-key': uid() }, body: { change_kind: 'percent', percent_bp: 10, rounding: 'none', scope: 'all' } });
    case 'copyPriceList': return req({ params: { price_list_id: S.targetList.id }, headers: { 'idempotency-key': uid() }, body: { source_price_list_version_id: S.versionId, mode: 'replace' } });
    case 'comparePriceLists': return req({ query: { version_a_id: S.versionId, version_b_id: S.versionId } });
    case 'listPriceListImportBatches': return req({ query: { price_list_id: S.list.id } });
    default: throw new Error(`no probe request for ${id}`);
  }
}
/** md5 over every row of both new tables, the price tables of `tenant` (superuser, no RLS) + the audit and event counts */
export async function snapshot(tenant: string): Promise<Record<string, string>> {
  return superTx(async (tx) => {
    const out: Record<string, string> = {};
    const h = async (sql: string) => (await tx.query(`SELECT coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') AS h FROM (${sql}) x`, [tenant])).rows[0].h as string;
    for (const t of NEW_TABLES) out[t] = await h(`SELECT * FROM catalog.${t} WHERE tenant_id = $1`);
    for (const t of ['price_lists', 'price_list_versions', 'price_list_items', 'price_list_assignments']) out[t] = await h(`SELECT * FROM catalog.${t} WHERE tenant_id = $1`);
    out['audit_log'] = (await tx.query(`SELECT count(*)::text AS h FROM audit.audit_log WHERE tenant_id = $1 AND schema_name = 'catalog'`, [tenant])).rows[0].h;
    out['event_log'] = (await tx.query(`SELECT count(*)::text AS h FROM core.event_log WHERE tenant_id = $1`, [tenant])).rows[0].h;
    return out;
  }, tenant);
}
