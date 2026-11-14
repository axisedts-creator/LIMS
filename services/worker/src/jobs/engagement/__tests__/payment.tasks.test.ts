// C16.T-PAY1 (worker half) — tasks engagement.create_payment_intent, engagement.refresh_payment_request and the cron engagement.expire_payment_requests.
// (06-PLAN row T-PAY1; 02-TRD §4.7 steps 2-4, §6.2 table rows createIntent / getIntent, §8.1 max 3 + job keys pay:<id> / payref:<id>, §8.2 expire_payment_requests every 10 min; 03-APP-FLOW §4.2 state table;
//  05-SCHEMA payment_requests CHECKs; 01-PRD US-EN-10.1 / 10.3 / 10.4; 07-SECURITY REQ-SEC-046 (the client never supplies an amount), REQ-SEC-059 (Paid only from server state), 08 R8 (the worker calls the port as the system actor).)
// done_when: "Paid only on completed (PaymentProviderPort fake)". tests (plan): every C15 error -> failed code; action scrubbed after ready.
// Fails now: manifest tasks 'engagement.create_payment_intent' / 'engagement.refresh_payment_request' are the T-01 fail-closed stubs (throw "... not implemented"); 'engagement.expire_payment_requests' does not exist.
//
// SEAMS (spec fixes behaviour, not names; same convention as fetch_smart_summary.test.ts):
//   handler = manifest.tasks[id] (TaskHandler); payload {payment_request_id} (+ optional tenant_id, exactly what E41 / E42 enqueue); ctx = world.jobCtx({ports}) (system actor, tx, now(), log).
//   Reads / updates engagement.payment_requests in PLAIN SQL the link world runs (WHERE tenant_id = $n AND id = $m [AND status = ..]; no JOIN, no interval arithmetic: bind a computed cutoff, `expires_at < $2`).
//   create_payment_intent (queued only): PaymentProviderPort.createIntent(ctx, {orderId, gateway, idempotencyKey: 'eng:' + id, returnUrl, cancelUrl}) with EXACTLY those five keys (no amount, REQ-SEC-046),
//     returnUrl = cancelUrl = `${process.env.LIMS_ORIGIN_PORTAL without trailing slash}/app/payments/${id}/done` (LIMS_ORIGIN_PORTAL is the portal origin variable of the reporting task, set here); success -> status 'ready', intent_id,
//     amount_paisa (= amount.amountPaisa), action_json {kind, url} (redirect -> url; form_post -> url = launchUrl; the eSewa `fields` are NOT stored), expires_at; any payments.* error -> status 'failed', failure_code = the code verbatim,
//     the task RESOLVES (terminal, no retry); any other error rejects (retry) and leaves the row queued.
//   refresh_payment_request (ready only): PaymentProviderPort.getIntent(ctx, {intentId}) as the system actor; settled -> 'completed'; failed | expired -> 'expired'; held_for_review -> stays 'ready' with review = true;
//     created / initiated / pending -> unchanged; common.not_found -> 'expired'; any other error rejects (retry), row unchanged. action_json = NULL whenever the row leaves 'ready'. Nothing the client sent (payload extras, return-URL outcome) counts.
//   expire_payment_requests (cron, per tenant, payload {tenant_id}): ready rows with expires_at older than 30 min ago -> 'expired', action_json NULL; nothing else changes.
// NOT pinned (spec silent): the exact boundary at expires_at + 30 min; refunded / partially_refunded intent states; a form_post answer without launchUrl; qr actions (Fonepay, blocked B8); common.not_found from createIntent;
//   what happens on the LAST failed attempt of a non-payments error; metrics labels; the payment_completed notification (T-N1).
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import { createFakePaymentProviderPort } from '../../../../../../packages/fakes/src/PaymentProviderPort.fake';
import { ID, SYSTEM_ACTOR, T0, TENANT_A, TENANT_B, makeLinkWorld, type LinkWorld } from '../../../../../api/src/modules/engagement/__tests__/link.world.js';

