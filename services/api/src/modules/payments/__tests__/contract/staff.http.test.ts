// PG-T12 HTTP contract: staff intent operations P1-P5, P24, P24b (TRD §5.1, §5.4, §6.4, §6.5) through the handlers, over the PG-T08 port harness + in-memory DB fake.
// ACs: AC-PG-07.1-07.7 (07.8 = sweep gauge, PG-T11), AC-PG-13.3 (+ the 13.1 lookup-first cancel through P5), AC-PG-14.1 (tenant-B ids -> 404). Security: ST-15 (cross-tenant probes),
// ST-18 (centre-scoped user -> 404), REQ-SEC-040/044 (id probes), REQ-SEC-080/081 (DTO allowlists), 08 A13 P-3 / A19 D-112 (access-log calls), 08 A19 P-43 (one floor per operation).
// Wiring seam: helpers/staffHarness.ts header. Fails now: handlers/intents.ts and mappers/intent.mapper.ts do not exist (PG-T01 placeholders answer 503 only).
// NOT provable here (needs the C0 payments DDL / a running API): the core pipeline's x-permission / aal gate and strict query 400 (the IdentityPort double stands in with the real error codes),
// RLS against FORCE RLS, true DB parallelism, Idempotency-Key replay (core pipeline), the real ctx.core.memberships display names for refunds (PG-T14).
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { CODE_ITEM, DETAIL_EXTRA, SENTINELS, SUMMARY, hasNull } from '../helpers/staffDto';
import { CENTRE_1, CENTRE_2, hdr, makeStaffHarness, uid, type StaffHarness } from '../helpers/staffHarness';

const A = TENANTS.A, B = TENANTS.B;
let t: StaffHarness;
beforeEach(async () => { t = await makeStaffHarness(); t.seedCodes(); });

const sec = (s: number) => new Date(Date.parse(FIXED_NOW) + s * 1000).toISOString();
const ID = (n: number) => uid(n);
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const resolve = (id: string, body: unknown, o: { v?: number; as?: any; tenant?: 'A' | 'B'; headers?: Record<string, string> } = {}) =>
  t.call('resolvePaymentIntent', { params: { intent_id: id }, body, headers: o.headers ?? ifm(o.v ?? 1), ...(o.as ? { as: o.as } : {}), ...(o.tenant ? { tenant: o.tenant } : {}) });
const recheck = (id: string, o: { as?: any; now?: string; tenant?: 'A' | 'B' } = {}) => t.call('recheckPaymentIntent', { params: { intent_id: id }, ...o });
const cancel = (id: string, reason = 'patient_changed_method', o: { as?: any; tenant?: 'A' | 'B' } = {}) => t.call('cancelPaymentIntent', { params: { intent_id: id }, body: { reason_code: reason }, as: 'front_desk', ...o });
const get = (id: string, o: { as?: any; tenant?: 'A' | 'B' } = {}) => t.call('getPaymentIntent', { params: { intent_id: id }, ...o });
const list = (query: Record<string, unknown> = {}, o: { as?: any; tenant?: 'A' | 'B' } = {}) => t.call('listPaymentIntents', { query, ...o });
const ledger = () => t.h.ledger.calls;
const settledEvents = () => t.h.events.ofType('payments.intent.settled.v1');
const snap = (id: string) => JSON.stringify(t.row(id));

describe('P1 listPaymentIntents', () => {
  const seed = () => {
    t.add({ id: ID(1), status: 'held_for_review', gateway: 'esewa', createdAt: sec(-500), holdReason: 'amount_mismatch' });
    t.add({ id: ID(2), status: 'settled', gateway: 'khalti', createdAt: sec(-400) });
    t.add({ id: ID(3), status: 'failed', gateway: 'esewa', createdAt: sec(-300), centre: CENTRE_2 });
    t.add({ id: ID(4), status: 'pending', gateway: 'khalti', createdAt: sec(-200), centre: CENTRE_2 });
    t.add({ id: ID(5), status: 'held_for_review', gateway: 'khalti', createdAt: sec(-100), holdReason: 'exceeds_due' });
  };
  const ids = (r: any) => r.body.data.map((x: any) => x.id);

  it('200 {data, page}; newest first by default; every item is exactly a PaymentIntentSummary (allowlist) and nothing secret leaks', async () => {
    seed();
    const r = await list();
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([ID(5), ID(4), ID(3), ID(2), ID(1)]);
    expect(r.body.page).toMatchObject({ limit: 50 });
    for (const x of r.body.data) { for (const k of Object.keys(x)) expect(SUMMARY, k).toContain(k); expect(x.amount).toEqual({ amount_paisa: 225000, currency: 'NPR' }); }
    for (const s of SENTINELS) expect(JSON.stringify(r.body)).not.toContain(s);
    expect(hasNull(r.body)).toBe(false);
  });

  it.each([
    ['status csv', { status: 'held_for_review,failed' }, [5, 3, 1]],
    ['gateway', { gateway: 'khalti' }, [5, 4, 2]],
    ['gateway csv', { gateway: 'khalti,esewa' }, [5, 4, 3, 2, 1]],
    ['hold_reason csv', { hold_reason: 'exceeds_due,amount_mismatch' }, [5, 1]],
    ['centre_id', { centre_id: CENTRE_2 }, [4, 3]],
    ['sort=created_at', { sort: 'created_at' }, [1, 2, 3, 4, 5]],
    ['created_at window', { created_at_from: sec(-350), created_at_to: sec(-150) }, [4, 3]],
    ['combined', { status: 'held_for_review', gateway: 'khalti' }, [5]],
  ])('filter %s', async (_n, query, expected) => {
    seed();
    expect(ids(await list(query as any))).toEqual(expected.map(ID));
  });

  it('filter order_id returns just that order\'s intents', async () => {
    seed();
    const o = t.row(ID(2)).order_id;
    expect(ids(await list({ order_id: o }))).toEqual([ID(2)]);
  });

  it('cursor pagination: limit 2 over 5 rows walks all rows once, in order, the last page has no next_cursor, an empty result is 200 with no cursor', async () => {
    seed();
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await list({ limit: 2, ...(cursor ? { cursor } : {}) });
      expect(r.status).toBe(200); expect(r.body.page.limit).toBe(2); expect(r.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...ids(r)); cursor = r.body.page.next_cursor; pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual([ID(5), ID(4), ID(3), ID(2), ID(1)]); expect(pages).toBe(3);
    const none = await list({ status: 'expired' });
    expect(none.status).toBe(200); expect(none.body.data).toEqual([]); expect(none.body.page.next_cursor).toBeUndefined();
  });

  it.each([['garbage cursor', { cursor: '%%%not-a-cursor%%%' }], ['SQL meta cursor', { cursor: "' OR 1=1 --" }], ['limit 0', { limit: 0 }], ['limit 201', { limit: 201 }], ['limit -1', { limit: -1 }],
    ['bad status', { status: 'settled,exploded' }], ['bad gateway', { gateway: 'paypal' }], ['bad sort', { sort: '-updated_at' }], ['bad centre_id', { centre_id: 'x' }], ['bad window', { created_at_from: 'yesterday' }],
  ])('invalid input (%s) -> 400 common.validation_failed, no SQL built from it', async (_n, query) => {
    seed();
    const r = await list(query as any);
    expect(r.code).toBe('common.validation_failed');
    expect(t.h.db.stmts.map((s) => JSON.stringify(s.values)).join('')).not.toMatch(/OR 1=1|exploded|paypal/);
  });

  it('ST-15: tenant A never sees tenant B rows and vice versa (RLS + tenant predicate)', async () => {
    seed(); t.add({ id: ID(60), tenant: 'B', status: 'held_for_review' });
    expect(ids(await list())).not.toContain(ID(60));
    expect(ids(await list({}, { tenant: 'B' }))).toEqual([ID(60)]);
  });

  it('ST-18 centre filter: a centre-1 finance user sees only centre-1 intents; asking for centre 2 gets none of them; an all-centre user can still filter to one', async () => {
    seed();
    expect(ids(await list({}, { as: 'finance_centre1' }))).toEqual([ID(5), ID(2), ID(1)]);
    const other = await list({ centre_id: CENTRE_2 }, { as: 'finance_centre1' });
    expect(other.status).toBe(200); expect(other.body.data).toEqual([]);
    expect(ids(await list({ centre_id: CENTRE_1 }))).toEqual([ID(5), ID(2), ID(1)]);
  });

  it('permission: asserts payments.reconciliation.read BEFORE any payments read; front_desk -> 403 auth.forbidden with no read at all', async () => {
    seed();
    const before = t.h.db.stmts.length;
    const r = await list({}, { as: 'front_desk' });
    expect(r.code).toBe('auth.forbidden');
    expect(t.idCalls[0]).toMatchObject({ permission: 'payments.reconciliation.read', at: before });
    expect(t.readStmts(before)).toEqual([]);
  });

  it('a list never calls a gateway, never writes (no transition, no access_log row)', async () => {
    seed();
    await list();
    expect(t.checks()).toHaveLength(0); expect(t.h.db.transitions()).toHaveLength(0); expect(t.access()).toHaveLength(0);
  });
});

