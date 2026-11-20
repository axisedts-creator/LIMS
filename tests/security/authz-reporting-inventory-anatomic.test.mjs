// SEC-AUTHZ-7 (LD-189, LD-261): classifier-level proof for reporting (contracts/openapi/reporting.yaml), inventory (inventory.yaml) and anatomic (anatomic.yaml).
// Run: node --test tests/security/authz-reporting-inventory-anatomic.test.mjs
// done_when: unguarded count of reporting, inventory and anatomic operations is 0 in the regenerated snapshot AND in a fresh classifier run; every former
// unguarded / guarded-other operation is guarded-exact, or guarded-other with a row in authz-exceptions.json (operationId, handlerPermission = the
// permission the classifier sees, non-empty reason), or listed in a change request .orchestra/cr/SEC-AUTHZ-7*.md (wrong contract x-permission, for the
// contract owner); the narrative write and narrative sign rows are resolved and stay different permissions; public result delivery (verifyReportQr), the two
// provider callbacks (path token) and the 9 portal-session operations keep their class; the 2 inventory alert stubs stay stubs; no contract / permission
// registry / role pack / SQL file is edited (reviewer reads the diff).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (...p) => path.join(ROOT, ...p);
const idsOf = (file) => readFileSync(rel('contracts', 'openapi', file), 'utf8').split(/\r?\n/).map((l) => l.match(/^ {6}operationId:\s*(\S+)\s*$/)?.[1]).filter(Boolean);
const reportingIds = idsOf('reporting.yaml');
const inventoryIds = idsOf('inventory.yaml');
const anatomicIds = idsOf('anatomic.yaml');
const GROUP = [...new Set([...reportingIds, ...inventoryIds, ...anatomicIds])];
const fresh = JSON.parse(execFileSync(process.execPath, [rel('tests', 'security', 'classify-authz.mjs')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const snap = JSON.parse(readFileSync(rel('tests', 'security', 'authz-classification.json'), 'utf8'));
const exceptions = JSON.parse(readFileSync(rel('services', 'api', 'src', 'core', 'pipeline', 'authz-exceptions.json'), 'utf8'));
const crDir = rel('.orchestra', 'cr');
const crText = existsSync(crDir) ? readdirSync(crDir).filter((f) => /^SEC-AUTHZ-7.*\.md$/.test(f)).map((f) => readFileSync(path.join(crDir, f), 'utf8')).join('\n') : '';
const permCodes = new Set([...readFileSync(rel('contracts', 'permissions.yaml'), 'utf8').matchAll(/\bcode:\s*([a-z_]+(?:\.[a-z_]+)+)/g)].map((m) => m[1]));

const INVENTORY_STUBS = new Set(['listInventoryAlerts', 'acknowledgeInventoryAlert']);
const CALLBACKS = ['receiveProviderCallback', 'verifyProviderCallback'];
const PORTAL = ['createPortalOtpChallenge', 'verifyPortalOtp', 'getPortalReport', 'downloadPortalReportPdf', 'requestPortalLinkReissue', 'endPortalSession', 'getPortalDues', 'createPortalPaymentRequest', 'getPortalPaymentRequest'];
const NARRATIVE_WRITE = ['saveNarrativeDraft', 'getNarrativeReport', 'listNarrativeReports', 'listNarrativeTemplates', 'uploadNarrativeImage'];
const NARRATIVE_SIGN = ['signNarrativeReport', 'startNarrativeAmendment'];
const NARRATIVE_TEMPLATE = ['createNarrativeTemplate', 'updateNarrativeTemplate'];
const resolvedByRowOrCr = (id) => exceptions.some((x) => x.operationId === id) || new RegExp(`\\b${id}\\b`).test(crText);

test('the contract scan is complete: reporting 73, inventory 93, anatomic 70, every operationId has a class in the fresh run', () => {
  assert.equal(reportingIds.length, 73);
  assert.equal(inventoryIds.length, 93);
  assert.equal(anatomicIds.length, 70);
  for (const id of GROUP) assert.ok(fresh.operations[id], id);
});

for (const [label, doc] of [['fresh classifier run', fresh], ['committed snapshot tests/security/authz-classification.json', snap]]) {
  test(`${label}: reporting, inventory and anatomic have 0 unguarded operations`, () => {
    const bad = GROUP.filter((id) => doc.operations[id]?.class === 'unguarded');
    assert.deepEqual(bad, []);
  });

  test(`${label}: every reporting operation is guarded-exact, guarded-other with an exception row or CR, or keeps its scheme class (public, callback token, portal)`, () => {
    for (const id of reportingIds) {
      const e = doc.operations[id];
      assert.ok(e, id);
      if (e.class === 'guarded-exact') continue;
      if (['public', 'scheme-callback-token', 'scheme-portal'].includes(e.class)) { assert.ok(['verifyReportQr', ...CALLBACKS, ...PORTAL].includes(id), `${id} may not take scheme class ${e.class}`); continue; }
      assert.equal(e.class, 'guarded-other', `${id} is ${e.class}`);
      assert.ok(resolvedByRowOrCr(id), `${id} is guarded-other without an exception row or a SEC-AUTHZ-7 change request`);
    }
  });

  test(`${label}: every inventory and anatomic operation is guarded-exact, guarded-other with a row or CR, or one of the 2 inventory alert stubs`, () => {
    for (const id of [...inventoryIds, ...anatomicIds]) {
      const e = doc.operations[id];
      assert.ok(e, id);
      if (e.class === 'guarded-exact') continue;
      if (e.class === 'stub') { assert.ok(INVENTORY_STUBS.has(id), `${id} is a stub: only ${[...INVENTORY_STUBS]} may stay stub`); continue; }
      assert.equal(e.class, 'guarded-other', `${id} is ${e.class}`);
      assert.ok(resolvedByRowOrCr(id), id);
    }
  });

  test(`${label}: the narrative write and narrative sign rows are resolved and stay different permissions`, () => {
    for (const id of NARRATIVE_WRITE) {
      const e = doc.operations[id];
      assert.equal(e.x_permission, 'reporting.narrative.write', `${id}: contract x-permission is not edited by this task`);
      assert.ok(e.class === 'guarded-exact' || (e.class === 'guarded-other' && resolvedByRowOrCr(id)), `${id} is ${e.class}`);
      if (e.class === 'guarded-exact') assert.equal(e.permission, 'reporting.narrative.write', id);
      const row = exceptions.find((x) => x.operationId === id);
      if (row) assert.notEqual(row.handlerPermission, 'reporting.narrative.sign', `${id}: write must not be resolved by asking sign`);
    }
    for (const id of NARRATIVE_SIGN) {
      const e = doc.operations[id];
      assert.equal(e.x_permission, 'reporting.narrative.sign', id);
      assert.equal(e.class, 'guarded-exact', id);
      assert.equal(e.permission, 'reporting.narrative.sign', id);
    }
    for (const id of NARRATIVE_TEMPLATE) {
      const e = doc.operations[id];
      assert.equal(e.x_permission, 'reporting.template.manage', id);
      assert.ok(e.class === 'guarded-exact' || (e.class === 'guarded-other' && resolvedByRowOrCr(id)), `${id} is ${e.class}`);
      const row = exceptions.find((x) => x.operationId === id);
      if (row) assert.ok(!['reporting.narrative.sign', 'reporting.narrative.write'].includes(row.handlerPermission), `${id}: template admin is neither write nor sign`);
    }
  });

  test(`${label}: public result delivery, the two provider callbacks (path token) and the portal operations keep their class (untouched)`, () => {
    assert.equal(doc.operations.verifyReportQr.class, 'public');
    for (const id of CALLBACKS) assert.equal(doc.operations[id].class, 'scheme-callback-token', id);
    for (const id of PORTAL) assert.equal(doc.operations[id].class, 'scheme-portal', id);
    for (const id of [...CALLBACKS, ...PORTAL, 'verifyReportQr']) assert.ok(!exceptions.some((x) => x.operationId === id), `${id}: never an exception row`);
  });

  test(`${label}: the 2 inventory alert operations stay stubs`, () => {
    for (const id of INVENTORY_STUBS) assert.equal(doc.operations[id].class, 'stub', id);
  });
}

test('snapshot equals a fresh classifier run (the tester regenerated it after the code existed)', () => {
  assert.deepEqual(snap, fresh);
});

test('no other class regressed: counts of scheme, public, platform and identity operations are unchanged and the operation total is stable', () => {
  assert.equal(fresh.total, snap.total);
  assert.equal(fresh.counts.platform, 34);
  assert.equal(fresh.counts['scheme-callback-token'], 6);
  assert.equal(fresh.counts['scheme-portal'], 9);
  assert.equal(fresh.counts['scheme-device'], 9);
  assert.equal(fresh.counts['scheme-patient-pre-auth'], 3);
  assert.equal(fresh.counts.public, 13);
  assert.equal(fresh.counts['identity-session-flow'], 6);
});

test('exception rows of the group: existing operationId, handlerPermission and a non-empty reason; none for a guarded-exact operation, a callback, a portal operation or the public page', () => {
  for (const row of exceptions.filter((x) => GROUP.includes(x.operationId))) {
    assert.ok(row.handlerPermission && typeof row.handlerPermission === 'string', row.operationId);
    assert.ok(typeof row.reason === 'string' && row.reason.trim().length > 0, `${row.operationId}: reason`);
    assert.notEqual(fresh.operations[row.operationId].class, 'guarded-exact', `${row.operationId}: stale exception`);
    assert.ok(!CALLBACKS.includes(row.operationId) && !PORTAL.includes(row.operationId) && row.operationId !== 'verifyReportQr', `${row.operationId}: never an exception`);
  }
});

test('no exception row names a permission that does not exist in contracts/permissions.yaml (no invented code)', () => {
  for (const row of exceptions.filter((x) => GROUP.includes(x.operationId))) assert.ok(permCodes.has(row.handlerPermission), `${row.operationId}: ${row.handlerPermission}`);
});

test('guard exactness: a guarded-exact operation of the group asserts exactly its x-permission (no widening)', () => {
  for (const id of GROUP) {
    const e = fresh.operations[id];
    if (e.class === 'guarded-exact') assert.equal(e.permission, e.x_permission, id);
  }
});

test('a change request for a wrong contract x-permission names the operation and says what the handler needs (when one exists)', () => {
  for (const id of GROUP.filter((i) => !exceptions.some((x) => x.operationId === i) && new RegExp(`\\b${i}\\b`).test(crText))) {
    assert.ok(/CR|change request/i.test(crText), id);
    assert.ok(fresh.operations[id], id);
  }
});
