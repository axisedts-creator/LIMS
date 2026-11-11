// C15 PG-T10 — typed publisher for payments.intent.settled.v1 (02-TRD §8.1; 03-IC §3.20 / §10.6; 01-PRD US-PG-06).
// done_when: "payload validates; idempotency key <gateway>:<ref>:settled". tests: "event contract test; duplicate settle -> one event".
// ACs: AC-PG-06.1 (event rolls back with the transaction), AC-PG-06.2 (duplicate settle -> one event, carries ledger_entry_id),
//      AC-PG-06.3 (no event unless the publisher is called: a held intent never reaches it — covered by PG-T08; here: no write on bad payload),
//      AC-PG-06.4 (gateway_txn_ref = eSewa transaction_uuid / Khalti pidx is the middle of the key).
// Security: REQ-SEC-046..048 context — payload carries ids/amount only; no secret, callback token, mobile or payment_url may ride along (schema additionalProperties:false, fail closed).
// Real core `createEvents({ producer: 'payments' })` + in-memory tx fake, so the real envelope + contracts/events schema validate every publish.
// Interface expected from the writer (../publish.ts). Names marked SEAM are not fixed by the spec:
//   export const SETTLED_EVENT = 'payments.intent.settled.v1'
//   export function settledIdempotencyKey(p: { gateway: string; gateway_txn_ref: string }): string      // `${gateway}:${gateway_txn_ref}:settled`
//   export function createPaymentsEvents(events: { publish(ctx, type, input): Promise<{ eventId: string; duplicate: boolean }> })   (SEAM)
//     -> { intentSettled(ctx, payload, { intentVersion }) }   payload = the 03-IC payload exactly (snake_case, ISO-UTC strings);
//        aggregate { type: 'payment_intent', id: payload.intent_id, seq: intentVersion }; returns the core publish result.
//        The publisher adds no keys to the payload and does not strip any: an out-of-schema key fails closed (common.internal).
// Synthetic data only.
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { ctxFor, makeEventDb, TENANT_A, TENANT_B, UUIDV7 } from '../../../../core/events/__tests__/helpers.js';
import { createPaymentsEvents, SETTLED_EVENT, settledIdempotencyKey } from '../publish.js';

const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
const INTENT = V7('0000000c0001');
const INTENT2 = V7('0000000c0002');
const ORDER = V7('000000050001');
const LEDGER = V7('0000000d0001');
const AT = '2026-11-12T03:20:41.300Z';
const TYPE = 'payments.intent.settled.v1';

function setup() {
  const db = makeEventDb();
  const pay = createPaymentsEvents(createEvents({ producer: 'payments' }) as never);
  const ctx = ctxFor(db) as never;
  const run = <T>(fn: () => Promise<T>, o?: { rollback?: boolean }) => db.transaction(fn, o);
  const stored = () => db.events.filter((e) => e.eventType === TYPE);
  return { db, pay, ctx, run, stored };
}

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  intent_id: INTENT, order_id: ORDER, gateway: 'esewa', gateway_txn_ref: INTENT,
  amount: { amount_paisa: 125050, currency: 'NPR' }, verified_at: AT, verification_method: 'esewa_status_check', ledger_entry_id: LEDGER, ...over,
});
const khalti = (over: Record<string, unknown> = {}) =>
  payload({ intent_id: INTENT2, gateway: 'khalti', gateway_txn_ref: 'HT6o6PEZRWFJ5ygavzHWd5', verification_method: 'khalti_lookup', ...over });

