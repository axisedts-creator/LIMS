// PG-T12 — DB rows -> PaymentIntentSummary / PaymentIntentDetail / RefundDto (TRD §5.1 DTOs). Pure. The field list IS the security control (REQ-SEC-080/081):
// every output key is written by name, so a stored token hash, return / cancel / payment URL, idempotency key, fingerprint, merchant account id, redacted payload
// or query can never reach a response, whatever columns the row carries. snake_case, Money = { amount_paisa, currency }, absent = omitted (never null).
// node-pg shapes in: bigint = decimal string, timestamptz = Date.
type Row = Record<string, any>;
type Out = Record<string, unknown>;

const money = (paisa: unknown) => ({ amount_paisa: Number(paisa), currency: 'NPR' as const });
const iso = (d: unknown): string => new Date(d as Date).toISOString();
/** copies a present value (false and 0 count as present; null / undefined do not) */
function put(o: Out, key: string, v: unknown, f: (x: any) => unknown = (x) => x): void {
  if (v !== null && v !== undefined) o[key] = f(v);
}

export function toIntentSummary(r: Row): Out {
  const o: Out = { id: r['id'], order_id: r['order_id'], centre_id: r['centre_id'], gateway: r['gateway'], environment: r['environment'], status: r['status'], amount: money(r['amount_paisa']) };
  put(o, 'hold_reason', r['hold_reason']);
  put(o, 'failure_reason', r['failure_reason']);
  o['created_at'] = iso(r['created_at']);
  put(o, 'expires_at', r['expires_at'], iso);
  put(o, 'settled_at', r['settled_at'], iso);
  put(o, 'last_checked_at', r['last_checked_at'], iso);
  o['version'] = r['version'];
  return o;
}

const transition = (t: Row): Out => {
  const o: Out = {};
  put(o, 'from_status', t['from_status']);
  o['to_status'] = t['to_status']; o['cause'] = t['cause'];
  put(o, 'reason_code', t['reason_code']);
  o['actor_type'] = t['actor_type']; o['at'] = iso(t['created_at']);
  return o;
};
const check = (c: Row): Out => {
  const o: Out = { operation: c['operation'], outcome: c['outcome'] };
  put(o, 'gateway_status_raw', c['gateway_status_raw']);
  put(o, 'http_status', c['http_status']);
  o['at'] = iso(c['created_at']);
  return o;
};
const callback = (c: Row): Out => {
  const o: Out = { kind: c['kind'], outcome_code: c['outcome_code'] };
  put(o, 'signature_valid', c['signature_valid']);
  o['at'] = iso(c['created_at']);
  return o;
};

/** RefundDto subset the refunds table carries without the memberships directory; display names, approver and completion fields are PG-T14 (P6-P11). */
export function toRefundDto(r: Row): Out {
  const o: Out = { id: r['id'], intent_id: r['intent_id'], order_id: r['order_id'], gateway: r['gateway'], mode: r['mode'], status: r['status'], amount: money(r['amount_paisa']), reason_code: r['reason_code'] };
  put(o, 'reason_text', r['reason_text']);
  o['requested_by'] = { membership_id: r['requested_by_membership_id'] };
  o['requested_at'] = iso(r['requested_at']);
  o['version'] = r['version'];
  return o;
}

export function toIntentDetail(r: Row, parts: { transitions: Row[]; gatewayCalls: Row[]; callbacks: Row[]; refunds: Row[] }): Out {
  const o = toIntentSummary(r);
  put(o, 'gateway_txn_ref', r['gateway_txn_ref']);
  put(o, 'gateway_secondary_ref', r['gateway_secondary_ref']);
  put(o, 'last_gateway_status_raw', r['last_gateway_status_raw']);
  put(o, 'verified_amount', r['verified_amount_paisa'], money);
  put(o, 'verification_method', r['verification_method']);
  o['refunded_amount'] = money(r['refunded_paisa'] ?? 0);
  put(o, 'ledger_entry_id', r['ledger_entry_id']);
  o['created_by_actor_type'] = r['created_actor_type'];
  o['transitions'] = parts.transitions.map(transition);
  o['gateway_checks'] = parts.gatewayCalls.map(check);
  o['callbacks'] = parts.callbacks.map(callback);
  o['refunds'] = parts.refunds.map(toRefundDto);
  return o;
}
