// PG-T12 (C15) — contract facts of the staff intent operations P1-P5, P24, P24b (TRD §5.1; one permission floor per operation, 08 A19 P-43; DTO allowlists REQ-SEC-080/081).
// Reads contracts/openapi/payments.yaml (owned by C0/C15 contract task; read-only here). The runtime behaviour is in staff.http.test.ts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PAYMENTS_PERMISSIONS } from '../../permissions.js';
import { DETAIL_EXTRA, SUMMARY } from '../helpers/staffDto';

const root = resolve(__dirname, '../../../../../../..');
const doc: any = parse(readFileSync(resolve(root, 'contracts/openapi/payments.yaml'), 'utf8'));
const ops = new Map<string, { path: string; method: string; op: any }>();
for (const [path, item] of Object.entries<any>(doc.paths)) for (const [method, op] of Object.entries<any>(item)) if (op?.operationId) ops.set(op.operationId, { path, method, op });

const FORBIDDEN = /token|url|secret|signature|payload|raw_|response|idempotency|fingerprint|merchant_account|sha256|ciphertext/i;

describe('P1-P5, P24, P24b declare their method, path, permission floor, tier and idempotency (TRD §5.1)', () => {
  it.each([
    ['listPaymentIntents', 'get', '/v1/payments/intents', 'payments.reconciliation.read', 'none'],
    ['getPaymentIntent', 'get', '/v1/payments/intents/{intent_id}', 'payments.reconciliation.read', 'none'],
    ['recheckPaymentIntent', 'post', '/v1/payments/intents/{intent_id}/recheck', 'payments.intent.resolve', 'optional'],
    ['resolvePaymentIntent', 'post', '/v1/payments/intents/{intent_id}/resolve', 'payments.intent.resolve', 'required'],
    ['cancelPaymentIntent', 'post', '/v1/payments/intents/{intent_id}/cancel', 'payments.intent.create', 'required'],
    ['listPaymentCodes', 'get', '/v1/payments/coded-sets/{set_name}', 'payments.reconciliation.read', 'none'],
    ['listPaymentCancelReasons', 'get', '/v1/payments/cancel-reasons', 'payments.intent.create', 'none'],
  ])('%s -> %s %s requires %s (idempotency %s, tier general)', (id, method, path, permission, idem) => {
    const o = ops.get(id); expect(o, `${id} missing from payments.yaml`).toBeDefined();
    expect(o!.method).toBe(method); expect(o!.path).toBe(path);
    expect(o!.op['x-permission']).toBe(permission);                       // exactly one permission, never "A or B" (08 A19 P-43)
    expect(typeof o!.op['x-permission']).toBe('string');
    expect(o!.op['x-permission']).not.toMatch(/\s|,|\bor\b|\|/);
    expect((PAYMENTS_PERMISSIONS as readonly string[]).includes(permission)).toBe(true);
    expect(o!.op['x-idempotency']).toBe(idem);
    expect(o!.op['x-rate-limit-tier']).toBe('general');
    expect(o!.op.security).toEqual([{ bearerJwt: [] }]);                  // staff only: never public
  });

  it('P24 (finance screens) and P24b (C4 cancel dialog) are separate operations on different floors (AC-PG-13.3)', () => {
    expect(ops.get('listPaymentCodes')!.op['x-permission']).not.toBe(ops.get('listPaymentCancelReasons')!.op['x-permission']);
  });

  it('the privileged operations P3 and P4 document 403 auth.forbidden and auth.mfa_required (aal2 step-up, AC-PG-07.5); P3 documents 429 + the gateway codes; P4 the 409s', () => {
    for (const id of ['recheckPaymentIntent', 'resolvePaymentIntent']) for (const c of ['auth.forbidden', 'auth.mfa_required', 'common.not_found']) expect(ops.get(id)!.op['x-error-codes'], `${id} ${c}`).toContain(c);
    expect(ops.get('recheckPaymentIntent')!.op['x-error-codes']).toEqual(expect.arrayContaining(['common.rate_limited', 'payments.gateway_not_available', 'payments.intent_invalid_transition']));
    expect(ops.get('resolvePaymentIntent')!.op['x-error-codes']).toEqual(expect.arrayContaining(['payments.intent_not_verifiable', 'payments.intent_invalid_transition', 'common.version_conflict',
      'common.precondition_required', 'common.idempotency_key_required']));
    expect(ops.get('cancelPaymentIntent')!.op['x-error-codes']).toContain('payments.intent_invalid_transition');
  });

  it('P4 requires If-Match and Idempotency-Key and takes exactly {resolution, reason_code, note?<=500}; P5 takes exactly {reason_code} (strict, no amount rides along)', () => {
    const p4 = ops.get('resolvePaymentIntent')!.op, body4 = p4.requestBody.content['application/json'].schema;
    expect(JSON.stringify(p4.parameters)).toMatch(/IfMatch/); expect(JSON.stringify(p4.parameters)).toMatch(/IdempotencyKey/);
    expect(body4.additionalProperties).toBe(false); expect(Object.keys(body4.properties).sort()).toEqual(['note', 'reason_code', 'resolution']); expect(body4.required.sort()).toEqual(['reason_code', 'resolution']);
    expect(body4.properties.resolution.enum).toEqual(['settle', 'fail', 'record_exceeding_due']); expect(body4.properties.note.maxLength).toBe(500);
    expect(body4.properties.reason_code['x-coded-set']).toBe('payments.resolution_reasons');
    const body5 = ops.get('cancelPaymentIntent')!.op.requestBody.content['application/json'].schema;
    expect(body5.additionalProperties).toBe(false); expect(Object.keys(body5.properties)).toEqual(['reason_code']); expect(body5.properties.reason_code['x-coded-set']).toBe('payments.cancel_reasons');
  });
});

