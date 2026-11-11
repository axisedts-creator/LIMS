// PG-T12 (C15) — mappers/intent.mapper.ts: DB rows -> PaymentIntentSummary / PaymentIntentDetail (TRD §5.1 DTOs). Pure functions: the allowlist is the security control
// (REQ-SEC-080/081): fields exactly as the TRD, snake_case, Money = { amount_paisa, currency }, absent = omitted (never null), bigint strings -> numbers, Dates -> ISO strings.
// Fails now: mappers/intent.mapper.ts does not exist.
import { describe, expect, it } from 'vitest';
import { DETAIL_EXTRA, SENTINELS, SUMMARY } from '../../helpers/staffDto';

const mapper: any = await import('../../../mappers/intent.mapper.js').catch((e) => { throw new Error(`PG-T12 not implemented: mappers/intent.mapper.ts (${e?.message ?? e})`); });
const D = (s: string) => new Date(s);

const row = (over: Record<string, unknown> = {}) => ({
  id: '01900000-0000-7000-8000-0000000d0001', tenant_id: '01930000-0000-7000-8000-00000000000a', order_id: '01900000-0000-7000-8000-0000000d5001', branch_id: '01900000-0000-7000-8000-0000000b0001',
  centre_id: '01900000-0000-7000-8000-0000000ce001', gateway: 'khalti', environment: 'uat', merchant_account_id: 'MERCHANT-SENTINEL', status: 'held_for_review', amount_paisa: '225000', currency: 'NPR',
  idempotency_key: 'IDEM-SENTINEL', request_fingerprint: 'FINGERPRINT-SENTINEL', return_url: 'https://x.test/RETURN-URL-SENTINEL', cancel_url: 'https://x.test/CANCEL-URL-SENTINEL',
  callback_token_sha256: Buffer.from('TOKEN-HASH-SENTINEL'), gateway_txn_ref: 'PIDX-1', gateway_secondary_ref: 'TXN-REF-1', gateway_payment_url: 'https://pay.test/PAYMENT-URL-SENTINEL',
  expires_at: D('2026-11-11T07:00:00Z'), initiated_at: D('2026-11-11T06:00:00Z'), pending_at: null, settled_at: null, closed_at: null, last_checked_at: D('2026-11-11T06:05:00Z'), check_count: 3,
  consecutive_unknown: 0, last_gateway_status_raw: 'Pending', verified_amount_paisa: null, verification_method: null, hold_reason: 'gateway_pending', failure_reason: null,
  resolution_reason_code: null, resolution_note: null, resolved_by: null, resolved_at: null, ledger_entry_id: null, refunded_paisa: '0', created_actor_type: 'user', version: 4,
  created_at: D('2026-11-11T06:00:00Z'), created_by: 'x', updated_at: D('2026-11-11T06:05:00Z'), updated_by: 'x', ...over,
});

describe('toIntentSummary', () => {
  it('emits exactly the TRD fields that have a value — bigint paisa as a number inside Money, Dates as ISO-8601 UTC, nothing else', () => {
    const s = mapper.toIntentSummary(row());
    expect(s).toEqual({ id: '01900000-0000-7000-8000-0000000d0001', order_id: '01900000-0000-7000-8000-0000000d5001', centre_id: '01900000-0000-7000-8000-0000000ce001', gateway: 'khalti',
      environment: 'uat', status: 'held_for_review', amount: { amount_paisa: 225000, currency: 'NPR' }, hold_reason: 'gateway_pending', created_at: '2026-11-11T06:00:00.000Z',
      expires_at: '2026-11-11T07:00:00.000Z', last_checked_at: '2026-11-11T06:05:00.000Z', version: 4 });
  });

  it('absent / null columns are omitted, never null (02-CV §4: no null in JSON)', () => {
    const s = mapper.toIntentSummary(row({ hold_reason: null, expires_at: null, last_checked_at: null }));
    expect(Object.keys(s)).not.toContain('hold_reason'); expect(Object.keys(s)).not.toContain('expires_at'); expect(Object.keys(s)).not.toContain('last_checked_at');
    expect(JSON.stringify(s)).not.toContain('null');
  });

  it('a settled / failed row adds settled_at / failure_reason', () => {
    expect(mapper.toIntentSummary(row({ status: 'settled', hold_reason: null, settled_at: D('2026-11-11T06:10:00Z') })).settled_at).toBe('2026-11-11T06:10:00.000Z');
    expect(mapper.toIntentSummary(row({ status: 'failed', hold_reason: null, failure_reason: 'abandoned' })).failure_reason).toBe('abandoned');
  });

  it('ALLOWLIST: keys ⊆ the Summary fields; none of the stored secrets / URLs / token hash / idempotency / fingerprint / merchant account id leak, even when a row carries extra columns', () => {
    const s = mapper.toIntentSummary(row({ evil_column: 'SECRET-SENTINEL', response_redacted: 'RAW-PAYLOAD-SENTINEL' }));
    for (const k of Object.keys(s)) expect(SUMMARY, k).toContain(k);
    const text = JSON.stringify(s);
    for (const x of SENTINELS) expect(text).not.toContain(x);
  });

  it('does not mutate its input and returns a fresh object each call', () => {
    const r = row(); const before = JSON.stringify(r);
    const a = mapper.toIntentSummary(r), b = mapper.toIntentSummary(r);
    expect(JSON.stringify(r)).toBe(before); expect(a).not.toBe(b);
  });

  it('a bigint amount above 2^31 stays exact (node-pg returns bigint as text)', () => {
    expect(mapper.toIntentSummary(row({ amount_paisa: '9007199254740991' })).amount.amount_paisa).toBe(9007199254740991);
  });
});

