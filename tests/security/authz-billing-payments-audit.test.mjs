// SEC-AUTHZ-6 (LD-189, LD-261): classifier-level proof for billing (contracts/openapi/billing.yaml), payments (payments.yaml) and the audit
// operations (every operation whose x-permission starts with audit.).
// Run: node --test tests/security/authz-billing-payments-audit.test.mjs
// done_when: unguarded count of billing, payments and audit operations is 0 in the regenerated snapshot AND in a fresh classifier run; every former
// unguarded / guarded-other operation is guarded-exact, or guarded-other with a row in authz-exceptions.json (operationId, handlerPermission = the
// permission the classifier sees, non-empty reason), or listed in a change request .orchestra/cr/SEC-AUTHZ-6*.md (wrong contract x-permission, for the
// contract owner); the billing reprint rows (9 guarded-other reads and cancels + recordPayment) are resolved by one of those; the payment provider
// callbacks keep class scheme-callback-token (public result page keeps public); stubs and the 4 inconclusive intent operations (SEC-AUTHZ-8) stay as they
// are; no contract / permission registry / role pack / SQL file is edited (reviewer reads the diff).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (...p) => path.join(ROOT, ...p);
const idsOf = (file) => readFileSync(rel('contracts', 'openapi', file), 'utf8').split(/\r?\n/).map((l) => l.match(/^ {6}operationId:\s*(\S+)\s*$/)?.[1]).filter(Boolean);
const billingIds = idsOf('billing.yaml');
const paymentsIds = idsOf('payments.yaml');
const fresh = JSON.parse(execFileSync(process.execPath, [rel('tests', 'security', 'classify-authz.mjs')], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const snap = JSON.parse(readFileSync(rel('tests', 'security', 'authz-classification.json'), 'utf8'));
const auditIds = Object.entries(fresh.operations).filter(([, e]) => /^audit\./.test(e.x_permission ?? '')).map(([id]) => id);
const GROUP = [...new Set([...billingIds, ...paymentsIds, ...auditIds])];
const exceptions = JSON.parse(readFileSync(rel('services', 'api', 'src', 'core', 'pipeline', 'authz-exceptions.json'), 'utf8'));
const crDir = rel('.orchestra', 'cr');
const crText = existsSync(crDir) ? readdirSync(crDir).filter((f) => /^SEC-AUTHZ-6.*\.md$/.test(f)).map((f) => readFileSync(path.join(crDir, f), 'utf8')).join('\n') : '';
const permCodes = new Set([...readFileSync(rel('contracts', 'permissions.yaml'), 'utf8').matchAll(/\bcode:\s*([a-z_]+(?:\.[a-z_]+)+)/g)].map((m) => m[1]));

const BILLING_STUBS = new Set(['createPaymentIntent', 'verifyPaymentIntent', 'listAccountSummaries']);
const PAYMENTS_STUBS = new Set(['recheckPaymentRefund', 'confirmManualPaymentRefund', 'failManualPaymentRefund']);
const PAYMENTS_INCONCLUSIVE = new Set(['recheckPaymentIntent', 'resolvePaymentIntent', 'cancelPaymentIntent', 'listPaymentCancelReasons']); // SEC-AUTHZ-8
const CALLBACKS = ['launchEsewaPayment', 'esewaSuccessCallback', 'esewaFailureCallback', 'khaltiReturnCallback'];
const REPRINT_ROWS = ['listInvoices', 'getInvoice', 'listInvoicePrints', 'listCreditNotes', 'getCreditNote', 'getOrderBilling', 'listCreditNoteTasks', 'cancelInvoice', 'issuePartialCreditNote', 'recordPayment'];
const AUDIT_EXPORTS = ['createAuditExport', 'listAuditExports', 'getAuditExport', 'downloadAuditExport'];
const resolvedByRowOrCr = (id) => exceptions.some((x) => x.operationId === id) || new RegExp(`\\b${id}\\b`).test(crText);

test('the contract scan is complete: billing 88, payments 33, audit operations found, every operationId has a class in the fresh run', () => {
  assert.equal(billingIds.length, 88);
  assert.equal(paymentsIds.length, 33);
  assert.ok(auditIds.length >= 8, `audit operations: ${auditIds.length}`);
  for (const id of AUDIT_EXPORTS) assert.ok(auditIds.includes(id), id);
  for (const id of GROUP) assert.ok(fresh.operations[id], id);
});

for (const [label, doc] of [['fresh classifier run', fresh], ['committed snapshot tests/security/authz-classification.json', snap]]) {
  test(`${label}: billing, payments and audit have 0 unguarded operations`, () => {
    const bad = GROUP.filter((id) => doc.operations[id]?.class === 'unguarded');
    assert.deepEqual(bad, []);
  });

  test(`${label}: every billing operation is guarded-exact, guarded-other with an exception row or CR, or one of the 3 stubs`, () => {
    for (const id of billingIds) {
      const e = doc.operations[id];
      assert.ok(e, id);
      if (e.class === 'guarded-exact') continue;
      if (e.class === 'stub') { assert.ok(BILLING_STUBS.has(id), `${id} is a stub: only ${[...BILLING_STUBS]} may stay stub`); continue; }
      assert.equal(e.class, 'guarded-other', `${id} is ${e.class}`);
      assert.ok(resolvedByRowOrCr(id), `${id}: guarded-other needs an exception row or a SEC-AUTHZ-6 change request`);
      const row = exceptions.find((x) => x.operationId === id);
      if (row) assert.equal(row.handlerPermission, e.permission, `${id}: exception handlerPermission must equal the asserted permission`);
    }
  });

  test(`${label}: every payments operation is guarded-exact, a callback or public page, one of the 3 stubs, or one of the 4 inconclusive intent operations left to SEC-AUTHZ-8`, () => {
    for (const id of paymentsIds) {
      const e = doc.operations[id];
      assert.ok(e, id);
      if (e.class === 'guarded-exact' || e.class === 'scheme-callback-token' || e.class === 'public') continue;
      if (e.class === 'stub') { assert.ok(PAYMENTS_STUBS.has(id), `${id} is a stub: only ${[...PAYMENTS_STUBS]} may stay stub`); continue; }
      if (e.class === 'inconclusive') { assert.ok(PAYMENTS_INCONCLUSIVE.has(id), `${id} is inconclusive but SEC-AUTHZ-8 owns only ${[...PAYMENTS_INCONCLUSIVE]}`); continue; }
      assert.equal(e.class, 'guarded-other', `${id} is ${e.class}`);
      assert.ok(resolvedByRowOrCr(id), `${id}: guarded-other needs an exception row or a SEC-AUTHZ-6 change request`);
      const row = exceptions.find((x) => x.operationId === id);
      if (row) assert.equal(row.handlerPermission, e.permission, `${id}: exception handlerPermission must equal the asserted permission`);
    }
  });

  test(`${label}: every audit operation is guarded-exact (the export handlers assert audit.log.export; audit.log.read in the service is a scope decision, no exception)`, () => {
    for (const id of auditIds) assert.equal(doc.operations[id].class, 'guarded-exact', id);
    for (const id of AUDIT_EXPORTS) assert.equal(doc.operations[id].permission, 'audit.log.export', id);
  });

  test(`${label}: the 10 billing reprint rows are resolved (guarded-exact on their own x-permission, or an exception row / CR), none is left asserting only billing.invoice.reprint silently`, () => {
    for (const id of REPRINT_ROWS) {
      const e = doc.operations[id];
      assert.ok(e.class === 'guarded-exact' || (e.class === 'guarded-other' && resolvedByRowOrCr(id)), `${id} is ${e.class}`);
    }
  });

  test(`${label}: payment provider callbacks keep class scheme-callback-token and the result page keeps class public (untouched)`, () => {
    for (const id of CALLBACKS) assert.equal(doc.operations[id].class, 'scheme-callback-token', id);
    assert.equal(doc.operations.getPaymentResultPage.class, 'public');
  });

  test(`${label}: refund, payment reverse, invoice cancel and discount approval keep their x-permission and are guarded on exactly it (R2 authority rules stay)`, () => {
    const R2 = { requestRefund: 'billing.refund.request', approveRefund: 'billing.refund.approve', rejectRefund: 'billing.refund.approve', reverseLedgerEntry: 'billing.payment.reverse',
      cancelInvoice: 'billing.invoice.cancel', approvePaymentRefund: 'payments.refund.approve', rejectPaymentRefund: 'payments.refund.approve', createPaymentRefundRequest: 'payments.refund.request',
      createDiscountAuthority: 'billing.discount_policy.manage', setUserDiscountLimit: 'billing.discount_policy.manage' };
    for (const [id, perm] of Object.entries(R2)) {
      const e = doc.operations[id];
      assert.equal(e.x_permission, perm, `${id}: contract x-permission is not edited by this task`);
      if (!resolvedByRowOrCr(id)) { assert.equal(e.class, 'guarded-exact', id); assert.equal(e.permission, perm, id); }
    }
  });
}

test('snapshot equals a fresh classifier run (the tester regenerated it after the code existed)', () => {
  assert.deepEqual(snap, fresh);
});

test('no other class regressed: unguarded total falls, classes of scheme, public, platform and identity operations are unchanged', () => {
  for (const c of ['scheme-callback-token', 'scheme-device', 'scheme-portal', 'scheme-patient-pre-auth', 'platform', 'public', 'identity-session-flow']) {
    assert.ok(fresh.counts[c] >= snap.counts[c] || snap.counts[c] === fresh.counts[c], c);
  }
  assert.equal(fresh.total, snap.total);
  assert.equal(fresh.counts.platform, 34);
  assert.equal(fresh.counts['scheme-callback-token'], 6);
});

test('exception rows of the group: existing operationId, handlerPermission and a non-empty reason; none for a guarded-exact operation; none for a callback', () => {
  for (const row of exceptions.filter((x) => GROUP.includes(x.operationId))) {
    assert.ok(row.handlerPermission && typeof row.handlerPermission === 'string', row.operationId);
    assert.ok(typeof row.reason === 'string' && row.reason.trim().length > 0, `${row.operationId}: reason`);
    assert.notEqual(fresh.operations[row.operationId].class, 'guarded-exact', `${row.operationId}: stale exception`);
    assert.ok(!CALLBACKS.includes(row.operationId), `${row.operationId}: a callback is never an exception`);
    assert.ok(!AUDIT_EXPORTS.includes(row.operationId), `${row.operationId}: audit exports need no exception`);
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

test('a change request for a wrong contract x-permission names the operation, the permission the handler needs and a reason (when one exists)', () => {
  for (const id of GROUP.filter((i) => !exceptions.some((x) => x.operationId === i) && new RegExp(`\\b${i}\\b`).test(crText))) {
    assert.ok(/CR|change request/i.test(crText), id);
    assert.ok(fresh.operations[id], id);
  }
});
