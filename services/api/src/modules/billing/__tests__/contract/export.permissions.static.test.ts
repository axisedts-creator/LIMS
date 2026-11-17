// BL-T15 static contract: who may call B24-B29a, what the contract promises (privileged data.export, no URL, download headers, error rows). Spec: 02-TRD §5 B24-B29a, PRD US-BL-12.4/12.5, 07-SECURITY
// (exports row: privileged + aal2, row cap, no shareable URL), contracts/permissions.yaml, contracts/openapi/billing.yaml, contracts/errors.yaml. The core pipeline enforces permission + privileged (aal2)
// from these files, so they are pinned here. (Passes today; it guards the writer from "fixing" a failing test by editing the contract rows.)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadBillingConfig } from '../../config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
const load = (p: string): any => parse(readFileSync(join(root, p), 'utf8'));
const perms = load('contracts/permissions.yaml'), api = load('contracts/openapi/billing.yaml'), errors = load('contracts/errors.yaml');
const ops: Record<string, any> = {};
for (const [path, item] of Object.entries<any>(api.paths)) for (const [method, op] of Object.entries<any>(item)) if (op?.operationId) ops[op.operationId] = { ...op, method, path };
const perm = (c: string) => (perms.permissions as any[]).find((p) => p.code === c);

const EXPECT: Array<[string, string, string, string, string]> = [
  ['getSalesRegister', 'get', 'billing.invoice.read', 'B24', '/v1/billing/registers/sales'],
  ['getCancelledInvoiceRegister', 'get', 'billing.invoice.read', 'B25', '/v1/billing/registers/cancelled-invoices'],
  ['getCreditNoteRegister', 'get', 'billing.invoice.read', 'B26', '/v1/billing/registers/credit-notes'],
  ['getAuditTrail', 'get', 'billing.data.export', 'B27', '/v1/billing/audit-trail'],
  ['createBillingExport', 'post', 'billing.data.export', 'B28', '/v1/billing/exports'],
  ['getBillingExport', 'get', 'billing.data.export', 'B29', '/v1/billing/exports/{export_id}'],
  ['getBillingExportContent', 'get', 'billing.data.export', 'B29a', '/v1/billing/exports/{export_id}/content'],
];

describe('operation -> permission / route (02-TRD §5)', () => {
  for (const [id, method, permission, b, path] of EXPECT) {
    it(`${b} ${id}: ${method.toUpperCase()} ${path} requires ${permission}`, () => {
      expect(ops[id], id).toBeDefined(); expect(ops[id].method).toBe(method); expect(ops[id].path).toBe(path); expect(ops[id]['x-permission']).toBe(permission);
    });
  }
  it('B28 needs an Idempotency-Key; the reads do not', () => {
    expect(ops['createBillingExport']['x-idempotency']).toBe('required');
    for (const id of ['getSalesRegister', 'getCancelledInvoiceRegister', 'getCreditNoteRegister', 'getAuditTrail', 'getBillingExport', 'getBillingExportContent']) expect(ops[id]['x-idempotency'], id).toBe('none');
  });
});

describe('privileged = finance only (07 exports row: privileged + aal2)', () => {
  it('billing.data.export is privileged and held by finance only (never front_desk / viewer roles); billing.invoice.read is not privileged', () => {
    const p = perm('billing.data.export'); expect(p).toBeDefined(); expect(p.privileged).toBe(true); expect(p.roles).toEqual(['finance']);
    expect(perm('billing.invoice.read').privileged).toBe(false);
  });
  it('B27, B28, B29, B29a all declare auth.forbidden / auth.unauthenticated so the pipeline refusal is part of the contract', () => {
    for (const id of ['createBillingExport', 'getBillingExportContent']) for (const c of ['auth.forbidden', 'auth.unauthenticated']) expect(ops[id]['x-error-codes'], `${id} ${c}`).toContain(c);
  });
});

describe('error contract', () => {
  it('B28 declares billing.export_too_large (HTTP 422) and common.feature_disabled; B29a declares common.version_conflict + common.not_found; B26 declares common.invalid_cursor', () => {
    expect(ops['createBillingExport']['x-error-codes']).toEqual(expect.arrayContaining(['billing.export_too_large', 'common.feature_disabled']));
    expect(ops['getBillingExportContent']['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.not_found']));
    expect(ops['getCreditNoteRegister']['x-error-codes']).toContain('common.invalid_cursor');
    const row = (errors.errors ?? errors).find((e: any) => e.code === 'billing.export_too_large'); expect(row?.http).toBe(422);
  });
  it('limits and TTL defaults (TRD §11.1): 100000 rows, PDF 5000 rows, 24 h', () => {
    const c = loadBillingConfig({} as never); expect([c.exportMaxRows, c.exportPdfMaxRows, c.exportTtlHours]).toEqual([100000, 5000, 24]);
  });
});

describe('P-2: content only by streaming B29a, never a URL', () => {
  it('B29a 200 sets attachment, nosniff, no-store', () => {
    const h = ops['getBillingExportContent'].responses['200'].headers;
    expect(h['X-Content-Type-Options'].schema.enum).toEqual(['nosniff']); expect(h['Content-Disposition']).toBeDefined(); expect(h['Cache-Control']).toBeDefined();
    expect(JSON.stringify(h['Cache-Control'])).toContain('no-store');
  });
  it('ExportJob has no url / path / bucket / sha / error property and no uri-format string anywhere in it', () => {
    const props = Object.keys(api.components.schemas.ExportJob.properties);
    expect(props.sort()).toEqual(['completed_at', 'created_at', 'expires_at', 'format', 'id', 'kind', 'row_count', 'status']);
    expect(JSON.stringify(api.components.schemas.ExportJob)).not.toMatch(/"format":"(uri|url)"/);
  });
  it('no B24-B29a operation response schema carries a storage URL property', () => {
    for (const [id] of EXPECT) expect(JSON.stringify(ops[id].responses), id).not.toMatch(/signed_?url|download_?url|"format":"uri"/i);
  });
});