type Row = Record<string, any>;
const CREATE = 'engagement.create_payment_intent', REFRESH = 'engagement.refresh_payment_request', EXPIRE = 'engagement.expire_payment_requests';
const PORTAL = 'https://portal.invalid';
const PHONE = '+99001000001', PAT = ID(0x700), ORD = ID(0x710), MIN = 60_000, T = Date.parse(T0);
const SECRET = 'SECRET-TOKEN-4f9c2a', FIELD = 'ESEWA-SIGNED-FIELD-9d1e';
const iso = (offsetMs: number) => new Date(T + offsetMs).toISOString();
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } return undefined; };
const handler = (id: string): ((p: any, c: any) => Promise<void>) => manifest.tasks![id]! as any;
const parsed = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
process.env['LIMS_ORIGIN_PORTAL'] = PORTAL;

interface Call { method: string; actor: string | undefined; input: Row }
/** Scripted PaymentProviderPort: records every call with the actor type; only createIntent / getIntent are expected from C16. */
function portSpy() {
  const calls: Call[] = [];
  const spy = {
    calls,
    createIntent: async (_c: any, _i: Row): Promise<any> => ({ intentId: ID(0xc01), gateway: 'khalti', amount: { amountPaisa: 225000, currency: 'NPR' }, action: { kind: 'redirect', url: `https://pay.invalid/khalti/${SECRET}` }, expiresAt: iso(15 * MIN), replayed: false }),
    getIntent: async (_c: any, _i: Row): Promise<any> => ({ intentId: ID(0xc01), orderId: ORD, gateway: 'khalti', status: 'initiated', amount: { amountPaisa: 225000, currency: 'NPR' }, refundedAmount: { amountPaisa: 0, currency: 'NPR' } }),
    verify: async () => { throw new Error('C16 must not call verify'); }, refund: async () => { throw new Error('C16 must not call refund'); }, cancelIntent: async () => { throw new Error('C16 must not call cancelIntent'); },
  };
  const wrap = (m: 'createIntent' | 'getIntent') => { const f = spy[m]; return async (c: any, i: Row) => { calls.push({ method: m, actor: c?.actor?.type, input: structuredClone(i) }); return f(c, i); }; };
  const port: any = new Proxy(spy, { get: (t: any, k) => (k === 'createIntent' || k === 'getIntent' ? wrap(k) : t[k]), set: (t: any, k, v) => { t[k] = v; return true; } });
  return port as typeof spy;
}

interface Fx {
  w: LinkWorld; port: ReturnType<typeof portSpy>; rows: () => Row[]; row: (id: string) => Row;
  request: (o?: Row) => Row; run: (id: string, payload?: any, over?: Row) => Promise<void>; call: (task: string, payload: any, over?: Row) => Promise<void>;
}
function setup(): Fx {
  const w = makeLinkWorld(); const acct = w.seedAccount(PHONE); w.seedLink(acct['id'], PAT);
  const port = portSpy(); let n = 0xd00;
  const request = (over: Row = {}): Row => {
    const status = over['status'] ?? 'queued'; const live = ['ready', 'completed'].includes(status);
    const r: Row = { id: ID(++n), tenant_id: w.tenantId, account_id: acct['id'], order_id: ORD, patient_id: PAT, gateway: 'khalti', status, review: false, intent_id: live ? ID(0xc01) : null, amount_paisa: live ? 225000 : null,
      action_json: status === 'ready' ? { kind: 'redirect', url: `https://pay.invalid/khalti/${SECRET}` } : null, failure_code: status === 'failed' ? 'payments.nothing_due' : null, idempotency_key: `k-${n}`, expires_at: status === 'ready' ? iso(15 * MIN) : null,
      version: 1, is_active: true, created_at: T0, created_by: acct['user_id'], updated_at: T0, updated_by: acct['user_id'], ...over };
    w.t['payment_requests']!.push(r); return r;
  };
  const call = (task: string, payload: any, over: Row = {}) => w.inTx(() => handler(task)(payload, w.jobCtx({ ports: { ...w.ports, PaymentProviderPort: port }, ...over })));
  return { w, port, rows: () => w.t['payment_requests']!, row: (id) => w.t['payment_requests']!.find((r) => r['id'] === id)!, request, call, run: (id, payload = { tenant_id: w.tenantId, payment_request_id: id }, over = {}) => call(CREATE, payload, over) };
}
const unchanged = (f: Fx, before: Row[]) => expect(f.rows()).toEqual(before);

