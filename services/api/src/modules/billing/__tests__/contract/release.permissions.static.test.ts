// BL-T12 role / privilege contract (static): who may call B14 and B15. The core pipeline enforces permission + privileged (aal2, membership re-validation) from
// contracts/permissions.yaml and contracts/openapi/billing.yaml, so the pipeline check is only as good as these rows: they are pinned here.
// Spec: 02-TRD §5 B14/B15, 07-SECURITY REQ-SEC-062/067 ("release override" row of the privileged table: front_desk -> 403 auth.forbidden, finance at aal1 -> 403 auth.mfa_required),
// PRD §3 (tenant_admin holds billing.release.override). Passes today: the contract rows already exist; it guards the writer from editing them to make a test pass.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
const load = (p: string): any => parse(readFileSync(join(root, p), 'utf8'));
const perms = load('contracts/permissions.yaml');
const api = load('contracts/openapi/billing.yaml');
const ops: Record<string, any> = {};
for (const [path, item] of Object.entries<any>(api.paths)) for (const [method, op] of Object.entries<any>(item)) if (op?.operationId) ops[op.operationId] = { ...op, method, path };
const perm = (code: string) => (perms.permissions as any[]).find((p) => p.code === code);

describe('B14 createReleaseOverride / B15 getReleaseEligibility', () => {
  it('B14: POST /v1/billing/orders/{order_id}/release-overrides needs billing.release.override and an Idempotency-Key', () => {
    expect(ops['createReleaseOverride']).toMatchObject({ method: 'post', path: '/v1/billing/orders/{order_id}/release-overrides', 'x-permission': 'billing.release.override', 'x-idempotency': 'required' });
    expect(ops['createReleaseOverride']['x-error-codes']).toEqual(expect.arrayContaining(['auth.forbidden', 'common.not_found', 'common.validation_failed']));
  });
  it('B15: GET /v1/billing/orders/{order_id}/release-eligibility needs billing.invoice.read and is idempotent-free', () => {
    expect(ops['getReleaseEligibility']).toMatchObject({ method: 'get', path: '/v1/billing/orders/{order_id}/release-eligibility', 'x-permission': 'billing.invoice.read', 'x-idempotency': 'none' });
  });
  it('billing.release.override is privileged (aal2) and held by finance and tenant_admin only - never front_desk, phlebotomist, lab roles', () => {
    const p = perm('billing.release.override');
    expect(p.privileged).toBe(true);
    expect([...p.roles].sort()).toEqual(['finance', 'tenant_admin']);
  });
  it('B14 request body allows reason_code, reason_text (<= 500) and expires_at only; the result is {override_id, created_at}', () => {
    const req = api.components.schemas.ReleaseOverrideRequest, res = api.components.schemas.ReleaseOverrideCreated;
    expect(req.additionalProperties).toBe(false);
    expect(Object.keys(req.properties).sort()).toEqual(['expires_at', 'reason_code', 'reason_text']);
    expect(req.required).toEqual(['reason_code']);
    expect(req.properties.reason_text.maxLength).toBe(500);
    expect(Object.keys(res.properties).sort()).toEqual(['created_at', 'override_id']);
  });
});
