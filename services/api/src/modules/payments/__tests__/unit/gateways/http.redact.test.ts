// PG-T04 — redactResponse (TRD §7.6; REQ-SEC-056/098; ST-11; 05-SCHEMA gateway_calls__size__ck).
// Assumed seam (tester; writer may dispute via notes): gateways/http.ts exports
//   redactResponse(gateway, operation, body: unknown) -> Record<string, string|number|boolean|null> | null
// Allowlists: esewa_status {status,totalAmount (always a string),refId,scd,code,error_message};
//   khalti_lookup {status,total_amount,transaction_id,refunded,fee}; khalti_initiate {pidx,expires_at,expires_in,error_key}.
// Any other key is dropped; non-scalar values are dropped; non-object bodies and operations without an allowlist -> null.
// Result is idempotent and JSON-serialises to <= 2048 octets (schema CHECK).
import { describe, expect, it } from 'vitest';
import { redactResponse } from '../../../gateways/http.js';

const PHONE = '9800000000'; // synthetic
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

describe('redactResponse — allowlists', () => {
  it('khalti_lookup keeps only status,total_amount,transaction_id,refunded,fee', () => {
    const out = redactResponse('khalti', 'khalti_lookup', {
      pidx: 'p1', total_amount: 225000, status: 'Completed', transaction_id: 'T1', fee: 0, refunded: false,
      mobile: PHONE, payer_name: 'Synthetic Person', payment_url: 'https://pay.example/?pidx=p1', Authorization: 'Key SECRET',
    });
    expect(out).toEqual({ status: 'Completed', total_amount: 225000, transaction_id: 'T1', refunded: false, fee: 0 });
  });

  it('khalti_initiate keeps pidx,expires_at,expires_in,error_key and drops payment_url', () => {
    const out = redactResponse('khalti', 'khalti_initiate', {
      pidx: 'p1', payment_url: 'https://pay.example/?pidx=p1', expires_at: '2030-01-01T00:00:00+05:45', expires_in: 1800, error_key: 'validation_error', detail: 'free text',
    });
    expect(out).toEqual({ pidx: 'p1', expires_at: '2030-01-01T00:00:00+05:45', expires_in: 1800, error_key: 'validation_error' });
    expect(JSON.stringify(out)).not.toContain('payment_url');
  });

  it('esewa_status keeps status,totalAmount,refId,scd,code,error_message and drops pid/transaction_uuid/product_code', () => {
    const out = redactResponse('esewa', 'esewa_status', {
      status: 'COMPLETE', totalAmount: '2250.0', refId: '0001SIM', scd: 'EPAYTEST', pid: 'intent-1', transaction_uuid: 'u', product_code: 'EPAYTEST', code: 0, error_message: 'x',
    });
    expect(out).toEqual({ status: 'COMPLETE', totalAmount: '2250.0', refId: '0001SIM', scd: 'EPAYTEST', code: 0, error_message: 'x' });
  });

  it('esewa totalAmount is stored as a string even when the body parsed it as a number', () => {
    expect(redactResponse('esewa', 'esewa_status', { status: 'COMPLETE', totalAmount: 2250 })).toEqual({ status: 'COMPLETE', totalAmount: '2250' });
  });

  it('unknown keys are dropped for every gateway/operation (redaction of unknown keys)', () => {
    for (const [g, op] of [['khalti', 'khalti_lookup'], ['khalti', 'khalti_initiate'], ['esewa', 'esewa_status']] as const) {
      const out = redactResponse(g, op, { status: 'X', zzz_unknown: 'leak', mobile: PHONE, token: 'tok', signature: 'sig' });
      expect(Object.keys(out ?? {})).not.toEqual(expect.arrayContaining(['zzz_unknown']));
      expect(JSON.stringify(out)).not.toMatch(/leak|tok|sig|9800000000/);
    }
  });

  it('Khalti mobile never survives, at any depth or casing (REQ-SEC-056, ST-11)', () => {
    const body = { status: 'Completed', total_amount: 1, mobile: PHONE, Mobile: PHONE, payer: { mobile: PHONE }, transaction_id: { mobile: PHONE } };
    for (const op of ['khalti_lookup', 'khalti_initiate'] as const) {
      expect(JSON.stringify(redactResponse('khalti', op, body))).not.toContain(PHONE);
    }
  });

  it('non-scalar values under allowlisted keys are dropped', () => {
    const out = redactResponse('khalti', 'khalti_lookup', { status: { a: 1 }, total_amount: [1], transaction_id: 'T1' });
    expect(out).toEqual({ transaction_id: 'T1' });
  });

  it.each([null, undefined, 'text', 42, ['status'], true])('non-object body %j -> null', (b) => {
    expect(redactResponse('khalti', 'khalti_lookup', b)).toBeNull();
  });

  it('operation without an allowlist (khalti_refund, credential_test) stores nothing', () => {
    expect(redactResponse('khalti', 'khalti_refund' as never, { detail: 'Transaction refund successful.', mobile: PHONE })).toBeNull();
    expect(redactResponse('khalti', 'credential_test' as never, { status: 'x' })).toBeNull();
  });

  it('prototype-pollution style keys are ignored', () => {
    const body = JSON.parse('{"__proto__":{"status":"HACK"},"constructor":{"x":1},"status":"Completed"}');
    const out = redactResponse('khalti', 'khalti_lookup', body);
    expect(out).toEqual({ status: 'Completed' });
    expect(({} as Record<string, unknown>)['status']).toBeUndefined();
  });

  it('is idempotent', () => {
    const once = redactResponse('esewa', 'esewa_status', { status: 'COMPLETE', totalAmount: 2250, extra: 1 });
    expect(redactResponse('esewa', 'esewa_status', once)).toEqual(once);
  });
});

describe('redactResponse — size cap (gateway_calls__size__ck <= 2048 octets)', () => {
  it('huge allowlisted string values are truncated so the stored JSON fits', () => {
    const out = redactResponse('esewa', 'esewa_status', { status: 'S'.repeat(10_000), error_message: 'é'.repeat(10_000), refId: 'R'.repeat(5000) });
    expect(out).not.toBeNull();
    expect(bytes(out)).toBeLessThanOrEqual(2048);
  });

  it('multi-byte truncation never yields a broken string', () => {
    const out = redactResponse('esewa', 'esewa_status', { error_message: '😀'.repeat(5000) });
    expect(bytes(out)).toBeLessThanOrEqual(2048);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});