describe('P2 getPaymentIntent', () => {
  const full = () => {
    t.add({ id: ID(1), status: 'held_for_review', gateway: 'khalti', createdAt: sec(-600), lastCheckedAt: sec(-60), lastRaw: 'Pending', holdReason: 'gateway_pending' });
    t.h.db.put('payments.intent_transitions', { id: ID(100), tenant_id: A, intent_id: ID(1), from_status: null, to_status: 'created', cause: 'create', actor_type: 'user', created_at: new Date(sec(-600)), created_by: A });
    t.h.db.put('payments.intent_transitions', { id: ID(101), tenant_id: A, intent_id: ID(1), from_status: 'created', to_status: 'initiated', cause: 'create', actor_type: 'user', created_at: new Date(sec(-599)), created_by: A });
    t.h.db.put('payments.intent_transitions', { id: ID(102), tenant_id: A, intent_id: ID(1), from_status: 'initiated', to_status: 'held_for_review', cause: 'verify_call', reason_code: 'gateway_pending', actor_type: 'system', created_at: new Date(sec(-60)), created_by: A });
  };
  const gc = (n: number, at: string, over: Record<string, unknown> = {}) => t.h.db.put('payments.gateway_calls', { id: ID(200 + n), tenant_id: A, intent_id: ID(1), merchant_account_id: 'MERCHANT-SENTINEL', gateway: 'khalti',
    operation: 'khalti_lookup', attempt: 1, http_status: 200, outcome: 'answer', gateway_status_raw: 'Pending', response_redacted: 'RAW-PAYLOAD-SENTINEL', duration_ms: 5, created_at: new Date(at), created_by: A, ...over });
  const cb = (n: number, at: string, over: Record<string, unknown> = {}) => t.h.db.put('payments.callbacks', { id: ID(300 + n), tenant_id: A, intent_id: ID(1), gateway: 'khalti', kind: 'khalti_return',
    query_redacted: { pidx: 'RAW-PAYLOAD-SENTINEL' }, signature_valid: null, outcome_code: 'ok', received_at: new Date(at), created_at: new Date(at), created_by: A, ...over });

  it('200 PaymentIntentDetail with the TRD fields; allowlist exact; no token / URLs / merchant id / payloads; no null', async () => {
    full(); gc(1, sec(-61)); cb(1, sec(-62), { kind: 'esewa_success', gateway: 'esewa', signature_valid: false, outcome_code: 'payments.signature_invalid' });
    const r = await get(ID(1));
    expect(r.status).toBe(200);
    const b = r.body;
    for (const k of Object.keys(b)) expect([...SUMMARY, ...DETAIL_EXTRA], k).toContain(k);
    expect(b).toMatchObject({ id: ID(1), centre_id: CENTRE_1, gateway: 'khalti', status: 'held_for_review', hold_reason: 'gateway_pending', amount: { amount_paisa: 225000, currency: 'NPR' }, refunded_amount: { amount_paisa: 0, currency: 'NPR' },
      gateway_secondary_ref: 'SYN-TXN-REF-1', created_by_actor_type: 'user', last_gateway_status_raw: 'Pending', version: 1, refunds: [] });
    expect(b.gateway_txn_ref).toMatch(/^SYN-PIDX-/);
    expect(b.transitions.map((x: any) => x.to_status)).toEqual(['created', 'initiated', 'held_for_review']);
    expect(b.transitions[2]).toEqual({ from_status: 'initiated', to_status: 'held_for_review', cause: 'verify_call', reason_code: 'gateway_pending', actor_type: 'system', at: sec(-60) });
    expect(b.gateway_checks).toEqual([{ operation: 'khalti_lookup', outcome: 'answer', gateway_status_raw: 'Pending', http_status: 200, at: sec(-61) }]);
    expect(b.callbacks).toEqual([{ kind: 'esewa_success', outcome_code: 'payments.signature_invalid', signature_valid: false, at: sec(-62) }]);
    for (const s of SENTINELS) expect(JSON.stringify(b)).not.toContain(s);
    expect(JSON.stringify(b)).not.toMatch(/callback_token|return_url|cancel_url|payment_url|idempotency|fingerprint|merchant_account|response_redacted|query_redacted/);
    expect(hasNull(b)).toBe(false);
  });

  it('gateway_checks and callbacks are the LAST 20 only (the 5 oldest of 25 are dropped)', async () => {
    full();
    for (let i = 1; i <= 25; i++) { gc(i, sec(-1000 + i), { gateway_status_raw: `S${i}` }); cb(i, sec(-1000 + i)); }
    const b = (await get(ID(1))).body;
    expect(b.gateway_checks).toHaveLength(20); expect(b.callbacks).toHaveLength(20);
    expect(b.gateway_checks.map((x: any) => x.gateway_status_raw).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `S${i + 6}`).sort());
    expect(Math.min(...b.callbacks.map((x: any) => Date.parse(x.at)))).toBe(Date.parse(sec(-1000 + 6)));
  });

  it('a settled intent shows verified_amount, ledger_entry_id, verification_method and settled_at', async () => {
    t.add({ id: ID(2), status: 'settled', gateway: 'esewa' });
    expect((await get(ID(2))).body).toMatchObject({ status: 'settled', verified_amount: { amount_paisa: 225000, currency: 'NPR' }, verification_method: 'esewa_status_check',
      ledger_entry_id: '01900000-0000-7000-8000-0000000c8000', settled_at: FIXED_NOW });
  });

  it('a refund row of the intent appears in refunds[] (RefundDto mapping itself is PG-T14); another intent\'s refund does not', async () => {
    full(); t.add({ id: ID(3), status: 'settled' });
    const refund = (id: string, intent: string) => t.h.db.put('payments.refunds', { id, tenant_id: A, intent_id: intent, order_id: t.row(intent).order_id, centre_id: CENTRE_1, gateway: 'khalti', mode: 'manual',
      status: 'pending_approval', amount_paisa: 1000, reason_code: 'overpayment', requested_by_membership_id: A, requested_at: new Date(FIXED_NOW), created_by: A, updated_by: A });
    refund(ID(400), ID(1)); refund(ID(401), ID(3));
    const r = (await get(ID(1))).body.refunds;
    expect(r.map((x: any) => x.id)).toEqual([ID(400)]);
  });

  it('a read has no side effect: no gateway call, no transition, no access_log row (only P4/P16/P21/P23 write access_log, TRD §5.1)', async () => {
    full();
    const before = snap(ID(1));
    await get(ID(1));
    expect(t.checks()).toHaveLength(0); expect(t.access()).toHaveLength(0); expect(snap(ID(1))).toBe(before); expect(t.h.db.transitions(A)).toHaveLength(3);
  });

  it('AC-PG-14.1 / ST-15: a tenant-B intent id under tenant-A claims is byte-identical to an unknown id: 404 common.not_found, no B data, no side effect', async () => {
    t.add({ id: ID(60), tenant: 'B', status: 'held_for_review' });
    const probe = await get(ID(60)); const unknown = await get(ID(99));
    expect(probe.code).toBe('common.not_found');
    expect(JSON.stringify({ c: probe.code, s: probe.status, b: probe.body })).toBe(JSON.stringify({ c: unknown.code, s: unknown.status, b: unknown.body }));
    expect(JSON.stringify(probe)).not.toContain(ID(60));
    expect(t.access('B')).toHaveLength(0);
  });

  it('ST-18: a centre-1 finance user reading a centre-2 intent gets the SAME 404 as an unknown id (no existence oracle), and the object-level assertRole carried the intent\'s centre', async () => {
    t.add({ id: ID(3), status: 'failed', centre: CENTRE_2 });
    const r = await get(ID(3), { as: 'finance_centre1' }); const unknown = await get(ID(99), { as: 'finance_centre1' });
    expect(r.code).toBe('common.not_found');
    expect(JSON.stringify({ s: r.status, b: r.body })).toBe(JSON.stringify({ s: unknown.status, b: unknown.body }));
    expect(t.idCalls.some((c) => c.permission === 'payments.reconciliation.read' && c.centreId === CENTRE_2)).toBe(true);
    expect((await get(ID(3))).status).toBe(200);                                              // an all-centre user still reads it
  });

  it.each(['x', "' OR 1=1 --", '../../etc/passwd', '%00', 'A'.repeat(4096), '00000000-0000-0000-0000-000000000000', '', '０１２３'])('REQ-SEC-044 id probe %j -> 400 common.validation_failed (or 404), never a 5xx, no SQL from it', async (bad) => {
    const r = await get(bad);
    expect(['common.validation_failed', 'common.not_found']).toContain(r.code);
    expect(t.h.db.stmts.map((s) => JSON.stringify(s.values)).join('')).not.toMatch(/OR 1=1|etc\/passwd/);
  });

  it('permission: front_desk -> 403 before any payments read (asserted payments.reconciliation.read)', async () => {
    full();
    const before = t.h.db.stmts.length;
    const r = await get(ID(1), { as: 'front_desk' });
    expect(r.code).toBe('auth.forbidden'); expect(t.idCalls[0]).toMatchObject({ permission: 'payments.reconciliation.read', at: before }); expect(t.readStmts(before)).toEqual([]);
  });
});