describe('toIntentDetail', () => {
  const parts = {
    transitions: [{ id: 't1', tenant_id: 'x', intent_id: 'i', from_status: null, to_status: 'created', cause: 'create', reason_code: null, actor_type: 'user', created_at: D('2026-11-11T06:00:00Z'), created_by: 'x' },
      { id: 't2', from_status: 'created', to_status: 'held_for_review', cause: 'verify_call', reason_code: 'gateway_pending', actor_type: 'system', created_at: D('2026-11-11T06:05:00Z') }],
    gatewayCalls: [{ id: 'g1', operation: 'khalti_lookup', outcome: 'answer', gateway_status_raw: 'Pending', http_status: 200, response_redacted: 'RAW-PAYLOAD-SENTINEL', merchant_account_id: 'MERCHANT-SENTINEL', created_at: D('2026-11-11T06:05:00Z') },
      { id: 'g2', operation: 'khalti_lookup', outcome: 'timeout', gateway_status_raw: null, http_status: null, response_redacted: null, created_at: D('2026-11-11T06:04:00Z') }],
    callbacks: [{ id: 'c1', kind: 'khalti_return', outcome_code: 'ok', signature_valid: null, query_redacted: { pidx: 'RAW-PAYLOAD-SENTINEL' }, created_at: D('2026-11-11T06:03:00Z'), received_at: D('2026-11-11T06:03:00Z') },
      { id: 'c2', kind: 'esewa_success', outcome_code: 'payments.signature_invalid', signature_valid: false, query_redacted: null, created_at: D('2026-11-11T06:02:00Z') }],
    refunds: [],
  };
  const d = () => mapper.toIntentDetail(row({ status: 'settled', hold_reason: null, settled_at: D('2026-11-11T06:10:00Z'), verified_amount_paisa: '225000', verification_method: 'khalti_lookup',
    ledger_entry_id: '01900000-0000-7000-8000-0000000c8000', refunded_paisa: '5000' }), parts);

  it('Detail = Summary fields + the TRD detail fields, with Money for verified_amount / refunded_amount and created_by_actor_type from created_actor_type', () => {
    const x = d();
    expect(x).toMatchObject({ id: '01900000-0000-7000-8000-0000000d0001', status: 'settled', amount: { amount_paisa: 225000, currency: 'NPR' }, gateway_txn_ref: 'PIDX-1', gateway_secondary_ref: 'TXN-REF-1',
      last_gateway_status_raw: 'Pending', verified_amount: { amount_paisa: 225000, currency: 'NPR' }, verification_method: 'khalti_lookup', refunded_amount: { amount_paisa: 5000, currency: 'NPR' },
      ledger_entry_id: '01900000-0000-7000-8000-0000000c8000', created_by_actor_type: 'user', refunds: [], version: 4 });
  });

  it('nested lists carry only their TRD fields: transitions {from_status?, to_status, cause, reason_code?, actor_type, at}; gateway_checks {operation, outcome, gateway_status_raw?, http_status?, at}; callbacks {kind, outcome_code, signature_valid?, at}', () => {
    const x = d();
    expect(x.transitions).toEqual([{ to_status: 'created', cause: 'create', actor_type: 'user', at: '2026-11-11T06:00:00.000Z' },
      { from_status: 'created', to_status: 'held_for_review', cause: 'verify_call', reason_code: 'gateway_pending', actor_type: 'system', at: '2026-11-11T06:05:00.000Z' }]);
    expect(x.gateway_checks).toEqual([{ operation: 'khalti_lookup', outcome: 'answer', gateway_status_raw: 'Pending', http_status: 200, at: '2026-11-11T06:05:00.000Z' },
      { operation: 'khalti_lookup', outcome: 'timeout', at: '2026-11-11T06:04:00.000Z' }]);
    expect(x.callbacks).toEqual([{ kind: 'khalti_return', outcome_code: 'ok', at: '2026-11-11T06:03:00.000Z' }, { kind: 'esewa_success', outcome_code: 'payments.signature_invalid', signature_valid: false, at: '2026-11-11T06:02:00.000Z' }]);
  });

  it('ALLOWLIST: keys ⊆ Summary + Detail fields; no token hash, return / cancel / payment URL, idempotency key, fingerprint, merchant account id, redacted payload or query leaks', () => {
    const x = d();
    for (const k of Object.keys(x)) expect([...SUMMARY, ...DETAIL_EXTRA], k).toContain(k);
    const text = JSON.stringify(x);
    for (const s of SENTINELS) expect(text).not.toContain(s);
    expect(text).not.toMatch(/"(id|tenant_id|created_by|updated_by)":"(t1|g1|c1|x)"/);        // nested row ids / actor ids are not exposed
    expect(text).not.toContain('null');
  });

  it('a row without refs / verification / settlement omits those fields; refunded_amount is always present (0)', () => {
    const x = mapper.toIntentDetail(row({ gateway_secondary_ref: null, last_gateway_status_raw: null, verified_amount_paisa: null, verification_method: null, ledger_entry_id: null }), { transitions: [], gatewayCalls: [], callbacks: [], refunds: [] });
    for (const k of ['gateway_secondary_ref', 'last_gateway_status_raw', 'verified_amount', 'verification_method', 'ledger_entry_id']) expect(Object.keys(x)).not.toContain(k);
    expect(x.refunded_amount).toEqual({ amount_paisa: 0, currency: 'NPR' });
    expect(x.transitions).toEqual([]); expect(x.gateway_checks).toEqual([]); expect(x.callbacks).toEqual([]); expect(x.refunds).toEqual([]);
  });
});
