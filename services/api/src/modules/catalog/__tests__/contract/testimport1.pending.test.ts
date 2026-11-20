// T0C-TESTIMPORT-1 (LD-318, LD-325(b), LD-335) — the six Excel test import operations must not break module boot:
// every operationId of catalog.yaml has a handler OR is listed in the manifest's pendingOperations (core/module.ts checkHandlers, AC-0D-1.2 with BOOTGATE-1);
// every pending id is a real operationId. The T0B-TESTIMPORT-1 handler task moves the six ids from pending to handlers; this test stays green on both sides of that move.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const NEW_OPS = ['downloadCatalogImportTemplate', 'validateCatalogImport', 'commitCatalogImport', 'listCatalogImports', 'getCatalogImport', 'downloadCatalogImportErrors'];
const OTHER_PENDING_OK = [
  'listTestCategories', 'createTestCategory', 'updateTestCategory', // T0C-TESTMGMT-1 (pending until T0B-TESTMGMT-1)
  'downloadPriceListTemplate', 'dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList', 'comparePriceLists', 'listPriceListImportBatches', // T0C-PRICETOOLS-1
  'listIcdMasterCodes', 'searchIcdMasterCodes', 'createIcdMasterCode', 'updateIcdMasterCode', 'deactivateIcdMasterCode', // T0C-PARTYSET-1 (LD-321)
];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0C-TESTIMPORT-1: catalog manifest covers the new operations (handler or pending)', () => {
  it('the six test import operations are in the spec', () => {
    for (const id of NEW_OPS) expect(specIds, id).toContain(id);
  });
  it('every spec operation has a handler or is listed pending (boot check would pass)', () => {
    const uncovered = specIds.filter((id) => !handlerIds.includes(id) && !pending.includes(id));
    expect(uncovered, `no handler and not pending: ${uncovered.join(', ')}`).toEqual([]);
  });
  it('every pending id is a spec operationId and appears once', () => {
    expect(pending.filter((id) => !specIds.includes(id))).toEqual([]);
    expect(new Set(pending).size).toBe(pending.length);
  });
  it('a handler key that is not a spec operation does not exist (nothing was invented)', () => {
    expect(handlerIds.filter((id) => !specIds.includes(id))).toEqual([]);
  });
  it('each of the six ids is handled or pending, and no original catalog operation was made pending to hide a missing handler', () => {
    for (const id of NEW_OPS) expect(handlerIds.includes(id) || pending.includes(id), `${id} neither handled nor pending`).toBe(true);
    expect(pending.filter((id) => !NEW_OPS.includes(id) && !OTHER_PENDING_OK.includes(id)), 'only the test category, price list tool and test import operations may be pending in catalog').toEqual([]);
    for (const id of ['listTests', 'createTest', 'publishAnalyteVersion', 'publishReferenceRangeSet', 'downloadImportTemplate', 'createImport', 'commitImport']) expect(handlerIds, `${id} keeps its handler`).toContain(id);
  });
});
