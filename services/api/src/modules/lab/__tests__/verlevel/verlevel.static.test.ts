// T0B-VERLEVEL-1 (LD-316) static checks, no database: done_when (1) FIRST PRIORITY handlers for every operation of T0C-VERLEVEL-1 so the module boot check passes again (LD-325: no pending ids left),
// the contract <-> handler tie for the 3 operations, permissions, the event producer, and source scans for append only / tenant filtered access to the two new tables.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers as typedHandlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { LAB_PERMISSIONS } from '../../permissions.js';
import { LAB_PERMS, PRIVILEGED, fileText } from '../probes/kit.js';

const NEW_OPS: Record<string, { permission: string; method: string; path: string }> = {
  listVerificationPolicies: { permission: 'lab.verification_policy.read', method: 'get', path: '/v1/lab/verification-policies' },
  upsertVerificationPolicy: { permission: 'lab.verification_policy.manage', method: 'put', path: '/v1/lab/verification-policies' },
  getResultSignoffs: { permission: 'lab.result.read', method: 'get', path: '/v1/lab/results/{result_id}/signoffs' },
};
const handlers = typedHandlers as unknown as Record<string, (...a: never[]) => Promise<unknown>>;
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/lab.yaml'));
const specIds: string[] = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p).map((m) => m?.operationId).filter(Boolean));
const MOD = 'services/api/src/modules/lab';
const walk = (dir: string): string[] => readdirSync(join(REPO_ROOT, dir)).flatMap((f) => {
  const rel = `${dir}/${f}`; return statSync(join(REPO_ROOT, rel)).isDirectory() ? (f === '__tests__' ? [] : walk(rel)) : [rel];
});
const SRC = walk(MOD).filter((f) => f.endsWith('.ts'));

describe('done_when (1): the module boot check passes with real handlers', () => {
  it('the contract has 58 lab operations: the 55 of the TRD + the 3 verification level operations', () => {
    expect(specIds).toHaveLength(58);
    for (const [id, o] of Object.entries(NEW_OPS)) {
      expect(specIds, id).toContain(id);
      const op = spec.paths[o.path]?.[o.method];
      expect(op?.operationId, `${o.method} ${o.path}`).toBe(id);
      expect(op['x-permission'], id).toBe(o.permission);
    }
  });
  it('every operationId of lab.yaml has a handler, and the handler map has nothing else', () => {
    expect(Object.keys(handlers).sort()).toEqual([...specIds].sort());
    for (const id of Object.keys(NEW_OPS)) expect(typeof handlers[id], id).toBe('function');
  });
  it('pendingOperations of lab is empty or absent: T0B-VERLEVEL-1 removed the 3 ids it implements (LD-325 (b))', () => {
    const pending = (manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? [];
    expect([...pending]).toEqual([]);
  });
  it('the three new handlers are not stubs: they do not answer common.internal for a well formed call without a database context', async () => {
    // a stub throws common.internal immediately (boot.test.ts); a real handler needs ctx.tx and fails differently (TypeError / validation), never as the stub
    for (const id of Object.keys(NEW_OPS)) {
      let err: any;
      try { await handlers[id]!({ params: {}, query: {}, headers: {}, body: {} } as never, { operationId: id, log: { info() {}, warn() {}, error() {} } } as never); } catch (e) { err = e; }
      expect(err?.code === 'common.internal' && /stub|not implemented/i.test(String(err?.message)), `${id} is still a stub`).toBe(false);
    }
  });
});

describe('permissions and events', () => {
  it('lab.verification_policy.read for every lab role, .manage only for lab_manager and privileged (aal2); the pathologist does not manage the policy', () => {
    const p = (c: string) => LAB_PERMS.find((x) => x.code === c);
    expect(p('lab.verification_policy.read')?.roles).toEqual(expect.arrayContaining(['lab_technologist', 'pathologist', 'lab_manager']));
    expect(p('lab.verification_policy.manage')?.roles).toEqual(['lab_manager']);
    expect(PRIVILEGED.has('lab.verification_policy.manage')).toBe(true);
    expect(PRIVILEGED.has('lab.verification_policy.read')).toBe(false);
    expect(LAB_PERMISSIONS).toEqual(expect.arrayContaining(['lab.verification_policy.read', 'lab.verification_policy.manage']));
  });
  it('the lab module produces lab.result.signed_off.v1 and its schema file exists', () => {
    expect([...manifest.produces]).toContain('lab.result.signed_off.v1');
    expect(existsSync(join(REPO_ROOT, 'contracts/events/lab.result.signed_off.v1.schema.json'))).toBe(true);
  });
  it('the existing verified / approved event names are still produced', () => {
    expect([...manifest.produces]).toEqual(expect.arrayContaining(['lab.result.verified.v1', 'lab.result.approved.v1', 'lab.result.amended.v1']));
  });
});

describe('source scans of the lab module (non test code)', () => {
  const touching = SRC.filter((f) => /lab\.(result_signoff|verification_policy)\b/.test(fileText(f)));
  it('the sign-off chain is append only: no UPDATE / DELETE / TRUNCATE of lab.result_signoff anywhere, no DELETE of lab.verification_policy', () => {
    const bad: string[] = [];
    for (const f of SRC) fileText(f).split('\n').forEach((l, i) => {
      if (/\b(UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+lab\.result_signoff\b/i.test(l) || /\b(DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+lab\.verification_policy\b/i.test(l)) bad.push(`${f}:${i + 1}`);
    });
    expect(bad).toEqual([]);
  });
  it('some non test file reads and writes the two tables (the feature is not only in a test)', () => {
    expect(touching.length).toBeGreaterThanOrEqual(1);
    expect(SRC.some((f) => /INSERT\s+INTO\s+lab\.result_signoff/i.test(fileText(f))), 'a sign-off row is inserted').toBe(true);
  });
  it('every file that touches the two tables filters by tenant_id explicitly (defence in depth next to RLS, REQ-SEC-024)', () => {
    for (const f of touching) expect(fileText(f), f).toMatch(/tenant_id/);
  });
  it('the signature asset reference is internal: no mapper or handler returns signer_signature_asset_id', () => {
    const out = SRC.filter((f) => /\/(mappers|handlers)\//.test(f)).filter((f) => /signer_signature_asset_id|signerSignatureAssetId/.test(fileText(f)));
    expect(out).toEqual([]);
  });
  it('no log call names a signer registration number or signature asset', () => {
    const bad: string[] = [];
    for (const f of SRC) fileText(f).split('\n').forEach((l, i) => { if (/\blog\??\.(info|warn|error|debug)\(/.test(l) && /(registration|signature|signer_)/i.test(l)) bad.push(`${f}:${i + 1}`); });
    expect(bad).toEqual([]);
  });
  it('the new rules cite the lead decision LD-316 (traceability)', () => {
    expect(SRC.filter((f) => /LD-316/.test(fileText(f))).length).toBeGreaterThanOrEqual(1);
  });
  it('the T0C migration the tests run on is present (20261117150000, merged before this task)', () => {
    expect(existsSync(join(REPO_ROOT, 'db/migrations/20261117150000_lab__add_verification_policy_and_signoffs.sql'))).toBe(true);
  });
});
