// PG-T17 (C15) — AC-PG-10.5: a user without payments.merchant_config.manage gets 403 auth.forbidden. The permission check is the core pipeline's x-permission
// gate, so what C15 must guarantee is the DECLARED floor on each operation (02-TRD §5 rows P20–P23, one permission per operation, 08 A19 P-43) and that the
// secret is write-only in the contract (07-SECURITY REQ-SEC-136). Reads contracts/openapi/payments.yaml (owned by C0/C15 contract task; read-only here).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PAYMENTS_PERMISSIONS } from '../../permissions.js';

const root = resolve(__dirname, '../../../../../../..');
const doc: any = parse(readFileSync(resolve(root, 'contracts/openapi/payments.yaml'), 'utf8'));
const ops = new Map<string, { path: string; method: string; op: any }>();
for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, op] of Object.entries<any>(item)) if (op?.operationId) ops.set(op.operationId, { path, method, op });

describe('merchant-config operations declare their permission (AC-PG-10.5)', () => {
  it.each([
    ['listMerchantAccounts', 'get', '/v1/payments/merchant-accounts', 'payments.merchant_config.read'],
    ['putMerchantAccount', 'put', '/v1/payments/merchant-accounts/{gateway}/{environment}', 'payments.merchant_config.manage'],
    ['testMerchantAccount', 'post', '/v1/payments/merchant-accounts/{gateway}/{environment}/test', 'payments.merchant_config.manage'],
    ['getPaymentSettings', 'get', '/v1/payments/settings', 'payments.merchant_config.read'],
    ['updatePaymentSettings', 'put', '/v1/payments/settings', 'payments.merchant_config.manage'],
  ])('%s -> %s %s requires %s', (id, method, path, permission) => {
    const o = ops.get(id); expect(o, `${id} missing from payments.yaml`).toBeDefined();
    expect(o!.method).toBe(method); expect(o!.path).toBe(path); expect(o!.op['x-permission']).toBe(permission);
    expect((PAYMENTS_PERMISSIONS as readonly string[]).includes(permission)).toBe(true);
  });

  it('the write operations document 403 auth.forbidden and are privileged (not reachable at a weaker tier)', () => {
    for (const id of ['putMerchantAccount', 'testMerchantAccount', 'updatePaymentSettings']) {
      const text = JSON.stringify(ops.get(id)!.op);
      expect(text, id).toContain('auth.forbidden');
    }
  });

  it('putMerchantAccount: the secret is write-only — MerchantAccountDto (the response) has no secret value, only is_set / set_at / fingerprint', () => {
    const dto = doc.components.schemas.MerchantAccountDto;
    expect(Object.keys(dto.properties.secret.properties).sort()).toEqual(['fingerprint', 'is_set', 'set_at']);
    expect(dto.additionalProperties).toBe(false);
    for (const k of Object.keys(dto.properties)) expect(k).not.toMatch(/ciphertext|nonce|auth_tag|kek/);
  });

  it('testMerchantAccount: a rejected key is not an error response (payments.credential_invalid is not documented on P22)', () => {
    const op = ops.get('testMerchantAccount')!.op;
    expect(op['x-error-codes']).not.toContain('payments.credential_invalid');
    expect(op.responses['200'].content['application/json'].schema.properties.outcome.enum).toContain('auth_failed');
  });
});