describe('manifest (TRD §8.1, §8.2)', () => {
  it('the two tasks are implemented (no longer the fail-closed stubs), max_attempts 3, and the manifest still validates', async () => {
    expect(() => validateManifests([manifest])).not.toThrow();
    expect(manifest.maxAttempts?.[CREATE]).toBe(3); expect(manifest.maxAttempts?.[REFRESH]).toBe(3);
    for (const task of [CREATE, REFRESH]) { const f = setup(); const r = f.request({ status: task === CREATE ? 'queued' : 'ready' }); const e = await rejection(f.call(task, { tenant_id: f.w.tenantId, payment_request_id: r['id'] })); expect(String(e?.message ?? ''), task).not.toMatch(/not implemented/); }
  });
  it('expire_payment_requests is a task and a per_tenant cron row every 10 minutes (UTC fields: */10 * * * *)', () => {
    expect(manifest.tasks).toHaveProperty([EXPIRE]);
    const row = manifest.crontab?.find((c) => c.identifier === EXPIRE); expect(row, 'crontab row').toBeDefined();
    expect(row).toMatchObject({ schedule: '*/10 * * * *', tenantScope: 'per_tenant' });
  });
});

describe('create_payment_intent: the system actor creates the intent (US-EN-10.1; TRD §4.7 step 2)', () => {
  it('calls createIntent ONCE as the system actor with exactly {orderId, gateway, idempotencyKey: eng:<id>, returnUrl, cancelUrl} - no amount (REQ-SEC-046); returnUrl = cancelUrl = <PORTAL>/app/payments/<id>/done', async () => {
    const f = setup(); const r = f.request(); await f.run(r['id']);
    expect(f.port.calls).toHaveLength(1); const c = f.port.calls[0]!; expect(c.method).toBe('createIntent'); expect(c.actor).toBe('system');
    expect(Object.keys(c.input).sort()).toEqual(['cancelUrl', 'gateway', 'idempotencyKey', 'orderId', 'returnUrl']);
    expect(c.input).toEqual({ orderId: ORD, gateway: 'khalti', idempotencyKey: `eng:${r['id']}`, returnUrl: `${PORTAL}/app/payments/${r['id']}/done`, cancelUrl: `${PORTAL}/app/payments/${r['id']}/done` });
  });
  it('a trailing slash on the portal origin does not double the slash', async () => {
    const f = setup(); const r = f.request(); process.env['LIMS_ORIGIN_PORTAL'] = `${PORTAL}/`;
    try { await f.run(r['id']); } finally { process.env['LIMS_ORIGIN_PORTAL'] = PORTAL; }
    expect(f.port.calls[0]!.input['returnUrl']).toBe(`${PORTAL}/app/payments/${r['id']}/done`);
  });
  it('success (Khalti): the row becomes ready with intent_id, amount_paisa, the redirect action, expires_at; system actor stamped, version + 1', async () => {
    const f = setup(); const r = f.request(); await f.run(r['id']); const x = f.row(r['id']);
    expect(x).toMatchObject({ status: 'ready', intent_id: ID(0xc01), failure_code: null, review: false, updated_by: SYSTEM_ACTOR, version: 2 }); expect(Number(x['amount_paisa'])).toBe(225000);
    expect(parsed(x['action_json'])).toEqual({ kind: 'redirect', url: `https://pay.invalid/khalti/${SECRET}` }); expect(Date.parse(x['expires_at'])).toBe(Date.parse(iso(15 * MIN)));
  });
  it('success (eSewa form_post): only the launchUrl is stored as the action url; the signed form fields are NOT stored (the launch page carries them)', async () => {
    const f = setup(); const r = f.request({ gateway: 'esewa' });
    f.port.createIntent = async () => ({ intentId: ID(0xc02), gateway: 'esewa', amount: { amountPaisa: 225000, currency: 'NPR' }, action: { kind: 'form_post', url: 'https://esewa.invalid/epay/form', fields: { signature: FIELD, amount: '2250' }, launchUrl: `${PORTAL}/launch/${SECRET}` }, expiresAt: iso(15 * MIN), replayed: false });
    await f.run(r['id']); const x = f.row(r['id']);
    expect(x['status']).toBe('ready'); expect(parsed(x['action_json'])).toEqual({ kind: 'form_post', url: `${PORTAL}/launch/${SECRET}` }); expect(JSON.stringify(x)).not.toContain(FIELD); expect(JSON.stringify(x)).not.toContain('esewa.invalid/epay/form');
  });
  it('a replayed answer (replayed: true) is handled like a fresh one', async () => {
    const f = setup(); const r = f.request(); f.port.createIntent = async () => ({ intentId: ID(0xc01), gateway: 'khalti', amount: { amountPaisa: 225000, currency: 'NPR' }, action: { kind: 'redirect', url: `https://pay.invalid/khalti/${SECRET}` }, expiresAt: iso(15 * MIN), replayed: true });
    await f.run(r['id']); expect(f.row(r['id'])['status']).toBe('ready');
  });

  describe('US-EN-10.4: every C15 payments.* error -> failed with that failure_code; the task resolves (terminal, no retry)', () => {
    for (const code of ['payments.nothing_due', 'payments.intent_open_exists', 'payments.amount_not_supported', 'payments.gateway_not_available', 'payments.return_url_not_allowed', 'payments.credential_invalid', 'payments.intent_invalid_transition']) {
      it(code, async () => {
        const f = setup(); const r = f.request(); f.port.createIntent = async () => { throw Object.assign(new Error(`${code} (synthetic gateway detail ${SECRET})`), { code }); };
        await f.run(r['id']); const x = f.row(r['id']);
        expect(x).toMatchObject({ status: 'failed', failure_code: code, intent_id: null, updated_by: SYSTEM_ACTOR, version: 2 }); expect(x['action_json'] ?? null).toBeNull(); expect(x['amount_paisa'] ?? null).toBeNull();
        expect(f.port.calls).toHaveLength(1); expect(f.w.observed()).not.toContain(SECRET);
      });
    }
  });
  it('any other error (network / unexpected / not a payments.* code) rejects so the queue retries; the row stays queued; the error text is not echoed into logs', async () => {
    for (const err of [Object.assign(new Error(`boom ${SECRET}`), { code: 'common.dependency_unavailable' }), new Error(`plain ${SECRET}`), Object.assign(new Error('x'), { code: 'common.internal' })]) {
      const f = setup(); const r = f.request(); const before = structuredClone(f.rows()); f.port.createIntent = async () => { throw err; };
      const e = await rejection(f.run(r['id'])); expect(e, 'the task must reject so it is retried').toBeDefined(); expect(String(e.message)).not.toMatch(/not implemented/); expect(f.port.calls, 'the port was asked once').toHaveLength(1); unchanged(f, before); expect(f.w.observed()).not.toContain(SECRET);
    }
  });
  it('no-op unless the request is queued: ready / failed / expired / completed -> no port call, row unchanged (a retry or a double enqueue never creates a second intent)', async () => {
    for (const status of ['ready', 'failed', 'expired', 'completed']) { const f = setup(); const r = f.request({ status }); const before = structuredClone(f.rows()); await f.run(r['id']); expect(f.port.calls, status).toEqual([]); unchanged(f, before); }
  });
  it('running the task twice after success makes one createIntent call and leaves the first result', async () => {
    const f = setup(); const r = f.request(); await f.run(r['id']); const first = structuredClone(f.row(r['id'])); await f.run(r['id']); expect(f.port.calls).toHaveLength(1); expect(f.row(r['id'])).toEqual(first);
  });
  it('an unknown request id, another tenant\'s request and a bad payload never reach the port', async () => {
    const f = setup(); const foreign = f.request({ tenant_id: TENANT_B }); const mine = f.request(); const before = structuredClone(f.rows());
    await f.run(ID(0xfeed)); await f.run(foreign['id']);
    for (const payload of [{}, { payment_request_id: 'not-a-uuid' }, { payment_request_id: `${mine['id']}' OR 1=1 --` }, { tenant_id: TENANT_B, payment_request_id: mine['id'] }, null, { payment_request_id: [mine['id']] }]) await rejection(f.run(mine['id'], payload));
    expect(f.port.calls).toEqual([]); unchanged(f, before);
  });
  it('the action URL and the gateway error text never reach logs, audit rows or metric labels', async () => {
    const f = setup(); const r = f.request(); await f.run(r['id']); expect(f.w.observed()).not.toContain(SECRET);
  });
});

