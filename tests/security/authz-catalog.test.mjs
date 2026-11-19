// SEC-AUTHZ-5 (LD-189, LD-261): classifier-level proof for module catalog (contracts/openapi/catalog.yaml).
// Run: node --test tests/security/authz-catalog.test.mjs
// done_when: unguarded count of module catalog is 0 in the regenerated snapshot AND in a fresh classifier run; every former
// unguarded / guarded-other operation is guarded-exact, or guarded-other with a row in authz-exceptions.json (operationId, handlerPermission = the
// permission the classifier sees, non-empty reason), or listed in a change request .orchestra/cr/SEC-AUTHZ-5*.md (wrong contract x-permission, for C3);
// the only class `stub` left is the generated masters handlers (departments, specimen types, containers, methods: the classifier cannot see them,
// the vitest behaviour matrix proves their guard); no contract / permission registry / role pack / SQL file is edited (reviewer reads the diff).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (...p) => path.join(ROOT, ...p);
const catalogIds = readFileSync(rel('contracts', 'openapi', 'catalog.yaml'), 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^ {6}operationId:\s*(\S+)\s*$/)?.[1]).filter(Boolean);
const fresh = JSON.parse(execFileSync(process.execPath, [rel('tests', 'security', 'classify-authz.mjs')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const snap = JSON.parse(readFileSync(rel('tests', 'security', 'authz-classification.json'), 'utf8'));
const exceptions = JSON.parse(readFileSync(rel('services', 'api', 'src', 'core', 'pipeline', 'authz-exceptions.json'), 'utf8'));
const crDir = rel('.orchestra', 'cr');
const crText = existsSync(crDir) ? readdirSync(crDir).filter((f) => /^SEC-AUTHZ-5.*\.md$/.test(f)).map((f) => readFileSync(path.join(crDir, f), 'utf8')).join('\n') : '';
const GENERATED_MASTERS = new Set(['listDepartments', 'createDepartment', 'updateDepartment', 'listSpecimenTypes', 'createSpecimenType', 'updateSpecimenType',
  'listContainers', 'createContainer', 'updateContainer', 'listMethods', 'createMethod', 'updateMethod']);

test('the catalog contract scan is complete (every operationId has a class in the fresh run)', () => {
  assert.ok(catalogIds.length >= 120, `catalog.yaml has ${catalogIds.length} operations`);
  assert.equal(new Set(catalogIds).size, catalogIds.length);
  for (const id of catalogIds) assert.ok(fresh.operations[id], id);
});

for (const [label, doc] of [['fresh classifier run', fresh], ['committed snapshot tests/security/authz-classification.json', snap]]) {
  test(`${label}: module catalog has 0 unguarded operations`, () => {
    const bad = catalogIds.filter((id) => doc.operations[id]?.class === 'unguarded');
    assert.deepEqual(bad, []);
  });
  test(`${label}: every catalog operation is guarded-exact, guarded-other with an exception row or CR, or a generated masters stub`, () => {
    for (const id of catalogIds) {
      const e = doc.operations[id];
      assert.ok(e, id);
      if (e.class === 'guarded-exact') continue;
      if (e.class === 'stub') { assert.ok(GENERATED_MASTERS.has(id), `${id} is a stub: only the 12 generated masters handlers may stay stub`); continue; }
      assert.equal(e.class, 'guarded-other', `${id} is ${e.class}`);
      const row = exceptions.find((x) => x.operationId === id);
      assert.ok(row || new RegExp(`\\b${id}\\b`).test(crText), `${id}: guarded-other needs an exception row or a SEC-AUTHZ-5 change request`);
      if (row) assert.equal(row.handlerPermission, e.permission, `${id}: exception handlerPermission must equal the asserted permission`);
    }
  });
}

test('snapshot equals a fresh classifier run (the tester regenerated it after the code existed)', () => {
  assert.deepEqual(snap, fresh);
});

test('catalog exception rows: existing operationId, handlerPermission and a non-empty reason; none for a guarded-exact operation', () => {
  for (const row of exceptions.filter((x) => catalogIds.includes(x.operationId))) {
    assert.ok(row.handlerPermission && typeof row.handlerPermission === 'string', row.operationId);
    assert.ok(typeof row.reason === 'string' && row.reason.trim().length > 0, `${row.operationId}: reason`);
    assert.notEqual(fresh.operations[row.operationId].class, 'guarded-exact', `${row.operationId}: stale exception`);
  }
});

test('no exception row names a permission that does not exist in contracts/permissions.yaml (no invented code)', () => {
  const codes = new Set([...readFileSync(rel('contracts', 'permissions.yaml'), 'utf8').matchAll(/\bcode:\s*([a-z_]+(?:\.[a-z_]+)+)/g)].map((m) => m[1]));
  for (const row of exceptions.filter((x) => catalogIds.includes(x.operationId))) assert.ok(codes.has(row.handlerPermission), `${row.operationId}: ${row.handlerPermission}`);
});

test('guard exactness: a guarded-exact catalog operation asserts exactly its x-permission (no widening)', () => {
  for (const id of catalogIds) {
    const e = fresh.operations[id];
    if (e.class === 'guarded-exact') assert.equal(e.permission, e.x_permission, id);
  }
});