describe('DTO allowlists (REQ-SEC-080/081): fields exactly as TRD §5.1, nothing else', () => {
  const S = doc.components.schemas;
  it('PaymentIntentSummary has exactly the TRD fields, additionalProperties false', () => {
    expect(S.PaymentIntentSummary.additionalProperties).toBe(false);
    expect(Object.keys(S.PaymentIntentSummary.properties).sort()).toEqual([...SUMMARY].sort());
  });
  it('PaymentIntentDetail = Summary + the TRD detail fields, additionalProperties false', () => {
    expect(S.PaymentIntentDetail.additionalProperties).toBe(false);
    expect(Object.keys(S.PaymentIntentDetail.properties).sort()).toEqual([...SUMMARY, ...DETAIL_EXTRA].sort());
  });
  it('no field of either DTO (or its nested objects) can carry a callback token, URL, signature, secret or raw payload', () => {
    const names = (n: any, out: string[] = []): string[] => {
      if (n && typeof n === 'object') for (const [k, v] of Object.entries<any>(n)) { if (k === 'properties') out.push(...Object.keys(v)); names(v, out); }
      return out;
    };
    for (const dto of ['PaymentIntentSummary', 'PaymentIntentDetail']) for (const f of names(S[dto])) {
      if (['gateway_txn_ref', 'gateway_secondary_ref', 'last_gateway_status_raw', 'gateway_status_raw', 'signature_valid'].includes(f)) continue;   // allowed TRD fields (gateway refs / statuses / a boolean, not payloads)
      expect(f, `${dto}.${f}`).not.toMatch(FORBIDDEN);
    }
  });
  it('the access-log-relevant nested DTOs are strict: transitions, gateway_checks, callbacks items carry only their TRD fields', () => {
    const p = S.PaymentIntentDetail.properties;
    expect(Object.keys(p.transitions.items.properties).sort()).toEqual(['at', 'cause', 'actor_type', 'from_status', 'reason_code', 'to_status'].sort());
    expect(Object.keys(p.gateway_checks.items.properties).sort()).toEqual(['at', 'gateway_status_raw', 'http_status', 'operation', 'outcome'].sort());
    expect(Object.keys(p.callbacks.items.properties).sort()).toEqual(['at', 'kind', 'outcome_code', 'signature_valid'].sort());
    for (const k of ['transitions', 'gateway_checks', 'callbacks']) { expect(p[k].items.additionalProperties).toBe(false); expect(p[k].maxItems).toBeLessThanOrEqual(k === 'transitions' ? 200 : 20); }
  });
});