describe('refresh_payment_request: server-side truth, only the system actor asks the port (US-EN-10.3; TRD §4.7 step 3; REQ-SEC-059; 08 R8)', () => {
  const answer = (f: Fx, status: string) => { f.port.getIntent = async () => ({ intentId: ID(0xc01), orderId: ORD, gateway: 'khalti', status, amount: { amountPaisa: 225000, currency: 'NPR' }, refundedAmount: { amountPaisa: 0, currency: 'NPR' }, ...(status === 'settled' ? { settledAt: T0 } : {}) }); };
  const refresh = (f: Fx, id: string, payload: any = { tenant_id: f.w.tenantId, payment_request_id: id }) => f.call(REFRESH, payload);

  it('calls getIntent ONCE as the system actor with exactly {intentId} of the row; never verify / refund / cancelIntent', async () => {
    const f = setup(); const r = f.request({ status: 'ready' }); await refresh(f, r['id']);
    expect(f.port.calls).toEqual([{ method: 'getIntent', actor: 'system', input: { intentId: ID(0xc01) } }]);
  });
  it('"Paid" only on completed: settled -> completed, action scrubbed (action_json NULL), amount and intent kept, version + 1, system actor stamped', async () => {
    const f = setup(); const r = f.request({ status: 'ready' }); answer(f, 'settled'); await refresh(f, r['id']); const x = f.row(r['id']);
    expect(x).toMatchObject({ status: 'completed', intent_id: ID(0xc01), updated_by: SYSTEM_ACTOR, version: 2 }); expect(Number(x['amount_paisa'])).toBe(225000); expect(x['action_json'] ?? null).toBeNull();
  });
  it('every other intent state is NOT completed: created / initiated / pending leave the row ready (action kept); held_for_review -> ready + review true; failed / expired -> expired with the action scrubbed', async () => {
    for (const s of ['created', 'initiated', 'pending']) { const f = setup(); const r = f.request({ status: 'ready' }); answer(f, s); await refresh(f, r['id']); expect(f.row(r['id']), s).toMatchObject({ status: 'ready', review: false }); expect(parsed(f.row(r['id'])['action_json'])).toMatchObject({ kind: 'redirect' }); }
    { const f = setup(); const r = f.request({ status: 'ready' }); answer(f, 'held_for_review'); await refresh(f, r['id']); expect(f.row(r['id'])).toMatchObject({ status: 'ready', review: true }); }
    for (const s of ['failed', 'expired']) { const f = setup(); const r = f.request({ status: 'ready' }); answer(f, s); await refresh(f, r['id']); expect(f.row(r['id']), s).toMatchObject({ status: 'expired' }); expect(f.row(r['id'])['action_json'] ?? null).toBeNull(); }
    for (const s of ['created', 'initiated', 'pending', 'held_for_review', 'failed', 'expired']) { const f = setup(); const r = f.request({ status: 'ready' }); answer(f, s); await refresh(f, r['id']); expect(f.row(r['id'])['status'], s).not.toBe('completed'); }
  });
  it('getIntent common.not_found -> expired (action scrubbed); any other port error rejects (retry) and leaves the row exactly as it was', async () => {
    const f = setup(); const r = f.request({ status: 'ready' }); f.port.getIntent = async () => { throw Object.assign(new Error('nf'), { code: 'common.not_found' }); }; await refresh(f, r['id']);
    expect(f.row(r['id'])).toMatchObject({ status: 'expired' }); expect(f.row(r['id'])['action_json'] ?? null).toBeNull();
    for (const err of [Object.assign(new Error(`net ${SECRET}`), { code: 'common.dependency_unavailable' }), new Error('plain')]) {
      const g = setup(); const q = g.request({ status: 'ready' }); const before = structuredClone(g.rows()); g.port.getIntent = async () => { throw err; };
      expect(await rejection(refresh(g, q['id']))).toBeDefined(); expect(g.port.calls).toHaveLength(1); unchanged(g, before); expect(g.w.observed()).not.toContain(SECRET);
    }
  });
  it('REQ-SEC-059: nothing the client says counts - extra payload keys (outcome, status, intent_id, amount) are ignored; the port answer alone decides', async () => {
    const f = setup(); const r = f.request({ status: 'ready' }); answer(f, 'initiated');
    await refresh(f, r['id'], { tenant_id: f.w.tenantId, payment_request_id: r['id'], outcome: 'success', status: 'settled', intent_id: ID(0xbad), amount_paisa: 1 });
    expect(f.row(r['id'])).toMatchObject({ status: 'ready', intent_id: ID(0xc01) }); expect(f.port.calls).toEqual([{ method: 'getIntent', actor: 'system', input: { intentId: ID(0xc01) } }]);
  });
  it('no-op unless ready: queued / completed / failed / expired -> no port call, row unchanged; a second run after completed does not call the port again', async () => {
    for (const status of ['queued', 'completed', 'failed', 'expired']) { const f = setup(); const r = f.request({ status }); const before = structuredClone(f.rows()); await refresh(f, r['id']); expect(f.port.calls, status).toEqual([]); unchanged(f, before); }
    const f = setup(); const r = f.request({ status: 'ready' }); answer(f, 'settled'); await refresh(f, r['id']); await refresh(f, r['id']); expect(f.port.calls).toHaveLength(1);
  });
  it('an unknown id, another tenant\'s request and a bad payload never reach the port', async () => {
    const f = setup(); const foreign = f.request({ tenant_id: TENANT_B, status: 'ready' }); const mine = f.request({ status: 'ready' }); const before = structuredClone(f.rows());
    await refresh(f, ID(0xfeed)); await refresh(f, foreign['id']);
    for (const payload of [{}, { payment_request_id: 'x' }, { tenant_id: TENANT_B, payment_request_id: mine['id'] }, null]) await rejection(refresh(f, mine['id'], payload));
    expect(f.port.calls).toEqual([]); unchanged(f, before);
  });
});

