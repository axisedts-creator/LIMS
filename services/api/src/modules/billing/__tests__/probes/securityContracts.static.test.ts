// BL-T22 / 07-SECURITY §6.4 (privilege table), §6.5 (contract-level business-logic security), §6.6 (download headers, no Storage URLs — P-2).
// Static over contracts/openapi/{frontdesk,billing}.yaml + permissions.yaml + errors.yaml: the core pipeline enforces permission, aal2 (`privileged`) and
// membership re-validation FROM these files, so the table is only as good as the rows. Mostly passes today (rows exist): it pins them against the writer "fixing" a failing probe by editing a row.
// The behavioural halves (actual 403s, IdentityPort re-validation, locked account) are the core pipeline's (C0 tests) and the service tests of BL-T10/T11/T13/T14, FD-T06..T09.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { ALL_OPS, deref } from './probe.kit.js';

const load = (p: string): any => parse(readFileSync(join(REPO_ROOT, p), 'utf8'));
const perms: any[] = load('contracts/permissions.yaml').permissions;
const errs: any[] = (load('contracts/errors.yaml').errors ?? load('contracts/errors.yaml'));
const perm = (c: string) => perms.find((p) => p.code === c);
const op = (id: string) => ALL_OPS.find((o) => o.id === id)!;
const err = (c: string) => errs.find((e) => e.code === c);

describe('§6.4 privileged operations: no permission => 403 auth.forbidden, permission at aal1 => 403 auth.mfa_required', () => {
  // operationId -> required x-permission (the "privileged" rows of the §6.4 table + 02-TRD §5)
  const PRIVILEGED: Array<[string, string]> = [
    ['approveDiscount', 'frontdesk.discount.approve'], ['rejectDiscount', 'frontdesk.discount.approve'],
    ['cancelInvoice', 'billing.invoice.cancel'], ['issuePartialCreditNote', 'billing.invoice.cancel'],
    ['reverseLedgerEntry', 'billing.payment.reverse'], ['requestRefund', 'billing.refund.request'], ['approveRefund', 'billing.refund.approve'],
    ['createBillingExport', 'billing.data.export'], ['getAuditTrail', 'billing.data.export'], ['getBillingExport', 'billing.data.export'], ['getBillingExportContent', 'billing.data.export'],
    ['createReleaseOverride', 'billing.release.override'],
    ['updateCreditAccount', 'billing.credit_party.manage'], ['issuePeriodicInvoice', 'billing.credit_party.manage'],
    ['getBillingSettings', 'billing.settings.manage'], ['updateBillingSettings', 'billing.settings.manage'], ['retryCbmsDocument', 'billing.settings.manage'],
    ['anonymisePatient', 'frontdesk.patient.anonymise'],
  ];
  for (const [id, code] of PRIVILEGED) {
    it(`${id}: x-permission ${code}, privileged (aal2) in permissions.yaml, 403 auth.forbidden declared`, () => {
      expect(op(id), id).toBeDefined();
      expect(op(id).permission).toBe(code);
      expect(perm(code), code).toBeDefined();
      expect(perm(code).privileged, `${code} must be privileged`).toBe(true);
      expect(op(id).op['x-error-codes']).toContain('auth.forbidden');
    });
  }
  it('the aal1 refusal (auth.mfa_required 403) and the locked-account refusal are registered', () => {
    expect(err('auth.mfa_required')).toMatchObject({ http: 403 });
    expect(err('auth.forbidden')).toMatchObject({ http: 403 });
    expect(err('auth.account_locked')).toMatchObject({ http: 403 });
  });
  it('approve own refund: 403 billing.refund_self_approval_forbidden is registered and declared on B10a', () => {
    expect(err('billing.refund_self_approval_forbidden')).toMatchObject({ http: 403 });
    expect(op('approveRefund').op['x-error-codes']).toContain('billing.refund_self_approval_forbidden');
  });
  it('close another user\'s cash session: B16 closeCashSession needs only billing.payment.record, so the owner check is the service\'s and 403 auth.forbidden is declared', () => {
    expect(op('closeCashSession').permission).toBe('billing.payment.record');
    expect(op('closeCashSession').op['x-error-codes']).toContain('auth.forbidden');
  });
  it('centre_staff holds no billing.invoice.issue (cash registration => 403 auth.forbidden) yet may register credit orders', () => {
    expect(perm('billing.invoice.issue').roles).not.toContain('centre_staff');
    expect(perm('frontdesk.registration.create').roles).toContain('centre_staff');
    expect(op('createRegistration').op['x-error-codes']).toContain('auth.forbidden');
  });
  it('front_desk holds none of the finance-only permissions (refund, reverse, cancel, export, credit manage)', () => {
    for (const c of ['billing.payment.reverse', 'billing.refund.request', 'billing.refund.approve', 'billing.invoice.cancel', 'billing.data.export', 'billing.credit_party.manage'])
      expect(perm(c).roles, c).not.toContain('front_desk');
  });
  it('patient / portal / partner roles hold no frontdesk.* or billing.* permission (app.is_staff_or_system sees no rows for them)', () => {
    for (const p of perms.filter((x) => /^(frontdesk|billing)\./.test(x.code))) for (const r of ['patient', 'portal', 'partner']) expect(p.roles, `${p.code}/${r}`).not.toContain(r);
  });
});

