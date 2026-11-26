// PHLEBO-UI-FULL-1 (CR-C17-017) — the eight operations added after the 26 of 02-TRD §5. boot.test.ts keeps testing the original
// 26 and sets these aside (same arrangement as contract/sales1.pending.test.ts); this file pins each of them: it is in the
// spec, it has a real handler (not a stub, not pending), and it has exactly this scheme and this permission.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXED_ACTOR_PERMISSIONS, PERMISSION_CODES } from '../../../../../../../contracts/ports/generated/permissions.js';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { manifest } from '../../index.js';
import { HOMECOLLECTION_PERMISSIONS } from '../../permissions.js';

const MANAGE = 'homecollection.application.manage';
const SUBMIT = 'homecollection.application.submit';
// operationId -> [scheme, permission]. The three applicantPreAuth rows are the ONLY operations of this module that a caller
// without a staff token can reach.
const NEW_OPS: Record<string, [string, string]> = {
  updateVisitTracking: ['bearerJwt', 'homecollection.sync.upload'],
  createPhleboApplication: ['applicantPreAuth', SUBMIT],
  uploadPhleboApplicationDocumentChunk: ['applicantPreAuth', SUBMIT],
  submitPhleboApplication: ['applicantPreAuth', SUBMIT],
  listPhleboApplications: ['bearerJwt', MANAGE],
  getPhleboApplication: ['bearerJwt', MANAGE],
  downloadPhleboApplicationDocument: ['bearerJwt', MANAGE],
  decidePhleboApplication: ['bearerJwt', MANAGE],
};

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/homecollection.yaml'));
const ops: Record<string, any> = {};
for (const item of Object.values<any>(spec.paths)) for (const op of Object.values<any>(item)) if (op?.operationId) ops[op.operationId] = op;
const schemesOf = (op: any): string[] => (op.security ?? []).flatMap((s: object) => Object.keys(s));

describe('PHLEBO-UI-FULL-1: the eight added home-collection operations', () => {
  it.each(Object.entries(NEW_OPS))('%s: in the spec with exactly one scheme and its permission', (id, [scheme, permission]) => {
    expect(ops[id], id).toBeDefined();
    expect(schemesOf(ops[id])).toEqual([scheme]);
    expect(ops[id]['x-permission']).toBe(permission);
    expect(PERMISSION_CODES as readonly string[]).toContain(permission);
    expect(HOMECOLLECTION_PERMISSIONS).toContain(permission);
  });

  it('every one has a real handler: none is pending and none answers like the skeleton stub (501)', async () => {
    const pending: readonly string[] = (manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? [];
    for (const id of Object.keys(NEW_OPS)) {
      expect(pending, id).not.toContain(id);
      expect(typeof manifest.handlers[id], id).toBe('function');
    }
    // the skeleton stub answers 501 in dev; a real handler given an empty context fails some other way
    const stubLike: string[] = [];
    for (const id of Object.keys(NEW_OPS)) {
      const r: any = await Promise.resolve().then(() => manifest.handlers[id]!({ params: {}, query: {}, headers: {}, body: {} } as never, {} as never)).catch((e) => e);
      if (r?.status === 501 || r?.statusCode === 501) stubLike.push(id);
    }
    expect(stubLike).toEqual([]);
  });

  it('no other operation of the module uses a non-staff scheme', () => {
    const anonymous = Object.keys(ops).filter((id) => schemesOf(ops[id]).some((s) => s !== 'bearerJwt')).sort();
    expect(anonymous).toEqual(['createPhleboApplication', 'submitPhleboApplication', 'uploadPhleboApplicationDocumentChunk']);
  });

  it('the applicant credential holds the submit permission only, and no staff-only application permission', () => {
    expect(FIXED_ACTOR_PERMISSIONS.job_applicant_pre_auth).toEqual([SUBMIT]);
    const everyFixed = JSON.stringify(FIXED_ACTOR_PERMISSIONS);
    expect(everyFixed).not.toContain(MANAGE);
    expect(everyFixed.split(SUBMIT).length - 1).toBe(1);
    expect(Object.keys(manifest.authResolvers ?? {})).toEqual(['applicantPreAuth']);
  });
});