// ---------------------------------------------------------------------------------------------------------------
describe('event contract (02-TRD §8.1; contracts/events/payments.intent.settled.v1.schema.json)', () => {
  it('exports the event type name verbatim', () => { expect(SETTLED_EVENT).toBe('payments.intent.settled.v1'); });

  it('esewa + khalti payloads publish; stored envelope is payments/payment_intent, uuidv7 event id, payload verbatim', async () => {
    const s = setup();
    const p = payload(); const k = khalti();
    await s.run(async () => { await s.pay.intentSettled(s.ctx, p, { intentVersion: 3 }); await s.pay.intentSettled(s.ctx, k, { intentVersion: 2 }); });
    const [e, f] = s.stored();
    expect(e!.envelope).toMatchObject({ event_type: TYPE, producer: 'payments', tenant_id: TENANT_A, aggregate: { type: 'payment_intent', id: INTENT, seq: 3 }, payload: p });
    expect(f!.envelope).toMatchObject({ producer: 'payments', aggregate: { type: 'payment_intent', id: INTENT2, seq: 2 }, payload: k });
    expect(e!.eventId).toMatch(UUIDV7);
  });

  it('payload has exactly the 03-IC keys: invoice_id is never added (C15 does not know it); ledger_entry_id passes through', async () => {
    const s = setup();
    await s.run(() => s.pay.intentSettled(s.ctx, payload(), { intentVersion: 1 }));
    const got = s.stored()[0]!.envelope.payload;
    expect(Object.keys(got).sort()).toEqual(['amount', 'gateway', 'gateway_txn_ref', 'intent_id', 'ledger_entry_id', 'order_id', 'verification_method', 'verified_at']);
    expect(got).not.toHaveProperty('invoice_id');
  });

  it('does not mutate the caller payload', async () => {
    const s = setup(); const p = payload(); const before = JSON.stringify(p);
    await s.run(() => s.pay.intentSettled(s.ctx, p, { intentVersion: 1 }));
    expect(JSON.stringify(p)).toBe(before);
  });

  it.each([
    ['intent_id'], ['order_id'], ['gateway'], ['gateway_txn_ref'], ['amount'], ['verified_at'], ['verification_method'],
  ])('missing required %s -> fails closed (common.internal), nothing stored, no fan-out job', async (key) => {
    const s = setup(); const p = payload(); delete p[key];
    await expect(s.run(() => s.pay.intentSettled(s.ctx, p, { intentVersion: 1 }))).rejects.toMatchObject({ code: 'common.internal' });
    expect(s.stored()).toHaveLength(0); expect(s.db.jobs).toHaveLength(0);
  });

  it.each([
    ['unknown gateway', { gateway: 'paypal' }],
    ['verification_method of another gateway family', { verification_method: 'cash' }],
    ['non-uuidv7 intent_id', { intent_id: 'not-a-uuid' }],
    ['non-uuidv7 order_id', { order_id: '123' }],
    ['non-uuidv7 ledger_entry_id', { ledger_entry_id: 'x' }],
    ['verified_at without millis / zone', { verified_at: '2026-11-12 03:20:41' }],
    ['float paisa (money is integer paisa, REQ-SEC-048)', { amount: { amount_paisa: 125050.5, currency: 'NPR' } }],
    ['non-NPR currency', { amount: { amount_paisa: 100, currency: 'USD' } }],
    ['empty gateway_txn_ref', { gateway_txn_ref: '' }],
    ['gateway_txn_ref > 100 chars', { gateway_txn_ref: 'x'.repeat(101) }],
  ])('invalid payload (%s) -> fails closed, nothing stored', async (_n, over) => {
    const s = setup();
    await expect(s.run(() => s.pay.intentSettled(s.ctx, payload(over), { intentVersion: 1 }))).rejects.toMatchObject({ code: 'common.internal' });
    expect(s.stored()).toHaveLength(0); expect(s.db.jobs).toHaveLength(0);
  });

  it.each(['mobile', 'payment_url', 'callback_token', 'secret_key', 'signature', 'invoice_id_extra', 'customer_name'])(
    'out-of-schema key %s is rejected, never silently carried or stripped (no secret/PII in events)', async (key) => {
      const s = setup();
      await expect(s.run(() => s.pay.intentSettled(s.ctx, payload({ [key]: 'SENTINEL-98123' }), { intentVersion: 1 }))).rejects.toMatchObject({ code: 'common.internal' });
      expect(s.stored()).toHaveLength(0);
      expect(JSON.stringify(s.db.stmts)).not.toContain('SENTINEL-98123');
    });
});

