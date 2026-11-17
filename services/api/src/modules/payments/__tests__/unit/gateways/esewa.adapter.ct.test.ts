// PG-T06 — constant-time callback signature comparison (TRD §7.2.2 "timingSafeEqual on decoded bytes, length check first"; REQ-SEC-049; ST-04).
// Spies crypto.timingSafeEqual through a module mock (both specifiers, so `crypto` and `node:crypto` imports are covered).
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tse = vi.hoisted(() => ({ calls: [] as { a: number; b: number }[] }));
vi.mock('node:crypto', async (orig) => {
  const m = await orig<typeof import('node:crypto')>();
  return { ...m, timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => { tse.calls.push({ a: a.byteLength, b: b.byteLength }); return m.timingSafeEqual(a, b); } };
});
vi.mock('crypto', async (orig) => {
  const m = await orig<typeof import('crypto')>();
  return { ...m, timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => { tse.calls.push({ a: a.byteLength, b: b.byteLength }); return m.timingSafeEqual(a, b); } };
});

import { createEsewaAdapter } from '../../../gateways/esewa.adapter.js';
import { SecretHandle } from '../../../service/credentials.js';

const SECRET = 'synthetic-esewa-secret-for-tests';
const ID = '0192f0a0-7b1e-7c3a-9d2e-4f5a6b7c8d9e';
const intent = { id: ID, gatewayTxnRef: ID, amountPaisa: 225000, productCode: 'SYNTHCODE', callbackToken: 'tok_SYNTHETIC_0123456789' };
const NAMES = 'transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names';
const adapter = createEsewaAdapter({
  formUrl: 'https://uat-form.example.test/form', statusUrl: 'http://127.0.0.1:9/s/', publicBase: 'https://lims.example.test',
  timeouts: { initiateMs: 100, inrequestMs: 100, jobMs: 100 },
});
function payload(sig?: string): string {
  const f: Record<string, string> = { transaction_code: '0001SIM', status: 'COMPLETE', total_amount: '2250', transaction_uuid: ID, product_code: 'SYNTHCODE', signed_field_names: NAMES };
  const real = createHmac('sha256', SECRET).update(NAMES.split(',').map((n) => `${n}=${f[n]}`).join(',')).digest('base64');
  return Buffer.from(JSON.stringify({ ...f, signature: sig ?? real }), 'utf8').toString('base64');
}
const run = async (p: string) => adapter.verifyCallbackSignature!(p, new SecretHandle(SECRET), intent as never);

beforeEach(() => { tse.calls.length = 0; });

describe('verifyCallbackSignature uses timingSafeEqual', () => {
  it('a genuine signature is compared once on two equal-length 32-byte buffers', async () => {
    expect((await run(payload())).valid).toBe(true);
    expect(tse.calls.length).toBeGreaterThanOrEqual(1);
    expect(tse.calls.every((c) => c.a === c.b && c.a === 32)).toBe(true);
  });
  it('a forged same-length signature goes through timingSafeEqual and fails', async () => {
    const forged = createHmac('sha256', 'other').update('x').digest('base64');
    expect((await run(payload(forged))).valid).toBe(false);
    expect(tse.calls.length).toBeGreaterThanOrEqual(1);
  });
  it('a different-length signature is rejected by the length check BEFORE timingSafeEqual (which would throw on unequal lengths)', async () => {
    expect((await run(payload('AAAA'))).valid).toBe(false);
    expect(tse.calls.every((c) => c.a === c.b)).toBe(true);
  });
});