describe('§6.5 contract-level business-logic security', () => {
  const body = (id: string) => deref(op(id).spec, deref(op(id).spec, op(id).op.requestBody).content['application/json'].schema);
  const props = (id: string) => Object.keys(deref(op(id).spec, body(id)).properties ?? {});

  it('every money-moving or state-deciding POST requires an Idempotency-Key and declares 422 common.idempotency_key_reused', () => {
    const cmds = ALL_OPS.filter((o) => o.method === 'post' && o.idempotency === 'required');
    expect(cmds.length).toBeGreaterThan(20);
    for (const o of cmds) expect(o.op['x-error-codes'], o.id).toContain('common.idempotency_key_reused');
    expect(err('common.idempotency_key_reused')).toMatchObject({ http: 422 });
    for (const id of ['recordPayment', 'reverseLedgerEntry', 'requestRefund', 'approveRefund', 'cancelInvoice', 'issuePartialCreditNote', 'createRegistration', 'approveDiscount']) expect(op(id).idempotency, id).toBe('required');
  });
  it('B12 createPaymentIntent never accepts a client-supplied return URL or gateway fields (08 A19 D-113); payments.return_url_not_allowed propagates', () => {
    const p = props('createPaymentIntent');
    for (const k of ['return_url', 'returnUrl', 'success_url', 'failure_url', 'callback_url', 'fields', 'redirect_url']) expect(p, k).not.toContain(k);
    expect(op('createPaymentIntent').op['x-error-codes']).toContain('payments.return_url_not_allowed');
    expect(op('verifyPaymentIntent').op['x-error-codes'] ?? []).not.toContain('payments.return_url_not_allowed');
  });
  it('B12 verify takes no gateway fields from the staff browser either', () => {
    const rb = deref(op('verifyPaymentIntent').spec, op('verifyPaymentIntent').op.requestBody);
    const props2 = rb ? Object.keys(deref(op('verifyPaymentIntent').spec, rb.content['application/json']?.schema)?.properties ?? {}) : [];
    expect(props2).not.toContain('fields');
  });
  it('approval binding / stale quote / amount mismatch / overpayment / reversal error codes are registered and declared', () => {
    for (const [id, c] of [['approveRefund', 'billing.ledger_reversal_invalid'], ['reverseLedgerEntry', 'billing.ledger_reversal_invalid'], ['approveRefund', 'billing.refund_self_approval_forbidden']] as const) expect(op(id).op['x-error-codes'], `${id} ${c}`).toContain(c);
    const code = (id: string) => (op(id).op['x-error-codes'] as string[]);
    expect(code('recordPayment'), 'overpayment refusal').toEqual(expect.arrayContaining(['billing.payment_exceeds_due', 'billing.order_not_invoiced']));
    expect(code('createRegistration'), 'approval required / stale quote').toEqual(expect.arrayContaining(['frontdesk.discount_approval_required', 'common.version_conflict']));
    expect(code('approveDiscount'), 'approver != requester').toContain('frontdesk.discount_self_approval_forbidden');
  });
  it('If-Match is demanded on decide/resolve operations (concurrent approvers cannot both win)', () => {
    for (const id of ['approveRefund', 'rejectRefund', 'approveDiscount', 'rejectDiscount', 'resolveFinanceReviewItem', 'resolveOrderFlag'])
      expect(op(id).op['x-error-codes'], id).toEqual(expect.arrayContaining(['common.precondition_required', 'common.version_conflict']));
  });
  it('rate tier is `general` for every C4 operation (07 §8)', () => {
    for (const o of ALL_OPS) expect(o.op['x-rate-limit-tier'], o.id).toBe('general');
  });
});

describe('§6.6 download endpoints and the no-Storage-URL rule (REQ-SEC-083/084/085, P-2)', () => {
  for (const id of ['getTrfAttachmentContent', 'getBillingExportContent']) {
    it(`${id}: 200 declares Content-Disposition: attachment, X-Content-Type-Options: nosniff, Cache-Control: no-store`, () => {
      const o = op(id);
      const headers = deref(o.spec, o.op.responses['200']).headers ?? {};
      const h = Object.fromEntries(Object.entries<any>(headers).map(([k, v]) => [k.toLowerCase(), deref(o.spec, v)]));
      expect(Object.keys(h)).toEqual(expect.arrayContaining(['content-disposition', 'x-content-type-options', 'cache-control']));
      expect(JSON.stringify(h['x-content-type-options'])).toContain('nosniff');
      expect(JSON.stringify(h['cache-control'])).toContain('no-store');
    });
  }
  it('F21 uploadTrf accepts only image/jpeg, image/png, application/pdf (no SVG, no HTML, no executables)', () => {
    expect(op('uploadTrf').op['x-upload']).toEqual(['image/jpeg', 'image/png', 'application/pdf']);
    expect(op('uploadTrf').op['x-error-codes']).toEqual(expect.arrayContaining(['common.unsupported_media_type']));
  });
  it('no response schema of any C4 operation exposes a Storage URL / signed URL / bucket / object key', () => {
    const bad = /(storage|signed|presigned|download)_?url|bucket|object_?key|storage_?path|s3_/i;
    const offenders: string[] = [];
    const walk = (spec: any, n: any, at: string, seen = new Set<any>()) => {
      const s = deref(spec, n);
      if (!s || typeof s !== 'object' || seen.has(s)) return;
      seen.add(s);
      for (const [k, v] of Object.entries<any>(s.properties ?? {})) { if (bad.test(k)) offenders.push(`${at}.${k}`); walk(spec, v, `${at}.${k}`, seen); }
      for (const k of ['items', 'additionalProperties']) walk(spec, s[k], `${at}[]`, seen);
      for (const k of ['allOf', 'oneOf', 'anyOf']) for (const x of s[k] ?? []) walk(spec, x, at, seen);
    };
    for (const o of ALL_OPS) for (const [code, r] of Object.entries<any>(o.op.responses ?? {})) {
      const c = deref(o.spec, r)?.content ?? {};
      for (const m of Object.values<any>(c)) walk(o.spec, m.schema, `${o.id}.${code}`);
    }
    expect(offenders).toEqual([]);
  });
});
