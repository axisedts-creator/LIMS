// T0C-PARTYSET-1 (LD-321, LD-325(b)) — the five ICD master operations must not break module boot:
// every operationId of catalog.yaml has a handler OR is listed in the manifest's pendingOperations (core/module.ts checkHandlers, AC-0D-1.2 with BOOTGATE-1);
// every pending id is a real operationId. The T0B-PARTYSET-1 handler task moves the five ids from pending to handlers; this test stays green on both sides of that move.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';
import { CATALOG_PERMISSIONS } from '../../permissions.js';

const NEW_OPS = ['listIcdMasterCodes', 'searchIcdMasterCodes', 'createIcdMasterCode', 'updateIcdMasterCode', 'deactivateIcdMasterCode'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0C-PARTYSET-1: catalog manifest covers the ICD master operations (handler or pending)', () => {
  it('the five operations are in the spec, all with catalog.icd.manage, and the catalog permission list holds that code', () => {
    for (const id of NEW_OPS) {
      expect(specIds, id).toContain(id);
      const op = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p)).find((m) => m?.operationId === id);
      expect(op['x-permission'], id).toBe('catalog.icd.manage');
    }
    expect(CATALOG_PERMISSIONS).toContain('catalog.icd.manage');
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
  it('each of the five ids is handled or pending; the doctor and credit party operations keep their handlers', () => {
    for (const id of NEW_OPS) expect(handlerIds.includes(id) || pending.includes(id), `${id} neither handled nor pending`).toBe(true);
    for (const id of ['createDoctor', 'updateDoctor', 'getDoctor', 'listDoctors', 'createCreditParty', 'getCreditParty', 'updateCreditParty', 'listCreditParties']) expect(handlerIds, `${id} keeps its handler`).toContain(id);
  });
});
