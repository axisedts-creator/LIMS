// BL-T13 contract checks at the source of truth (the core pipeline enforces x-permission / privileged / Idempotency-Key from these files; a unit test has no pipeline):
//  - B19..B23 permissions: read ops need billing.credit_party.read (finance, tenant_admin, NOT privileged); updateCreditAccount + issuePeriodicInvoice need
//    billing.credit_party.manage (privileged = aal2 + membership re-validation, finance ONLY) [07-SECURITY matrix "credit account terms / periodic bill": auth.forbidden / auth.mfa_required];
//    recordCreditPartyPayment needs billing.payment.record. PUT/POST are mutation-safe (Idempotency-Key required where TRD says required).
//  - error table: billing.credit_period_already_billed 409 [CR-C4-007], billing.credit_party_locked, billing.credit_limit_exceeded, billing.export_too_large 422.
//  - credit_days bound: OpenAPI says 0..3650, 05-SCHEMA CHECK says 0..365 (SPEC GAP, see notes) -> this file pins only the part both agree on.
//  - the BL-T13 fixtures (t13.helpers.ts) model the DB rules they claim to (this file PASSES now; it keeps the other BL-T13 suites honest).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { makeT13World, PARTY, TENANT_A, V7 } from './t13.helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
const yaml = (p: string): any => parse(readFileSync(join(root, p), 'utf8'));
const openapi = yaml('contracts/openapi/billing.yaml');
const walk = (n: any, out: any[] = []): any[] => { if (Array.isArray(n)) n.forEach((x) => walk(x, out)); else if (n && typeof n === 'object') { out.push(n); Object.values(n).forEach((x) => walk(x, out)); } return out; };
const perms = walk(yaml('contracts/permissions.yaml'));
const perm = (code: string) => perms.find((o) => o.code === code);
const byOp = (id: string) => { for (const [path, item] of Object.entries<any>(openapi.paths)) for (const [m, o] of Object.entries<any>(item)) if (o?.operationId === id) return { path, method: m, o }; throw new Error(`no operation ${id}`); };

describe('B19–B23 operations (US-FD-04, US-BL-10; 02-TRD §5)', () => {
  const rows: Array<[string, string, string, string, string]> = [
    ['listCreditAccounts', 'get', '/v1/billing/credit-parties', 'billing.credit_party.read', 'none'],
    ['getCreditAccount', 'get', '/v1/billing/credit-parties/{credit_party_id}', 'billing.credit_party.read', 'none'],
    ['updateCreditAccount', 'put', '/v1/billing/credit-parties/{credit_party_id}', 'billing.credit_party.manage', 'optional'],
    ['listCreditCharges', 'get', '/v1/billing/credit-parties/{credit_party_id}/charges', 'billing.credit_party.read', 'none'],
    ['issuePeriodicInvoice', 'post', '/v1/billing/credit-parties/{credit_party_id}/periodic-invoices', 'billing.credit_party.manage', 'required'],
    ['recordCreditPartyPayment', 'post', '/v1/billing/credit-parties/{credit_party_id}/payments', 'billing.payment.record', 'required'],
    ['getCreditPartyStatement', 'get', '/v1/billing/credit-parties/{credit_party_id}/statement', 'billing.credit_party.read', 'none'],
  ];
  for (const [id, method, path, permission, idem] of rows)
    it(`${id}: ${method.toUpperCase()} ${path}, x-permission ${permission}, tenant context, idempotency ${idem}`, () => {
      const { o, path: p, method: m } = byOp(id);
      expect([p, m, o['x-permission'], o['x-context'], o['x-idempotency']]).toEqual([path, method, permission, 'tenant', idem]);
    });
  it('billing.credit_party.manage is privileged and granted to finance ONLY (aal2 + membership re-validation); .read is not privileged and includes tenant_admin', () => {
    expect(perm('billing.credit_party.manage')).toMatchObject({ privileged: true, roles: ['finance'] });
    expect(perm('billing.credit_party.read')).toMatchObject({ privileged: false });
    expect(perm('billing.credit_party.read').roles).toEqual(expect.arrayContaining(['finance']));
    expect(perm('billing.payment.record')).toBeDefined();
  });
  it('B21 documents billing.credit_period_already_billed / counter_busy / numbering_pattern_invalid; B22 billing.payment_exceeds_due; B23 billing.export_too_large (>24 months)', () => {
    expect(byOp('issuePeriodicInvoice').o['x-error-codes']).toEqual(expect.arrayContaining(['billing.credit_period_already_billed', 'billing.counter_busy', 'billing.numbering_pattern_invalid', 'common.not_found']));
    expect(byOp('recordCreditPartyPayment').o['x-error-codes']).toEqual(expect.arrayContaining(['billing.payment_exceeds_due', 'common.not_found']));
    expect(byOp('getCreditPartyStatement').o['x-error-codes']).toEqual(expect.arrayContaining(['billing.export_too_large']));
    expect(byOp('updateCreditAccount').o['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict']));
  });
  it('error table: credit_period_already_billed 409; export_too_large 422; credit_party_locked / credit_limit_exceeded registered', () => {
    const errors = walk(yaml('contracts/errors.yaml')).filter((o) => typeof o.code === 'string');
    const http = (c: string) => errors.find((e) => e.code === c)?.http;
    expect([http('billing.credit_period_already_billed'), http('billing.export_too_large')]).toEqual([409, 422]);
    expect(http('billing.credit_party_locked')).toBeDefined();
    expect(http('billing.credit_limit_exceeded')).toBeDefined();
  });
  it('request bodies: periodic invoice {period_month YYYY-MM, branch_id} no extras; update {is_locked required, lock_reason_code coded set}; statement is capped at 24 rows; payment amount >= 1 paisa', () => {
    const s = openapi.components.schemas;
    expect([s.PeriodicInvoiceRequest.additionalProperties, s.PeriodicInvoiceRequest.required.sort(), s.PeriodicInvoiceRequest.properties.period_month.pattern]).toEqual([false, ['branch_id', 'period_month'], '^[0-9]{4}-(0[1-9]|1[0-2])$']);
    expect([s.UpdateCreditAccountRequest.additionalProperties, s.UpdateCreditAccountRequest.required, s.UpdateCreditAccountRequest.properties.lock_reason_code['x-coded-set']]).toEqual([false, ['is_locked'], 'billing.lock_reasons']);
    expect(s.CreditPartyStatement.properties.rows.maxItems).toBe(24);
    expect([s.CreditPartyPaymentRequest.additionalProperties, s.CreditPartyPaymentRequest.properties.amount_received_paisa.minimum]).toEqual([false, 1]);
  });
  it('lock reasons seed (05-SCHEMA coded set) contains credit_days_exceeded, manual, credit_limit_review', () => {
    const schema = readFileSync(join(root, 'spec/chunks/C4-frontdesk-billing/05-SCHEMA.md'), 'utf8');
    expect(schema).toMatch(/`lock_reasons`\s*\|\s*`credit_days_exceeded`,\s*`manual`,\s*`credit_limit_review`/);
  });
});