describe('expire_payment_requests: ready rows past expires_at + 30 min -> expired, action scrubbed (TRD §8.2)', () => {
  const expire = (f: Fx, payload: any = { tenant_id: f.w.tenantId }) => f.call(EXPIRE, payload);
  it('past (31 min) -> expired with action_json NULL (review rows too); inside the grace (29 min) and queued / completed / failed / expired rows are untouched; the port is never called', async () => {
    const f = setup(); const old = f.request({ status: 'ready', expires_at: iso(-31 * MIN) }); const rev = f.request({ status: 'ready', review: true, expires_at: iso(-45 * MIN) }); const young = f.request({ status: 'ready', expires_at: iso(-29 * MIN) }); const fresh = f.request({ status: 'ready', expires_at: iso(10 * MIN) });
    const others = ['queued', 'completed', 'failed', 'expired'].map((status) => f.request({ status, expires_at: null })); const before = structuredClone(others.map((o) => f.row(o['id'])));
    await expire(f);
    for (const r of [old, rev]) { expect(f.row(r['id'])).toMatchObject({ status: 'expired', updated_by: SYSTEM_ACTOR, version: 2 }); expect(f.row(r['id'])['action_json'] ?? null).toBeNull(); }
    for (const r of [young, fresh]) { expect(f.row(r['id'])['status']).toBe('ready'); expect(parsed(f.row(r['id'])['action_json'])).toMatchObject({ kind: 'redirect' }); }
    expect(others.map((o) => f.row(o['id']))).toEqual(before); expect(f.port.calls).toEqual([]);
  });
  it('is idempotent and tenant-scoped: a second run changes nothing; another tenant\'s overdue row is not touched; a payload for a foreign tenant does nothing at all', async () => {
    const f = setup(); const mine = f.request({ status: 'ready', expires_at: iso(-31 * MIN) }); const foreign = f.request({ tenant_id: TENANT_B, status: 'ready', expires_at: iso(-31 * MIN) }); const foreignBefore = structuredClone(f.row(foreign['id']));
    await expire(f, { tenant_id: TENANT_B }); expect(f.row(mine['id'])['status']).toBe('ready'); expect(f.row(foreign['id'])).toEqual(foreignBefore);
    await expire(f); const once = structuredClone(f.rows()); await expire(f); expect(f.rows()).toEqual(once); expect(f.row(mine['id'])['status']).toBe('expired'); expect(f.row(foreign['id'])).toEqual(foreignBefore);
  });
});

