// BL-T11 role / privilege contract (static): who may call B9, B10, B10a-c, B36 and what the contract promises when they may not.
// Spec: 07-SECURITY REQ-SEC-055/062/067, abuse case A7, §"privileged" table (reverse / request refund / approve refund => finance only, aal2); PRD US-BL-06.3 ("front_desk requesting a refund -> 403 auth.forbidden");
//       contracts/permissions.yaml; contracts/openapi/billing.yaml x-permission; contracts/errors.yaml. The core pipeline enforces permission + privileged (aal2, membership re-validation) from these
//       two files, so the pipeline check is only as good as these entries: they are pinned here. (Passes today: the contract rows already exist; it guards the writer from "fixing" a failing role test by editing them.)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
const load = (p: string): any => parse(readFileSync(join(root, p), 'utf8'));
const perms = load('contracts/permissions.yaml');
const api = load('contracts/openapi/billing.yaml');
const errors = load('contracts/errors.yaml');

const ops: Record<string, any> = {};
for (const [path, item] of Object.entries<any>(api.paths)) for (const [method, op] of Object.entries<any>(item)) if (op?.operationId) ops[op.operationId] = { ...op, method, path };
const perm = (code: string) => (perms.permissions as any[]).find((p) => p.code === code);

const EXPECT: Array<[string, string, string, string]> = [
  // operationId, method, x-permission, B-number
  ['reverseLedgerEntry', 'post', 'billing.payment.reverse', 'B9'],
  ['requestRefund', 'post', 'billing.refund.request', 'B10'],
  ['approveRefund', 'post', 'billing.refund.approve', 'B10a'],
  ['rejectRefund', 'post', 'billing.refund.approve', 'B10b'],
  ['listRefundRequests', 'get', 'billing.refund.approve', 'B10c'],
  ['resolveFinanceReviewItem', 'post', 'billing.refund.approve', 'B36'],
  ['listFinanceReviewItems', 'get', 'billing.invoice.read', 'B36'],
];

describe('operation -> permission mapping (02-TRD §5)', () => {
  for (const [id, method, permission, b] of EXPECT) {
    it(`${b} ${id}: ${method.toUpperCase()} requires ${permission}`, () => {
      expect(ops[id], id).toBeDefined();
      expect(ops[id].method).toBe(method);
      expect(ops[id]['x-permission']).toBe(permission);
    });
  }
  it('every money-moving or deciding operation is a POST that requires an Idempotency-Key', () => {
    for (const id of ['reverseLedgerEntry', 'requestRefund', 'approveRefund', 'rejectRefund', 'resolveFinanceReviewItem']) expect(ops[id]['x-idempotency'], id).toBe('required');
  });
  it('B10a / B10b / B36-resolve demand If-Match (precondition_required, version_conflict, immutable_record are declared)', () => {
    for (const id of ['approveRefund', 'rejectRefund', 'resolveFinanceReviewItem']) for (const c of ['common.precondition_required', 'common.version_conflict', 'common.immutable_record']) expect(ops[id]['x-error-codes'], `${id} ${c}`).toContain(c);
  });
});

describe('privileged = finance only (REQ-SEC-062/067 aal2; abuse case A7)', () => {
  for (const code of ['billing.payment.reverse', 'billing.refund.request', 'billing.refund.approve']) {
    it(`${code}: privileged and held by the finance role only (never front_desk, phlebotomist, lab or viewer roles)`, () => {
      const p = perm(code);
      expect(p, code).toBeDefined();
      expect(p.privileged).toBe(true);
      expect(p.roles).toEqual(['finance']);
    });
  }
  it('front_desk holds none of the three and cannot reach B9/B10/B10a-c/B36-resolve (PRD US-BL-06.3: 403 auth.forbidden)', () => {
    for (const [id] of EXPECT.filter((e) => e[2] !== 'billing.invoice.read')) {
      const p = perm(ops[id]['x-permission']);
      expect(p.roles, id).not.toContain('front_desk');
      expect(ops[id]['x-error-codes'], id).toContain('auth.forbidden');
    }
  });
  it('the requester and approver permissions are separate codes (a person may hold both; the service then enforces approver != requester)', () => {
    expect(perm('billing.refund.request').code).not.toBe(perm('billing.refund.approve').code);
  });
});

describe('error registry rows the refund flow relies on', () => {
  const row = (code: string) => (errors.errors ?? errors).find((e: any) => e.code === code);
  it('billing.refund_self_approval_forbidden is 403 and billing.ledger_reversal_invalid is 409', () => {
    expect(row('billing.refund_self_approval_forbidden')).toMatchObject({ http: 403 });
    expect(row('billing.ledger_reversal_invalid')).toMatchObject({ http: 409 });
  });
  it('the contract lists them on the operations that raise them', () => {
    expect(ops['approveRefund']['x-error-codes']).toEqual(expect.arrayContaining(['billing.refund_self_approval_forbidden', 'billing.ledger_reversal_invalid']));
    expect(ops['requestRefund']['x-error-codes']).toEqual(expect.arrayContaining(['billing.ledger_reversal_invalid', 'common.feature_disabled']));
    expect(ops['reverseLedgerEntry']['x-error-codes']).toContain('billing.ledger_reversal_invalid');
  });
});
