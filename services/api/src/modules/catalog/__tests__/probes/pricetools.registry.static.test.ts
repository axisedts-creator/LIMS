// T0B-PRICETOOLS-1 static probes (no database; does NOT import the kit): the contract <-> probe tie, the permission / idempotency table of the seven operations, and the EXPECTED-rows tie:
// every table of migration 20261117200000 is named in the probe kit, the live table probes, the probe fixture rows, db/meta/tables.yaml and db/policies/catalog.sql.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';

const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const OPS = Object.entries<any>(spec.paths).flatMap(([path, item]) => ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item?.[m]?.operationId)
  .map((m) => ({ id: item[m].operationId as string, method: m, path, perm: item[m]['x-permission'] as string, idem: String(item[m]['x-idempotency'] ?? '') })));
const PROBES = 'services/api/src/modules/catalog/__tests__/probes';
const MIG = 'db/migrations/20261117200000_catalog__add_price_list_tools.sql';
const NEW = ['downloadPriceListTemplate', 'dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList', 'comparePriceLists', 'listPriceListImportBatches'];
const mine = (id: string) => OPS.find((o) => o.id === id)!;

describe('contract <-> probes', () => {
  it('every new operation is in the probe kit (requestFor) and in the cross tenant suite', () => {
    const kit = text(`${PROBES}/pricetools.kit.ts`); const live = text(`${PROBES}/pricetools.crossTenant.live.test.ts`);
    for (const id of NEW) { expect(kit, id).toContain(`case '${id}'`); expect(live, id).toContain(id); }
  });
  it('permissions and idempotency of the seven operations; methods as the contract says', () => {
    for (const id of ['downloadPriceListTemplate', 'dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList']) expect(mine(id).perm, id).toBe('catalog.price_list.manage');
    for (const id of ['comparePriceLists', 'listPriceListImportBatches']) expect(mine(id).perm, id).toBe('catalog.price_list.read');
    for (const id of ['dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList']) expect(mine(id).idem, id).toMatch(/required/i);
    for (const id of ['downloadPriceListTemplate', 'comparePriceLists', 'listPriceListImportBatches']) expect(mine(id).idem, id).not.toMatch(/required/i);
    expect([mine('downloadPriceListTemplate').method, mine('comparePriceLists').method, mine('dryRunPriceListImport').method]).toEqual(['get', 'get', 'post']);
  });
  it('no operation deletes price history: no DELETE verb on price lists, versions, batches or comparisons (draft items are removed through removePriceListItems only)', () => {
    expect(OPS.filter((o) => o.method === 'delete' && /import-batches|price-list-comparisons|price-list-import/.test(o.path))).toEqual([]);
  });
  it('no new permission code was introduced: the price tools reuse catalog.price_list.manage / read (LD-321)', () => {
    const yaml = text('contracts/permissions.yaml');
    for (const id of NEW) expect(yaml, id).toContain(mine(id).perm);
  });
});

describe('EXPECTED rows: the two new tables are named everywhere a table must be named', () => {
  const tables = [...text(MIG).matchAll(/CREATE TABLE IF NOT EXISTS catalog\.([a-z_]+)/g)].map((m) => m[1]!).sort();
  it('migration 20261117200000 creates exactly price_list_import_batch and price_list_import_error', () => { expect(tables).toEqual(['price_list_import_batch', 'price_list_import_error']); });
  it.each([[`${PROBES}/pricetools.kit.ts`], [`${PROBES}/pricetools.tables.live.test.ts`], ['db/tests/fixtures/probe-rows/catalog.sql'], ['db/meta/tables.yaml'], ['db/policies/catalog.sql'], ['db/tests/isolation/_registry.sql']])('%s names both tables', (file) => {
    const t = text(file); for (const n of tables) expect(t, `${file}: ${n}`).toContain(n);
  });
  it('the probe fixture rows insert at least one row of each new table', () => {
    const t = text('db/tests/fixtures/probe-rows/catalog.sql');
    for (const n of tables) expect([...t.matchAll(new RegExp(`INSERT INTO catalog\\.${n}\\b`, 'g'))].length, n).toBeGreaterThanOrEqual(1);
  });
});