// ---------------------------------------------------------------------------------------------------------------
describe('idempotency key <gateway>:<gateway_txn_ref>:settled (03-IC §3.20; AC-PG-06.4)', () => {
  it('settledIdempotencyKey is the plain concatenation', () => {
    expect(settledIdempotencyKey({ gateway: 'esewa', gateway_txn_ref: INTENT })).toBe(`esewa:${INTENT}:settled`);
    expect(settledIdempotencyKey({ gateway: 'khalti', gateway_txn_ref: 'HT6o6PEZRWFJ5ygavzHWd5' })).toBe('khalti:HT6o6PEZRWFJ5ygavzHWd5:settled');
  });
  it('stored row key is the same string; gateway_txn_ref is eSewa transaction_uuid (= intent id) / Khalti pidx', async () => {
    const s = setup();
    await s.run(async () => { await s.pay.intentSettled(s.ctx, payload(), { intentVersion: 1 }); await s.pay.intentSettled(s.ctx, khalti(), { intentVersion: 1 }); });
    expect(s.stored().map((e) => e.key)).toEqual([`esewa:${INTENT}:settled`, 'khalti:HT6o6PEZRWFJ5ygavzHWd5:settled']);
    expect(s.stored().map((e) => e.envelope.idempotency_key)).toEqual(s.stored().map((e) => e.key));
  });
  it('same ref on two gateways are two events; same key in two tenants are two events', async () => {
    const s = setup();
    await s.run(async () => {
      await s.pay.intentSettled(s.ctx, payload({ gateway_txn_ref: 'SAME' }), { intentVersion: 1 });
      await s.pay.intentSettled(s.ctx, khalti({ gateway_txn_ref: 'SAME' }), { intentVersion: 1 });
      await s.pay.intentSettled(ctxFor(s.db, { tenantId: TENANT_B }) as never, payload({ gateway_txn_ref: 'SAME' }), { intentVersion: 1 });
    });
    expect(s.stored()).toHaveLength(3);
  });
  it('a 100-char ref still fits the 200-char envelope key limit', async () => {
    const s = setup();
    await s.run(() => s.pay.intentSettled(s.ctx, khalti({ gateway_txn_ref: 'r'.repeat(100) }), { intentVersion: 1 }));
    expect(s.stored()[0]!.key).toBe(`khalti:${'r'.repeat(100)}:settled`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('duplicate settle -> one event (AC-PG-06.2)', () => {
  it('second publish of the same settlement returns duplicate:true with the first eventId; one row, one fan-out job', async () => {
    const s = setup();
    const a = await s.run(() => s.pay.intentSettled(s.ctx, payload(), { intentVersion: 3 }));
    const b = await s.run(() => s.pay.intentSettled(s.ctx, payload(), { intentVersion: 3 }));
    expect(a.duplicate).toBe(false); expect(b.duplicate).toBe(true); expect(b.eventId).toBe(a.eventId);
    expect(s.stored()).toHaveLength(1); expect(s.db.jobs).toHaveLength(1);
  });
  it('replay with a different version / verified_at / ledger id (recordGatewayPayment duplicate:true) still yields one event, first payload kept', async () => {
    const s = setup();
    await s.run(() => s.pay.intentSettled(s.ctx, payload(), { intentVersion: 3 }));
    const again = await s.run(() => s.pay.intentSettled(s.ctx, payload({ verified_at: '2026-11-12T04:00:00.000Z', ledger_entry_id: V7('0000000d0002') }), { intentVersion: 4 }));
    expect(again.duplicate).toBe(true);
    expect(s.stored()).toHaveLength(1);
    expect(s.stored()[0]!.envelope.payload.ledger_entry_id).toBe(LEDGER);
  });
  it('ten concurrent settles of one reference -> exactly one stored event', async () => {
    const s = setup();
    const rs = await s.run(() => Promise.all(Array.from({ length: 10 }, () => s.pay.intentSettled(s.ctx, payload(), { intentVersion: 3 }))));
    expect(rs.filter((r) => !r.duplicate)).toHaveLength(1); expect(s.stored()).toHaveLength(1);
  });
  it('event carries ledger_entry_id returned by the ledger call', async () => {
    const s = setup();
    await s.run(() => s.pay.intentSettled(s.ctx, payload({ ledger_entry_id: V7('0000000d0009') }), { intentVersion: 1 }));
    expect(s.stored()[0]!.envelope.payload.ledger_entry_id).toBe(V7('0000000d0009'));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('same-transaction semantics (AC-PG-06.1; AC-PG-06.3)', () => {
  it('rollback of the surrounding transaction leaves no event and no fan-out job', async () => {
    const s = setup();
    await expect(s.run(() => s.pay.intentSettled(s.ctx, payload(), { intentVersion: 1 }), { rollback: true })).rejects.toThrow('forced rollback');
    expect(s.stored()).toHaveLength(0); expect(s.db.jobs).toHaveLength(0);
  });
  it('after a rolled-back attempt the same settlement can publish fresh (not treated as duplicate)', async () => {
    const s = setup();
    await s.run(() => s.pay.intentSettled(s.ctx, payload(), { intentVersion: 1 }), { rollback: true }).catch(() => undefined);
    const r = await s.run(() => s.pay.intentSettled(s.ctx, payload(), { intentVersion: 1 }));
    expect(r.duplicate).toBe(false); expect(s.stored()).toHaveLength(1);
  });
  it('a failing event insert surfaces as an error (caller rolls back); it is never swallowed', async () => {
    const s = setup();
    s.db.fail(/INSERT\s+INTO\s+core\.event_log/i, () => Object.assign(new Error('insert failed'), { code: 'XX000' }));
    await expect(s.run(() => s.pay.intentSettled(s.ctx, payload(), { intentVersion: 1 }))).rejects.toThrow();
    expect(s.stored()).toHaveLength(0);
  });
  it('publishes through the supplied events port only (no direct tx writes), with idempotencyKey and aggregate set', async () => {
    const calls: any[] = [];
    const pay = createPaymentsEvents({ async publish(_c: unknown, type: string, input: any) { calls.push({ type, input }); return { eventId: 'e', duplicate: false }; } } as never);
    await pay.intentSettled({} as never, payload(), { intentVersion: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe(TYPE);
    expect(calls[0].input).toMatchObject({ idempotencyKey: `esewa:${INTENT}:settled`, aggregate: { type: 'payment_intent', id: INTENT, seq: 5 }, payload: payload() });
  });
});
