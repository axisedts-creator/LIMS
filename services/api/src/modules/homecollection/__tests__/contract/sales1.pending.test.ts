// T0C-SALES-1 (LD-321, LD-325(b)) — the new collector flags operation of homecollection.yaml must not break module boot:
// it has a handler OR is listed in the manifest's pendingOperations; every pending id is a real operationId. T0B-SALES-1 moves it from pending to handlers.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';

const NEW_OPS = ['updateCollectorFlags'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/homecollection.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0C-SALES-1: homecollection manifest covers updateCollectorFlags (handler or pending)', () => {
  it('the operation is in the spec', () => { for (const id of NEW_OPS) expect(specIds, id).toContain(id); });
  it('every spec operation has a handler or is listed pending (boot check would pass)', () => {
    const uncovered = specIds.filter((id) => !handlerIds.includes(id) && !pending.includes(id));
    expect(uncovered, `no handler and not pending: ${uncovered.join(', ')}`).toEqual([]);
  });
  it('every pending id is a spec operationId and appears once; only the new operation may be pending', () => {
    expect(pending.filter((id) => !specIds.includes(id))).toEqual([]);
    expect(new Set(pending).size).toBe(pending.length);
    expect(pending.filter((id) => !NEW_OPS.includes(id))).toEqual([]);
  });
  it('a handler key that is not a spec operation does not exist', () => { expect(handlerIds.filter((id) => !specIds.includes(id))).toEqual([]); });
});