describe('P3 recheckPaymentIntent (AC-PG-07.1, 07.5, 07.7)', () => {
  it('AC-PG-07.1: held_for_review + gateway now success with the exact amount -> 200 PaymentIntentDetail, held_for_review -> settled with ledger once + event once, transition cause recheck', async () => {
    const o = t.add({ id: ID(1), status: 'held_for_review', gateway: 'esewa', holdReason: 'gateway_ambiguous', lastCheckedAt: sec(-60) });
    t.script(o, 'COMPLETE');
    const r = await recheck(ID(1));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID(1), status: 'settled', verification_method: 'esewa_status_check', verified_amount: { amount_paisa: 225000, currency: 'NPR' } });
    for (const k of Object.keys(r.body)) expect([...SUMMARY, ...DETAIL_EXTRA], k).toContain(k);
    expect(ledger()).toHaveLength(1); expect(ledger()[0]).toMatchObject({ intentId: ID(1), gateway: 'esewa', amount: { amountPaisa: 225000, currency: 'NPR' } });
    expect(settledEvents()).toHaveLength(1); expect(t.checks()).toHaveLength(1);
    expect(t.h.db.transitions(A).at(-1)).toMatchObject({ intent_id: ID(1), from_status: 'held_for_review', to_status: 'settled', cause: 'recheck', actor_type: 'user' });
    expect(r.body.transitions.at(-1)).toMatchObject({ to_status: 'settled', cause: 'recheck' });           // the response is the refreshed detail
  });

  it('the first re-check of an intent never checked before (last_checked_at null) is allowed; an initiated / pending intent can be re-checked too', async () => {
    for (const [i, status] of (['initiated', 'pending'] as const).entries()) {
      const o = t.add({ id: ID(10 + i), status, gateway: 'khalti' }); t.script(o, 'Initiated');
      const r = await recheck(ID(10 + i));
      expect(r.status).toBe(200); expect(r.body.status).toBe(status); expect(r.body.last_checked_at).toBe(FIXED_NOW);
    }
    expect(t.checks()).toHaveLength(2);
  });

  it('AC-PG-07.7: a second re-check within VERIFY_MIN_INTERVAL_SECONDS of the last gateway check -> 429 common.rate_limited + Retry-After, NO gateway call, nothing changed', async () => {
    const min = t.h.config.verifyMinIntervalSeconds;
    const o = t.add({ id: ID(1), status: 'held_for_review', lastCheckedAt: sec(-(min - 3)) }); t.script(o, 'COMPLETE');
    const before = snap(ID(1));
    const r = await recheck(ID(1));
    expect(r.code).toBe('common.rate_limited'); expect(r.status).toBe(429);
    expect(r.err.retryAfterSeconds).toBeGreaterThanOrEqual(1); expect(r.err.retryAfterSeconds).toBeLessThanOrEqual(min); expect(Number(hdr(r, 'retry-after'))).toBeGreaterThanOrEqual(1);
    expect(t.checks()).toHaveLength(0); expect(ledger()).toHaveLength(0); expect(snap(ID(1))).toBe(before); expect(t.h.db.transitions(A)).toHaveLength(0);
  });

  it('the interval is measured from the last gateway check: pressing the button twice in a row -> first 200, second 429, one gateway call', async () => {
    const o = t.add({ id: ID(1), status: 'held_for_review', gateway: 'khalti', holdReason: 'gateway_pending' }); t.script(o, 'Pending');
    expect((await recheck(ID(1))).status).toBe(200);
    const second = await recheck(ID(1), { now: sec(2) });
    expect(second.code).toBe('common.rate_limited');
    expect(t.checks()).toHaveLength(1);
    expect((await recheck(ID(1), { now: sec(t.h.config.verifyMinIntervalSeconds + 1) })).status).toBe(200);        // allowed again once the interval has passed
    expect(t.checks()).toHaveLength(2);
  });

  it.each(['settled', 'failed', 'expired', 'created', 'refunded', 'partially_refunded'])('a %s intent cannot be re-checked: 409 payments.intent_invalid_transition, no gateway call, nothing changed', async (status) => {
    t.add({ id: ID(1), status });
    const before = snap(ID(1));
    const r = await recheck(ID(1));
    expect(r.code).toBe('payments.intent_invalid_transition');
    expect(t.checks()).toHaveLength(0); expect(snap(ID(1))).toBe(before); expect(ledger()).toHaveLength(0);
  });

  it('gateway unavailable during the in-request check -> payments.gateway_not_available and no state change (the money is never moved on a guess)', async () => {
    const o = t.add({ id: ID(1), status: 'held_for_review', gateway: 'esewa' }); t.script(o, 'code:0');
    const before = snap(ID(1));
    const r = await recheck(ID(1));
    expect(r.code).toBe('payments.gateway_not_available');
    expect(snap(ID(1))).toBe(before); expect(ledger()).toHaveLength(0);
  });

  it('AC-PG-07.5: front_desk -> 403 auth.forbidden; finance at aal1 -> 403 auth.mfa_required; both BEFORE any payments read, no gateway call, no change; permission asserted = payments.intent.resolve', async () => {
    const o = t.add({ id: ID(1), status: 'held_for_review' }); t.script(o, 'COMPLETE');
    const before = snap(ID(1));
    for (const [as, code] of [['front_desk', 'auth.forbidden'], ['finance_aal1', 'auth.mfa_required'], ['nobody', 'auth.forbidden']] as const) {
      const n = t.h.db.stmts.length;
      const r = await recheck(ID(1), { as });
      expect(r.code).toBe(code);
      expect(t.idCalls.at(-1)).toMatchObject({ permission: 'payments.intent.resolve' });
      expect(t.readStmts(n)).toEqual([]);
    }
    expect(t.checks()).toHaveLength(0); expect(ledger()).toHaveLength(0); expect(snap(ID(1))).toBe(before);
  });

  it('ST-18: a centre-1 finance user re-checking a centre-2 intent -> 404 common.not_found, no gateway call; own-centre intent works', async () => {
    const o2 = t.add({ id: ID(3), status: 'held_for_review', centre: CENTRE_2 }); t.script(o2, 'COMPLETE');
    const o1 = t.add({ id: ID(4), status: 'held_for_review', centre: CENTRE_1 }); t.script(o1, 'COMPLETE');
    const other = await recheck(ID(3), { as: 'finance_centre1' });
    expect(other.code).toBe('common.not_found'); expect(t.checks()).toHaveLength(0); expect(t.row(ID(3)).status).toBe('held_for_review');
    expect((await recheck(ID(4), { as: 'finance_centre1' })).body.status).toBe('settled');
    expect(t.idCalls.some((c) => c.permission === 'payments.intent.resolve' && c.centreId === CENTRE_2)).toBe(true);
  });

  it('AC-PG-14.1 / ST-15: a tenant-B intent -> 404 identical to an unknown id; B\'s intent untouched, no gateway call', async () => {
    const ob = t.add({ id: ID(60), tenant: 'B', status: 'held_for_review' }); t.script(ob, 'COMPLETE');
    const before = JSON.stringify(t.row(ID(60), 'B'));
    const probe = await recheck(ID(60)); const unknown = await recheck(ID(99));
    expect(probe.code).toBe('common.not_found');
    expect(JSON.stringify({ s: probe.status, b: probe.body })).toBe(JSON.stringify({ s: unknown.status, b: unknown.body }));
    expect(t.checks()).toHaveLength(0); expect(JSON.stringify(t.row(ID(60), 'B'))).toBe(before);
  });

  it('a re-check writes no access_log row (only the row-audit trigger evidences it, TRD §5.1) and logs no secret', async () => {
    const o = t.add({ id: ID(1), status: 'held_for_review', gateway: 'khalti' }); t.script(o, 'Pending');
    await recheck(ID(1));
    expect(t.access()).toHaveLength(0);
    expect(JSON.stringify([t.logs, t.h.alerts, t.h.db.logs])).not.toMatch(/SENTINEL|synthetic-(esewa|khalti)-secret/);
  });
});

