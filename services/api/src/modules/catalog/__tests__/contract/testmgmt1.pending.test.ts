// T0C-TESTMGMT-1 (LD-318, LD-325(b)) — the three new test category operations must not break module boot:
// every operationId of catalog.yaml has a handler OR is listed in the manifest's pendingOperations (core/module.ts checkHandlers, AC-0D-1.2 with BOOTGATE-1);
// every pending id is a real operationId. The T0B-TESTMGMT-1 handler task moves the three ids from pending to handlers; this test stays green on both sides of that move.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const NEW_OPS = ['listTestCategories', 'createTestCategory', 'updateTestCategory'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0C-TESTMGMT-1: catalog manifest covers the new operations (handler or pending)', () => {
  it('the three category operations are in the spec', () => {
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
  it('the three new ids are each handled or pending, and none of the original catalog operations was made pending to hide a missing handler', () => {
    for (const id of NEW_OPS) expect(handlerIds.includes(id) || pending.includes(id), `${id} neither handled nor pending`).toBe(true);
    // T0C-PRICETOOLS-1 (LD-321, LD-325(b)) adds its seven operations to the same list; nothing else may be pending (pricetools1.pending.test.ts pins those seven).
    const PRICETOOLS = ['downloadPriceListTemplate', 'dryRunPriceListImport', 'commitPriceListImport', 'bulkUpdatePriceListDraft', 'copyPriceList', 'comparePriceLists', 'listPriceListImportBatches'];
    // T0C-TESTIMPORT-1 (LD-318, LD-325(b)) adds its six operations to the same list (pinned in testimport1.pending.test.ts).
    const TESTIMPORT = ['downloadCatalogImportTemplate', 'validateCatalogImport', 'commitCatalogImport', 'listCatalogImports', 'getCatalogImport', 'downloadCatalogImportErrors'];
    // T0C-PARTYSET-1 (LD-321, LD-325(b)) adds its five ICD master operations (pinned in partyset1.pending.test.ts).
    const PARTYSET = ['listIcdMasterCodes', 'searchIcdMasterCodes', 'createIcdMasterCode', 'updateIcdMasterCode', 'deactivateIcdMasterCode'];
    expect(pending.filter((id) => !NEW_OPS.includes(id) && !PRICETOOLS.includes(id) && !TESTIMPORT.includes(id) && !PARTYSET.includes(id)), 'only the category, price list tool and test import operations may be pending in catalog').toEqual([]);
  });
});