describe('end to end with the C15 port fake: Paid only after the server says settled (done_when)', () => {
  it('create -> ready (action from the fake) -> the return URL alone changes nothing -> C15 verifies (settled) -> refresh -> completed', async () => {
    const f = setup(); const r = f.request();
    const fake: any = createFakePaymentProviderPort({ seed: 7, fixtures: { orders: [{ id: ORD, tenantId: TENANT_A, dueAmountPaisa: 225000, gatewayStatus: 'Completed' }], intents: [], returnUrlHosts: ['portal.invalid'], intentTtlSeconds: 900, graceSeconds: 600, khaltiMinAmountPaisa: 1000 } as any });
    const run = (task: string) => f.w.inTx(() => handler(task)({ tenant_id: f.w.tenantId, payment_request_id: r['id'] }, f.w.jobCtx({ ports: { ...f.w.ports, PaymentProviderPort: fake } })));
    await run(CREATE); const ready = f.row(r['id']); expect(ready['status']).toBe('ready'); expect(Number(ready['amount_paisa'])).toBe(225000); expect(parsed(ready['action_json'])).toMatchObject({ kind: 'redirect' }); expect(String(parsed(ready['action_json']).url)).toMatch(/^https:\/\//);
    await run(REFRESH); expect(f.row(r['id'])['status'], 'the gateway has not been verified yet: still ready, never completed').toBe('ready');
    await fake.verify(f.w.jobCtx(), { intentId: ready['intent_id'] }); // what C15's callback does
    await run(REFRESH); expect(f.row(r['id'])).toMatchObject({ status: 'completed' }); expect(f.row(r['id'])['action_json'] ?? null).toBeNull();
  });
  it('the fake answers a duplicate order with payments.intent_open_exists -> the request fails with that code (terminal)', async () => {
    const f = setup(); const first = f.request();
    const fake: any = createFakePaymentProviderPort({ seed: 7, fixtures: { orders: [{ id: ORD, tenantId: TENANT_A, dueAmountPaisa: 225000, gatewayStatus: 'Completed' }], intents: [], returnUrlHosts: ['portal.invalid'], intentTtlSeconds: 900, graceSeconds: 600, khaltiMinAmountPaisa: 1000 } as any });
    await fake.createIntent(f.w.jobCtx(), { orderId: ORD, gateway: 'khalti', idempotencyKey: 'other-key-1', returnUrl: `${PORTAL}/x`, cancelUrl: `${PORTAL}/x` }); // another open intent exists in C15
    await f.w.inTx(() => handler(CREATE)({ tenant_id: f.w.tenantId, payment_request_id: first['id'] }, f.w.jobCtx({ ports: { ...f.w.ports, PaymentProviderPort: fake } })));
    expect(f.row(first['id'])).toMatchObject({ status: 'failed', failure_code: 'payments.intent_open_exists' });
  });
});