describe('P4 resolvePaymentIntent (AC-PG-07.1-07.6)', () => {
  const held = (n: number, o: { gateway?: 'esewa' | 'khalti'; hold?: string; lastRaw?: string; lastChecked?: string } = {}) => {
    const orderId = t.add({ id: ID(n), status: 'held_for_review', gateway: o.gateway ?? 'esewa', holdReason: o.hold ?? 'gateway_ambiguous', ...(o.lastRaw ? { lastRaw: o.lastRaw } : {}), ...(o.lastChecked ? { lastCheckedAt: o.lastChecked } : {}) });
    return orderId;
  };
  const paid = (o: string, g: 'esewa' | 'khalti' = 'esewa') => t.script(o, g === 'esewa' ? 'COMPLETE' : 'Completed');

  it('AC-PG-07.1 / 07.3 settle: gateway confirms success + exact amount -> 200 settled, ledger once, one event, FORCED fresh check even 1 s after the last (P4 never rate-limited), reason + resolver stored', async () => {
    const o = held(1, { lastChecked: sec(-1) }); paid(o);
    const r = await resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid', note: 'Synthetic note: confirmed with provider' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID(1), status: 'settled', verified_amount: { amount_paisa: 225000, currency: 'NPR' } });
    expect(r.body.version).toBeGreaterThan(1);
    expect(ledger()).toHaveLength(1); expect(ledger()[0]).not.toHaveProperty('allowExceedsDue'); expect(settledEvents()).toHaveLength(1); expect(t.checks()).toHaveLength(1);
    expect(t.row(ID(1))).toMatchObject({ status: 'settled', resolution_reason_code: 'gateway_confirmed_paid', resolution_note: 'Synthetic note: confirmed with provider' });
    expect(t.row(ID(1)).resolved_by).toBeTruthy(); expect(t.row(ID(1)).resolved_at).toBeTruthy();
    expect(t.h.db.transitions(A).at(-1)).toMatchObject({ from_status: 'held_for_review', to_status: 'settled', cause: 'resolve', reason_code: 'gateway_confirmed_paid', actor_type: 'user' });
  });

  it('AC-PG-07.2 fail: reason gateway_confirmed_unpaid -> 200 failed (failure_reason resolved_failed), no ledger, transition cause resolve, reason stored', async () => {
    const o = held(1, { lastRaw: 'AMBIGUOUS' }); t.script(o, 'AMBIGUOUS');
    const r = await resolve(ID(1), { resolution: 'fail', reason_code: 'gateway_confirmed_unpaid' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ status: 'failed', failure_reason: 'resolved_failed' });
    expect(ledger()).toHaveLength(0); expect(settledEvents()).toHaveLength(0);
    expect(t.row(ID(1))).toMatchObject({ status: 'failed', failure_reason: 'resolved_failed', resolution_reason_code: 'gateway_confirmed_unpaid' });
    expect(t.h.db.transitions(A).at(-1)).toMatchObject({ from_status: 'held_for_review', to_status: 'failed', cause: 'resolve', reason_code: 'gateway_confirmed_unpaid' });
  });

  it('AC-PG-07.2 / 6.5: "Mark failed" while the latest gateway check IS success -> 409 payments.intent_not_verifiable (never fail a paid intent), nothing changed', async () => {
    const o = held(1, { lastRaw: 'COMPLETE' }); paid(o);
    const before = snap(ID(1));
    const r = await resolve(ID(1), { resolution: 'fail', reason_code: 'gateway_confirmed_unpaid' });
    expect(r.code).toBe('payments.intent_not_verifiable'); expect(r.status).toBe(409);
    expect(snap(ID(1))).toBe(before); expect(t.h.db.transitions()).toHaveLength(0);
  });

  it.each([['gateway says pending', 'PENDING', undefined], ['gateway says canceled', 'CANCELED', undefined], ['amount mismatch', 'COMPLETE', 2250], ['gateway unknown status', 'WHATEVER', undefined]])(
    'AC-PG-07.3: settle while the latest gateway check is not success + exact amount (%s) -> 409 payments.intent_not_verifiable; no ledger, no event, still held, no transition', async (_n, status, amt) => {
      const o = held(1); t.script(o, status, amt);
      const before = snap(ID(1));
      const r = await resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' });
      expect(r.code).toBe('payments.intent_not_verifiable'); expect(r.status).toBe(409);
      expect(ledger()).toHaveLength(0); expect(settledEvents()).toHaveLength(0); expect(snap(ID(1))).toBe(before); expect(t.h.db.transitions()).toHaveLength(0);
    });

  it.each([['settle', 'gateway_ambiguous'], ['record_exceeding_due', 'exceeds_due']] as const)(
    'TRD 6.5: %s while the forced gateway check gets NO answer (transient) -> 409 payments.intent_not_verifiable (not gateway_not_available); still held, no ledger, no event, no transition, no access_log row', async (resolution, hold) => {
      const o = held(1, { hold }); t.script(o, 'code:0');
      const before = snap(ID(1));
      const r = await resolve(ID(1), { resolution, reason_code: 'gateway_confirmed_paid' });
      expect(r.code).toBe('payments.intent_not_verifiable'); expect(r.status).toBe(409);
      expect(t.row(ID(1)).status).toBe('held_for_review'); expect(snap(ID(1))).toBe(before);
      expect(ledger()).toHaveLength(0); expect(settledEvents()).toHaveLength(0); expect(t.h.db.transitions(A)).toHaveLength(0); expect(t.access()).toHaveLength(0);
    });

  it('AC-PG-07.4: hold exceeds_due + latest check success + exact amount, "Record anyway" -> recordGatewayPayment with allowExceedsDue true, settled; plain "settle" of the same intent is refused (not_verifiable)', async () => {
    const o = held(1, { hold: 'exceeds_due' }); paid(o);
    t.h.setOrder({ id: o, tenantId: A, dueAmountPaisa: 100000, gatewayStatus: 'COMPLETE' });                // the due fell after the intent was created
    const plain = await resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' });
    expect(plain.code).toBe('payments.intent_not_verifiable'); expect(ledger()).toHaveLength(0);
    const r = await resolve(ID(1), { resolution: 'record_exceeding_due', reason_code: 'gateway_confirmed_paid' });
    expect(r.status).toBe(200); expect(r.body.status).toBe('settled');
    expect(ledger()).toHaveLength(1); expect(ledger()[0]).toMatchObject({ intentId: ID(1), allowExceedsDue: true });
    expect(settledEvents()).toHaveLength(1);
  });

  it('record_exceeding_due on an intent whose hold_reason is not exceeds_due is refused (no ledger call, still held)', async () => {
    const o = held(1, { hold: 'gateway_ambiguous' }); paid(o);
    const r = await resolve(ID(1), { resolution: 'record_exceeding_due', reason_code: 'gateway_confirmed_paid' });
    expect(['payments.intent_invalid_transition', 'payments.intent_not_verifiable']).toContain(r.code);
    expect(ledger()).toHaveLength(0); expect(t.row(ID(1)).status).toBe('held_for_review');
  });

  it('access log (08 A13 P-3 / A19 D-112): exactly one payment_intent.resolve row on the entity payment_intent, outcome allowed, detail {resolution, reason_code} — never the note', async () => {
    const o = held(1); paid(o);
    await resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid', note: 'NOTE-TEXT-MUST-NOT-BE-LOGGED' });
    expect(t.access()).toEqual([{ action: 'payment_intent.resolve', entityType: 'payment_intent', entityId: ID(1), outcome: 'allowed', detail: { resolution: 'settle', reason_code: 'gateway_confirmed_paid' } }]);
    expect(JSON.stringify([t.access(), t.logs, t.h.alerts])).not.toContain('NOTE-TEXT-MUST-NOT-BE-LOGGED');
    const f = held(2, { lastRaw: 'AMBIGUOUS' }); t.script(f, 'AMBIGUOUS');
    await resolve(ID(2), { resolution: 'fail', reason_code: 'gateway_confirmed_unpaid' });
    expect(t.access().map((x) => [x.entityId, x.detail])).toEqual([[ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' }], [ID(2), { resolution: 'fail', reason_code: 'gateway_confirmed_unpaid' }]]);
  });

  it('a refused resolve (not_verifiable) leaves no access_log row (the unit of work is rolled back)', async () => {
    const o = held(1); t.script(o, 'PENDING');
    await resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' });
    expect(t.access()).toHaveLength(0);
  });

  it('AC-PG-07.5: front_desk -> 403 auth.forbidden, finance at aal1 -> 403 auth.mfa_required; no read, no gateway call, no ledger, no access_log row — and the auth check wins over a missing If-Match', async () => {
    const o = held(1); paid(o);
    const before = snap(ID(1));
    for (const [as, code] of [['front_desk', 'auth.forbidden'], ['finance_aal1', 'auth.mfa_required']] as const) {
      const n = t.h.db.stmts.length;
      const r = await resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' }, { as, headers: {} });
      expect(r.code).toBe(code); expect(t.readStmts(n)).toEqual([]);
    }
    expect(t.idCalls.every((c) => c.permission === 'payments.intent.resolve')).toBe(true);
    expect(t.checks()).toHaveLength(0); expect(ledger()).toHaveLength(0); expect(t.access()).toHaveLength(0); expect(snap(ID(1))).toBe(before);
  });

  it('AC-PG-07.6: stale If-Match -> 409 common.version_conflict, nothing changed (no gateway call needed, no ledger)', async () => {
    const o = held(1); paid(o);
    const before = snap(ID(1));
    const r = await resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' }, { v: 7 });
    expect(r.code).toBe('common.version_conflict'); expect(r.status).toBe(409);
    expect(ledger()).toHaveLength(0); expect(snap(ID(1))).toBe(before); expect(t.access()).toHaveLength(0);
  });

  it('If-Match: missing -> 428 common.precondition_required; malformed (unquoted, non-numeric, 0, negative, huge) -> 400 common.validation_failed; nothing changed', async () => {
    const o = held(1); paid(o);
    const before = snap(ID(1));
    expect((await resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' }, { headers: {} })).code).toBe('common.precondition_required');
    for (const bad of ['1', '"abc"', '"0"', '"-1"', '"99999999999"', '""', 'W/"1"']) {
      const r = await resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' }, { headers: { 'if-match': bad } });
      expect([bad, r.code]).toEqual([bad, 'common.validation_failed']);
    }
    expect(ledger()).toHaveLength(0); expect(snap(ID(1))).toBe(before);
  });

  it.each([
    ['unknown key (a caller-supplied amount rides along)', { resolution: 'settle', reason_code: 'gateway_confirmed_paid', amount_paisa: 1 }],
    ['unknown key status', { resolution: 'settle', reason_code: 'gateway_confirmed_paid', status: 'settled' }],
    ['missing resolution', { reason_code: 'gateway_confirmed_paid' }],
    ['missing reason_code', { resolution: 'settle' }],
    ['unknown resolution', { resolution: 'refund', reason_code: 'gateway_confirmed_paid' }],
    ['reason_code not in resolution_reasons', { resolution: 'settle', reason_code: 'made_up_code' }],
    ['reason_code of another coded set (cancel_reasons)', { resolution: 'settle', reason_code: 'patient_left' }],
    ['reason_code with SQL meta', { resolution: 'settle', reason_code: "x'; DROP TABLE payments.intents;--" }],
    ['reason_code requires_text (other) without a note', { resolution: 'settle', reason_code: 'other' }],
    ['note > 500 chars', { resolution: 'settle', reason_code: 'gateway_confirmed_paid', note: 'n'.repeat(501) }],
    ['note not a string', { resolution: 'settle', reason_code: 'gateway_confirmed_paid', note: 5 }],
    ['body is an array', []],
    ['body missing', undefined],
    ['body null', null],
  ])('invalid body (%s) -> 400 common.validation_failed, no gateway call, nothing changed', async (_n, body) => {
    const o = held(1); paid(o);
    const before = snap(ID(1));
    const r = await resolve(ID(1), body);
    expect(r.code).toBe('common.validation_failed');
    expect(t.checks()).toHaveLength(0); expect(ledger()).toHaveLength(0); expect(snap(ID(1))).toBe(before);
    expect(t.h.db.stmts.map((s) => JSON.stringify(s.values)).join('')).not.toContain('DROP TABLE');
  });

  it('a note of exactly 500 chars is accepted; reason_code other + a note is accepted', async () => {
    const o = held(1); paid(o);
    expect((await resolve(ID(1), { resolution: 'settle', reason_code: 'other', note: 'n'.repeat(500) })).status).toBe(200);
    expect(t.row(ID(1)).resolution_note).toHaveLength(500);
  });

  it.each(['settled', 'failed', 'expired', 'refunded'])('resolving a %s intent (not held) -> 409 payments.intent_invalid_transition, nothing changed', async (status) => {
    t.add({ id: ID(1), status });
    const before = snap(ID(1));
    const r = await resolve(ID(1), { resolution: 'fail', reason_code: 'gateway_confirmed_unpaid' });
    expect(r.code).toBe('payments.intent_invalid_transition'); expect(snap(ID(1))).toBe(before); expect(ledger()).toHaveLength(0);
  });

  it('ST-06: 5 concurrent "settle" resolves with the same If-Match -> exactly one 200, one ledger call, one event, one settled transition; the rest are 409', async () => {
    const o = held(1); paid(o);
    const rs = await Promise.all(Array.from({ length: 5 }, () => resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of rs.filter((x) => x.status !== 200)) expect(['common.version_conflict', 'payments.intent_invalid_transition']).toContain(r.code);
    expect(ledger()).toHaveLength(1); expect(settledEvents()).toHaveLength(1);
    expect(t.h.db.transitions(A).filter((x) => x.to_status === 'settled')).toHaveLength(1); expect(t.access()).toHaveLength(1);
  });

  it('ST-18: a centre-1 finance user resolving a centre-2 intent -> 404 common.not_found, no gateway call, no ledger, no access_log row; ST-15: a tenant-B intent -> the same 404', async () => {
    const o = held(1); t.h.db.intents(A)[0]!.centre_id = CENTRE_2; paid(o);
    const ob = t.add({ id: ID(60), tenant: 'B', status: 'held_for_review' }); paid(ob);
    const a = await resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' }, { as: 'finance_centre1' });
    const b = await resolve(ID(60), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' });
    const unknown = await resolve(ID(99), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' });
    for (const r of [a, b, unknown]) expect(r.code).toBe('common.not_found');
    expect(JSON.stringify({ s: b.status, b: b.body })).toBe(JSON.stringify({ s: unknown.status, b: unknown.body }));
    expect(t.checks()).toHaveLength(0); expect(ledger()).toHaveLength(0); expect(t.access()).toHaveLength(0); expect(t.access('B')).toHaveLength(0);
    expect(t.row(ID(60), 'B').status).toBe('held_for_review');
  });

  it.each(['x', "' OR 1=1 --", '../../etc/passwd', 'A'.repeat(4096), '00000000-0000-0000-0000-000000000000'])('REQ-SEC-044 id probe %j -> 400/404, never a 5xx, no SQL from it', async (bad) => {
    const r = await resolve(bad, { resolution: 'settle', reason_code: 'gateway_confirmed_paid' });
    expect(['common.validation_failed', 'common.not_found']).toContain(r.code);
    expect(t.h.db.stmts.map((s) => JSON.stringify(s.values)).join('')).not.toMatch(/OR 1=1|etc\/passwd/);
  });
});

describe('P5 cancelPaymentIntent (AC-PG-13.1, 13.3)', () => {
  it('an initiated eSewa intent the gateway has not paid -> 200 {intent_id, status:"failed"} exactly; failure_reason abandoned; transition cause cancel with the reason; the gateway was asked first', async () => {
    const o = t.add({ id: ID(1), status: 'initiated', gateway: 'esewa' }); t.script(o, 'PENDING');
    const r = await cancel(ID(1), 'wrong_amount');
    expect(r.status).toBe(200); expect(r.body).toEqual({ intent_id: ID(1), status: 'failed' });
    expect(t.row(ID(1))).toMatchObject({ status: 'failed', failure_reason: 'abandoned' });
    expect(t.h.db.transitions(A).at(-1)).toMatchObject({ from_status: 'pending', to_status: 'failed', cause: 'cancel', reason_code: 'wrong_amount' });
    expect(t.checks()).toHaveLength(1);
  });

  it('AC-PG-13.1: an initiated Khalti intent the gateway says Completed (exact) -> settles instead, and the response says so (status settled), ledger once', async () => {
    const o = t.add({ id: ID(1), status: 'initiated', gateway: 'khalti' }); t.script(o, 'Completed');
    const r = await cancel(ID(1));
    expect(r.status).toBe(200); expect(r.body).toEqual({ intent_id: ID(1), status: 'settled' });
    expect(ledger()).toHaveLength(1); expect(t.row(ID(1)).status).toBe('settled');
  });

  it.each(['settled', 'failed', 'expired', 'held_for_review', 'refunded'])('a %s intent cannot be cancelled: 409 payments.intent_invalid_transition, no gateway call, nothing changed', async (status) => {
    t.add({ id: ID(1), status });
    const before = snap(ID(1));
    const r = await cancel(ID(1));
    expect(r.code).toBe('payments.intent_invalid_transition'); expect(t.checks()).toHaveLength(0); expect(snap(ID(1))).toBe(before);
  });

  it.each([['unknown code', 'made_up'], ['code of another set (resolution_reasons)', 'gateway_confirmed_paid'], ['SQL meta', "x'; DROP TABLE payments.intents;--"], ['too long', 'a'.repeat(65)], ['upper case', 'PATIENT_LEFT']])(
    'reason_code %s -> 400 common.validation_failed, intent untouched', async (_n, code) => {
      t.add({ id: ID(1), status: 'initiated' });
      const before = snap(ID(1));
      expect((await cancel(ID(1), code)).code).toBe('common.validation_failed');
      expect(snap(ID(1))).toBe(before); expect(t.checks()).toHaveLength(0);
    });

  it.each([['extra key', { reason_code: 'patient_left', amount_paisa: 1 }], ['missing reason_code', {}], ['body array', []], ['body missing', undefined]])('invalid body (%s) -> 400 common.validation_failed', async (_n, body) => {
    t.add({ id: ID(1), status: 'initiated' });
    expect((await t.call('cancelPaymentIntent', { params: { intent_id: ID(1) }, body, as: 'front_desk' })).code).toBe('common.validation_failed');
    expect(t.row(ID(1)).status).toBe('initiated');
  });

  it('AC-PG-13.3: a front_desk user (payments.intent.create, not reconciliation.read) cancels through P5 (permission asserted = payments.intent.create) and reads reasons through P24b', async () => {
    const o = t.add({ id: ID(1), status: 'initiated', gateway: 'esewa' }); t.script(o, 'PENDING');
    const r = await cancel(ID(1), 'patient_left', { as: 'front_desk' });
    expect(r.status).toBe(200); expect(r.body.status).toBe('failed');
    expect(t.idCalls.every((c) => c.permission === 'payments.intent.create')).toBe(true);
    expect((await t.call('listPaymentCancelReasons', { as: 'front_desk' })).status).toBe(200);
  });

  it('a user without payments.intent.create (finance-only, nobody) -> 403 auth.forbidden before any payments read; nothing changed', async () => {
    t.add({ id: ID(1), status: 'initiated' });
    const before = snap(ID(1));
    for (const as of ['finance', 'nobody'] as const) {
      const n = t.h.db.stmts.length;
      expect((await cancel(ID(1), 'patient_left', { as })).code).toBe('auth.forbidden'); expect(t.readStmts(n)).toEqual([]);
    }
    expect(snap(ID(1))).toBe(before);
  });

  it('ST-18: a centre-1 front-desk user cancelling a centre-2 intent -> 404 common.not_found; ST-15: a tenant-B intent -> the same 404; neither is touched, no gateway call', async () => {
    t.add({ id: ID(3), status: 'initiated', centre: CENTRE_2 }); t.add({ id: ID(60), tenant: 'B', status: 'initiated' });
    const a = await cancel(ID(3), 'patient_left', { as: 'front_desk_centre1' });
    const b = await cancel(ID(60)); const unknown = await cancel(ID(99));
    for (const r of [a, b, unknown]) expect(r.code).toBe('common.not_found');
    expect(JSON.stringify({ s: b.status, b: b.body })).toBe(JSON.stringify({ s: unknown.status, b: unknown.body }));
    expect(t.row(ID(3)).status).toBe('initiated'); expect(t.row(ID(60), 'B').status).toBe('initiated'); expect(t.checks()).toHaveLength(0);
  });

  it('a cancel writes no access_log row (only P4/P16/P21/P23 do)', async () => {
    const o = t.add({ id: ID(1), status: 'initiated' }); t.script(o, 'PENDING');
    await cancel(ID(1));
    expect(t.access()).toHaveLength(0);
  });
});

describe('P24 listPaymentCodes / P24b listPaymentCancelReasons (AC-PG-13.3, 08 A19 P-43)', () => {
  const SETS = ['hold_reasons', 'failure_reasons', 'cancel_reasons', 'resolution_reasons', 'refund_reasons'];
  const codes = (set: string, o: { as?: any; tenant?: 'A' | 'B' } = {}) => t.call('listPaymentCodes', { params: { set_name: set }, ...o });

  it.each(SETS)('P24 %s -> 200 {data:[{code, display, requires_text, is_active}]} in sort order, exactly those four fields', async (set) => {
    const r = await codes(set);
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.code)).toEqual(t.SETS[set]!.map((x) => x[0]));
    for (const x of r.body.data) expect(Object.keys(x).sort()).toEqual([...CODE_ITEM].sort());
    expect(hasNull(r.body)).toBe(false);
  });

  it('requires_text and display come from the set (cancel_reasons.other requires text)', async () => {
    const other = (await codes('cancel_reasons')).body.data.find((x: any) => x.code === 'other');
    expect(other).toEqual({ code: 'other', display: 'Other', requires_text: true, is_active: true });
  });

  it('a tenant override shadows the global code by code (relabel / deactivate); another tenant\'s override is invisible', async () => {
    t.override('A', 'cancel_reasons', 'patient_left', { display: 'Patient walked out' });
    t.override('A', 'cancel_reasons', 'staff_error', { is_active: false });
    t.override('B', 'cancel_reasons', 'wrong_amount', { display: 'B-ONLY-LABEL', is_active: false });
    const a = (await codes('cancel_reasons')).body.data;
    expect(a.find((x: any) => x.code === 'patient_left')).toMatchObject({ display: 'Patient walked out', is_active: true });
    expect(a.find((x: any) => x.code === 'staff_error')).toMatchObject({ is_active: false });
    expect(a.find((x: any) => x.code === 'wrong_amount')).toMatchObject({ display: 'Wrong amount', is_active: true });
    expect(a).toHaveLength(5);                                                                  // shadowing, not duplicating
    expect(JSON.stringify(a)).not.toContain('B-ONLY-LABEL');
    expect((await codes('cancel_reasons', { tenant: 'B' })).body.data.find((x: any) => x.code === 'wrong_amount')).toMatchObject({ display: 'B-ONLY-LABEL', is_active: false });
  });

  it.each(['nope', 'cancel_reason', "hold_reasons' OR 1=1 --", '../x', '', 'A'.repeat(200)])('unknown / hostile set_name %j -> 400 common.validation_failed or 404 common.not_found, no SQL built from it', async (set) => {
    const r = await codes(set);
    expect(['common.validation_failed', 'common.not_found']).toContain(r.code);
    expect(t.h.db.stmts.map((s) => JSON.stringify(s.values)).join('')).not.toMatch(/OR 1=1/);
  });

  it('AC-PG-13.3: front_desk gets 403 auth.forbidden from P24 (permission asserted = payments.reconciliation.read, BEFORE any read); finance gets 200', async () => {
    const n = t.h.db.stmts.length;
    const r = await codes('hold_reasons', { as: 'front_desk' });
    expect(r.code).toBe('auth.forbidden'); expect(t.idCalls[0]).toMatchObject({ permission: 'payments.reconciliation.read', at: n }); expect(t.h.db.stmts).toHaveLength(n);
    expect((await codes('hold_reasons', { as: 'finance' })).status).toBe(200);
  });

  it('P24b returns the cancel_reasons set only, in the same item shape, for front_desk (permission asserted = payments.intent.create, before any read); finance-only and nobody get 403', async () => {
    const n = t.h.db.stmts.length;
    const r = await t.call('listPaymentCancelReasons', { as: 'front_desk' });
    expect(r.status).toBe(200);
    expect(t.idCalls[0]).toMatchObject({ permission: 'payments.intent.create', at: n });
    expect(r.body.data.map((x: any) => x.code)).toEqual(t.SETS['cancel_reasons']!.map((x) => x[0]));
    for (const x of r.body.data) expect(Object.keys(x).sort()).toEqual([...CODE_ITEM].sort());
    expect(Object.keys(r.body)).toEqual(['data']);
    for (const as of ['finance', 'nobody'] as const) expect((await t.call('listPaymentCancelReasons', { as })).code).toBe('auth.forbidden');
  });

  it('P24b applies the tenant\'s cancel_reasons override, exactly like P24', async () => {
    t.override('A', 'cancel_reasons', 'patient_left', { display: 'Patient walked out' });
    const p24b = (await t.call('listPaymentCancelReasons', { as: 'front_desk' })).body.data;
    expect(p24b).toEqual((await codes('cancel_reasons')).body.data);
  });

  it('coded-set reads never write (no access_log, no transition) and never call a gateway', async () => {
    await codes('hold_reasons'); await t.call('listPaymentCancelReasons', { as: 'front_desk' });
    expect(t.access()).toHaveLength(0); expect(t.checks()).toHaveLength(0);
  });
});

describe('cross-cutting', () => {
  it('REQ-SEC-081: across every staff response (list, detail, recheck, resolve, cancel) no stored URL / token hash / merchant id / payload ever appears, and no body contains null', async () => {
    const o1 = t.add({ id: ID(1), status: 'held_for_review', gateway: 'khalti' }); t.script(o1, 'Completed');
    t.add({ id: ID(2), status: 'initiated' });
    t.h.db.put('payments.gateway_calls', { id: ID(200), tenant_id: A, intent_id: ID(1), merchant_account_id: 'MERCHANT-SENTINEL', gateway: 'khalti', operation: 'khalti_lookup', attempt: 1, outcome: 'answer',
      response_redacted: 'RAW-PAYLOAD-SENTINEL', duration_ms: 1, created_at: new Date(FIXED_NOW), created_by: A });
    const out = [await list(), await get(ID(1)), await get(ID(2)), await recheck(ID(1), { now: sec(60) }), await cancel(ID(2))];
    for (const r of out) { expect(r.status).toBe(200); for (const s of SENTINELS) expect(JSON.stringify(r.body)).not.toContain(s); expect(hasNull(r.body)).toBe(false); }
    const resolved = await resolve(ID(1), { resolution: 'settle', reason_code: 'gateway_confirmed_paid' }, { v: 99 });
    expect(JSON.stringify(resolved)).not.toMatch(/SENTINEL/);
  });

  it('every operation is refused for an actor with no permission and reads nothing first (REQ-SEC-040)', async () => {
    t.add({ id: ID(1), status: 'held_for_review' });
    const n = t.h.db.stmts.length;
    for (const op of [() => list({}, { as: 'nobody' }), () => get(ID(1), { as: 'nobody' }), () => recheck(ID(1), { as: 'nobody' }), () => resolve(ID(1), { resolution: 'fail', reason_code: 'gateway_confirmed_unpaid' }, { as: 'nobody' }),
      () => cancel(ID(1), 'patient_left', { as: 'nobody' }), () => t.call('listPaymentCodes', { params: { set_name: 'hold_reasons' }, as: 'nobody' }), () => t.call('listPaymentCancelReasons', { as: 'nobody' })]) {
      expect((await op()).code).toBe('auth.forbidden');
    }
    expect(t.readStmts(n)).toEqual([]);                                                         // not one payments.* statement ran for any of the seven
    expect(t.h.db.stmts.filter((s, i) => i >= n && /cs_reasons/.test(s.text))).toEqual([]);
  });
});
