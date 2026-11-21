// SEC-AUTHZ-4 (LD-189, LD-261): classifier-level proof for module identity (contracts/openapi/identity.yaml).
// Run: node --test tests/security/authz-identity.test.mjs
// done_when: unguarded count of module identity is 0 in the regenerated snapshot AND in a fresh classifier run; every former
// unguarded operation is guarded-exact, or guarded-other with a row in authz-exceptions.json (operationId, handlerPermission = the
// permission the classifier sees, non-empty reason), or listed in a change request .orchestra/cr/SEC-AUTHZ-4*.md; session-flow and
// public operations keep their class; no contract / permission registry / role pack / SQL file is edited (reviewer reads the diff).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (...p) => path.join(ROOT, ...p);
const identityIds = readFileSync(rel('contracts', 'openapi', 'identity.yaml'), 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^ {6}operationId:\s*(\S+)\s*$/)?.[1]).filter(Boolean);
const fresh = JSON.parse(execFileSync(process.execPath, [rel('tests', 'security', 'classify-authz.mjs')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const snap = JSON.parse(readFileSync(rel('tests', 'security', 'authz-classification.json'), 'utf8'));
const exceptions = JSON.parse(readFileSync(rel('services', 'api', 'src', 'core', 'pipeline', 'authz-exceptions.json'), 'utf8'));
const crDir = rel('.orchestra', 'cr');
const crText = existsSync(crDir) ? readdirSync(crDir).filter((f) => /^SEC-AUTHZ-4.*\.md$/.test(f)).map((f) => readFileSync(path.join(crDir, f), 'utf8')).join('\n') : '';
const SESSION_FLOW = ['loginStaff', 'verifyMfaChallenge', 'startMfaEnrolment', 'completeMfaEnrolment', 'resolveSession', 'logoutSession'];

for (const [label, doc] of [['fresh classifier run', fresh], ['committed snapshot tests/security/authz-classification.json', snap]]) {
  test(`${label}: module identity has 0 unguarded operations`, () => {
    assert.equal(identityIds.length, 113);
    const bad = identityIds.filter((id) => doc.operations[id]?.class === 'unguarded');
    assert.deepEqual(bad, []);
  });
  test(`${label}: every identity operation is guarded-exact, guarded-other with an exception row or CR, or keeps a non-guard class`, () => {
    const keep = new Set(['public', 'identity-session-flow', 'platform', 'stub', 'scheme-portal', 'scheme-device', 'scheme-patient-pre-auth', 'scheme-callback-token']);
    for (const id of identityIds) {
      const e = doc.operations[id];
      assert.ok(e, id);
      if (e.class === 'guarded-exact' || keep.has(e.class)) continue;
      assert.equal(e.class, 'guarded-other', `${id} is ${e.class}`);
      const row = exceptions.find((x) => x.operationId === id);
      assert.ok(row || new RegExp(`\\b${id}\\b`).test(crText), `${id}: guarded-other needs an exception row or a SEC-AUTHZ-4 change request`);
      if (row) assert.equal(row.handlerPermission, e.permission, `${id}: exception handlerPermission must equal the asserted permission`);
    }
  });
}

test('snapshot equals a fresh classifier run (the tester regenerated it after the code existed)', () => {
  assert.deepEqual(snap, fresh);
});

test('identity exception rows: existing operationId, handlerPermission and a non-empty reason; none for a guarded-exact operation', () => {
  for (const row of exceptions.filter((x) => identityIds.includes(x.operationId))) {
    assert.ok(row.handlerPermission && typeof row.handlerPermission === 'string', row.operationId);
    assert.ok(typeof row.reason === 'string' && row.reason.trim().length > 0, `${row.operationId}: reason`);
    assert.notEqual(fresh.operations[row.operationId].class, 'guarded-exact', `${row.operationId}: stale exception`);
  }
});

test('session, login, MFA, recovery and setup operations keep their class (not touched)', () => {
  for (const id of SESSION_FLOW) assert.equal(fresh.operations[id].class, 'identity-session-flow', id);
  const pub = identityIds.filter((id) => ['public', 'identity-session-flow'].includes(fresh.operations[id].class));
  assert.equal(pub.length, 15, 'six session-flow + nine public identity operations');
});

test('guard exactness: a guarded-exact identity operation asserts exactly its x-permission (no widening)', () => {
  for (const id of identityIds) {
    const e = fresh.operations[id];
    if (e.class === 'guarded-exact') assert.equal(e.permission, e.x_permission, id);
  }
});
