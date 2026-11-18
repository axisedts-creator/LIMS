// T0C-VERLEVEL-1 (LD-316, LD-325(b), LD-335) — the three verification level operations must not break module boot:
// every operationId of lab.yaml has a handler OR is listed in the manifest's pendingOperations (core/module.ts checkHandlers, AC-0D-1.2 with BOOTGATE-1);
// every pending id is a real operationId. The T0B-VERLEVEL-1 handler task moves the three ids from pending to handlers; this test stays green on both sides of that move.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';
import { LAB_PERMISSIONS } from '../../permissions.js';

const NEW_OPS = ['listVerificationPolicies', 'upsertVerificationPolicy', 'getResultSignoffs'];
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/lab.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const handlerIds = Object.keys(manifest.handlers);
const pending: string[] = [...(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? [])];

describe('T0C-VERLEVEL-1: lab manifest covers the new operations (handler or pending)', () => {
  it('the three verification level operations are in the spec', () => {
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
  it('each of the three ids is handled or pending; nothing else may be pending in lab; the 55 original operations keep their handlers', () => {
    for (const id of NEW_OPS) expect(handlerIds.includes(id) || pending.includes(id), `${id} neither handled nor pending`).toBe(true);
    expect(pending.filter((id) => !NEW_OPS.includes(id)), 'only the verification level operations may be pending in lab').toEqual([]);
    for (const id of ['verifyResult', 'bulkVerifyResults', 'approveResult', 'bulkApproveResults', 'amendResult', 'listVerificationQueue', 'getResult']) expect(handlerIds, `${id} keeps its handler`).toContain(id);
  });
  it('LAB_PERMISSIONS carries the two new codes (every lab.* code of the registry, no invented code)', () => {
    expect(LAB_PERMISSIONS).toContain('lab.verification_policy.read');
    expect(LAB_PERMISSIONS).toContain('lab.verification_policy.manage');
  });
});