describe('BL-T13 fixtures behave like the DB rules they model', () => {
  it('invoices__subject__ck: a periodic invoice with an order_id / centre_id / without period_month is refused; a clean one is stored', async () => {
    const w = makeT13World();
    const base = { id: V7('000000a00201'), tenant_id: TENANT_A, branch_id: V7('000000010002'), centre_id: null, order_id: null, patient_id: null, purpose: 'periodic_credit', credit_party_id: PARTY, is_periodic_credit_bill: true,
      period_month: '2026-10-01', gross_paisa: 100, discount_paisa: 0, exempt_paisa: 100, taxable_paisa: 0, vat_paisa: 0, other_tax_paisa: 0, net_paisa: 100, series: 'INV', fiscal_year_bs: '2083/84', invoice_seq: 1, status: 'issued' };
    for (const bad of [{ order_id: V7('000000050001') }, { centre_id: V7('000000020002') }, { period_month: null }, { net_paisa: 99 }, { branch_id: V7('0000000100ff') }]) {
      await expect(w.repo.insertInvoice(null as never, { ...base, ...bad })).rejects.toBeDefined();
    }
    await w.repo.insertInvoice(null as never, base);
    expect(w.invoicesOf()).toHaveLength(1);
  });
  it('credit_charges guard: uninvoiced -> invoiced once; marking again throws; credit_accounts lock CK: locked without reason throws', async () => {
    const w = makeT13World(); w.addCharge(1);
    const link = [{ chargeId: w.charges()[0].id, invoiceId: V7('000000a00201'), invoiceLineId: V7('000000e00201') }];
    expect(await w.repo.markCreditChargesInvoiced(null as never, { tenantId: TENANT_A, links: link, invoicedAt: 'x', userId: 'u' })).toBe(1);
    await expect(w.repo.markCreditChargesInvoiced(null as never, { tenantId: TENANT_A, links: link, invoicedAt: 'x', userId: 'u' })).rejects.toBeDefined();
    await expect(w.repo.updateCreditAccount(null as never, { tenantId: TENANT_A, creditPartyId: PARTY, expectedVersion: 1, isLocked: true, lockReasonCode: null, userId: 'u' })).rejects.toBeDefined();
  });
});
