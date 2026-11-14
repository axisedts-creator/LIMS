// C16.T-PAY1 (API half) — E41 createPaymentRequest + E42 getPaymentRequest (patient).
// (06-PLAN row T-PAY1; 02-TRD §4.7 steps 1 / 3 / 4, §5 E41/E42, §8.1 job keys pay:<id> / payref:<id>; 03-APP-FLOW §4.2; 05-SCHEMA payment_requests; 01-PRD US-EN-10.1 / 10.2 / 10.3 / 10.5 / 10.6;
//  07-SECURITY REQ-SEC-046 (no amount from the client), REQ-SEC-059 (paid only from server state), REQ-SEC-024, probe P-L1 (account A2 vs X's order -> 404); 08 R8 (patient actors never call PaymentProviderPort / BillingPort).)
// done_when: "Paid only on completed". tests (plan): every C15 error -> failed code (worker half: engagement.payment.tasks.test.ts); action scrubbed after ready; amount field rejected by schema.
// Fails now: handlers/index.ts maps createPaymentRequest / getPaymentRequest to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec fixes behaviour, not names; same convention as orders.handlers.test.ts):
//   handlers.createPaymentRequest({params:{order_id}, query:{}, headers:{'idempotency-key', app headers}, body:{gateway}}, ctx) -> {status:202|200, body:PaymentRequest, headers:{cache-control:'no-store'}}
//   handlers.getPaymentRequest({params:{payment_request_id}, query:{}, headers}, ctx)                                          -> {status:200, body:PaymentRequest, headers:{cache-control:'no-store'}}
//   ctx = world.patientCtx(account). IdentityPort.assertRole(ctx, {permission:'engagement.payment.create'}) runs BEFORE any query; a non-patient actor -> auth.forbidden before any query.
//   E41 reads engagement.patient_orders + the caller's ACTIVE account_patient_links (the world's RLS does NOT narrow patient_orders; the service filters by the caller's links and visible_from, REQ-SEC-024), settings.app_gateways
//   and settings.app_enabled, inserts engagement.payment_requests (account_id = the caller's account, patient_id = the projection's patient, idempotency_key = the Idempotency-Key header, status 'queued', created_by = the actor)
//   and enqueues `engagement.create_payment_intent` {payment_request_id} with job_key `pay:<id>` via SELECT app.enqueue_job($1, $2::jsonb, $3).
//   E42 reads payment_requests ONLY (never a port); when status = 'ready' and updated_at is >= 3 s old [03-APP-FLOW §4.2 "last checked": the table has no other column] it enqueues `engagement.refresh_payment_request`
//   {payment_request_id} with job_key `payref:<id>`. The stored action_json is {kind, url} already (TRD §4.7 step 2 stores redirect.url or form_post.launchUrl as `url`) and is returned verbatim only while ready.
//   The test ports PaymentProviderPort / BillingPort are spies that throw: any call from the API fails the test (08 R8).
// NOT pinned (spec silent): behaviour for an order that is not payment_due at E41 time (C15 answers payments.nothing_due in the task -> failed); the cursor of nothing; 426 app-version guard; the core Idempotency-Key replay / missing-key
//   400 (core pipeline); the exact `review` text (app).
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ID, T0, makeLinkWorld, type LinkWorld } from '../../__tests__/link.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const bodySchemaErrors = (op: string, body: unknown): string[] => { const v = ajv.compile({ ...opOf(op).requestBody.content['application/json'].schema, components: spec.components }); return v(body) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };

const PHONE_A = '+99001000001', PHONE_B = '+99001000002';
const X = ID(0x800), Y = ID(0x801), CENTRE = ID(0x810), BRANCH = ID(0x811);
const DAY = 86_400_000, T = Date.parse(T0);
const iso = (offsetMs: number) => new Date(T + offsetMs).toISOString();
const HDR = { 'x-lims-app-version': '1.0.0', 'x-lims-app-platform': 'android' };
const PERM = 'engagement.payment.create';
const SECRET = 'SECRET-TOKEN-4f9c2a';
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected a rejection'); };
const hdr = (res: any, name: string): unknown => { const k = Object.keys(res?.headers ?? {}).find((h) => h.toLowerCase() === name.toLowerCase()); return k ? res.headers[k] : undefined; };

let seq = 0xa00;
interface Fx {
  w: LinkWorld; a1: Record<string, any>; a2: Record<string, any>; linkX: Record<string, any>; portCalls: string[];
  order: (o?: Record<string, any>) => Record<string, any>;
  request: (o?: Record<string, any>) => Record<string, any>;
  create: (orderId: string, body?: unknown, who?: Record<string, any>, headers?: Record<string, any>) => Promise<any>;
  get: (id: string, who?: Record<string, any>) => Promise<any>;
  rows: () => Record<string, any>[]; jobs: (id?: string) => Record<string, any>[];
}
/** Tenant A: account A1 linked to X (active, visible_from NULL), account A2 linked to Y; both gateways offered. */
function setup(o: { gateways?: string[] } = {}): Fx {
  const w = makeLinkWorld();
  w.setSetting('app_gateways', o.gateways ?? ['esewa', 'khalti']);
  const a1 = w.seedAccount(PHONE_A), a2 = w.seedAccount(PHONE_B);
  const linkX = w.seedLink(a1['id'], X), linkY = w.seedLink(a2['id'], Y); void linkY;
  const portCalls: string[] = [];
  for (const port of ['PaymentProviderPort', 'BillingPort']) w.ports[port] = new Proxy({}, { get: (_t, m) => async () => { portCalls.push(`${port}.${String(m)}`); throw new Error(`the patient context must never call ${port} (08 R8)`); } });
  const order = (over: Record<string, any> = {}) => {
    const r: Record<string, any> = { tenant_id: w.tenantId, order_id: ID(++seq), patient_id: X, centre_id: CENTRE, branch_id: BRANCH, source: 'front_desk', booking_id: null, order_status: 'registered', registered_at: iso(-DAY), visible_at: iso(-DAY),
      stage: 'registered', payment_due: true, invoiced_paisa: 225000, paid_paisa: 0, balance_due_paisa: 225000, balance_version: 1, release_basis: 'due_outstanding', status_version: 1, synced_at: w.now(), created_by: ID(0x7aa), updated_by: ID(0x7aa), created_at: w.now(), updated_at: w.now(), ...over };
    w.t['patient_orders']!.push(r); return r;
  };
  /** A payment_requests row as the DB holds it (05-SCHEMA); `ready` rows get intent, amount and an action; other statuses carry no action (CHECK payment_requests__action__ck). */
  const request = (over: Record<string, any> = {}) => {
    const status = over['status'] ?? 'queued';
    const r: Record<string, any> = { id: ID(++seq), tenant_id: w.tenantId, account_id: a1['id'], order_id: ID(0xdead), patient_id: X, gateway: 'khalti', status, review: false,
      intent_id: ['ready', 'completed'].includes(status) ? ID(++seq) : null, amount_paisa: ['ready', 'completed'].includes(status) ? 225000 : null,
      action_json: status === 'ready' ? { kind: 'redirect', url: `https://pay.invalid/khalti/${SECRET}` } : null, failure_code: status === 'failed' ? 'payments.nothing_due' : null,
      idempotency_key: `k-${seq}`, expires_at: status === 'ready' ? iso(15 * 60_000) : null, version: 1, is_active: true, created_at: w.now(), created_by: a1['user_id'], updated_at: w.now(), updated_by: a1['user_id'], ...over };
    w.t['payment_requests']!.push(r); return r;
  };
  const create = (orderId: string, body: unknown = { gateway: 'khalti' }, who: Record<string, any> = a1, headers: Record<string, any> = {}) =>
    w.inTx(() => (handlers as any).createPaymentRequest({ params: { order_id: orderId }, query: {}, headers: { ...HDR, 'idempotency-key': 'k-pay1-0001', ...headers }, body }, w.patientCtx(who)));
  const get = (id: string, who: Record<string, any> = a1) => w.inTx(() => (handlers as any).getPaymentRequest({ params: { payment_request_id: id }, query: {}, headers: { ...HDR } }, w.patientCtx(who)));
  return { w, a1, a2, linkX, portCalls, order, request, create, get, rows: () => w.t['payment_requests']!, jobs: (id) => w.jobs(id) };
}
const CREATE_JOB = 'engagement.create_payment_intent', REFRESH_JOB = 'engagement.refresh_payment_request';

describe('contract sanity (the spec is the source of permission, idempotency and the amount-free body)', () => {
  it('E41: engagement.payment.create, Idempotency-Key required, general tier, 200 + 202 + 404 declared; E42: no idempotency', () => {
    expect(opOf('createPaymentRequest')).toMatchObject({ 'x-permission': PERM, 'x-idempotency': 'required', 'x-rate-limit-tier': 'general' });
    expect(Object.keys(opOf('createPaymentRequest').responses)).toEqual(expect.arrayContaining(['200', '202', '404']));
    expect(opOf('getPaymentRequest')).toMatchObject({ 'x-permission': PERM, 'x-idempotency': 'none', 'x-rate-limit-tier': 'general' });
    expect(opOf('getPaymentRequest')['x-error-codes']).toContain('common.not_found');
  });
  it('US-EN-10.6 / REQ-SEC-046: the E41 body schema declares only `gateway` (esewa | khalti) and rejects an amount, any other key and fonepay', () => {
    expect(bodySchemaErrors('createPaymentRequest', { gateway: 'khalti' })).toEqual([]);
    expect(bodySchemaErrors('createPaymentRequest', { gateway: 'esewa' })).toEqual([]);
    for (const bad of [{ gateway: 'khalti', amount: 1 }, { gateway: 'khalti', amount_paisa: 225000 }, { gateway: 'khalti', amount: { amount_paisa: 1, currency: 'NPR' } }, { gateway: 'khalti', return_url: 'https://evil.invalid' }, { gateway: 'khalti', patient_id: Y },
      { gateway: 'fonepay' }, { gateway: 'KHALTI' }, {}, { amount: 1 }]) expect(bodySchemaErrors('createPaymentRequest', bad), JSON.stringify(bad)).not.toEqual([]);
    expect(Object.keys(opOf('createPaymentRequest').requestBody.content['application/json'].schema.properties)).toEqual(['gateway']);
  });
  it('the PaymentRequest DTO exposes no intent id, account id, patient id, idempotency key or version', () => {
    expect(Object.keys(spec.components.schemas.PaymentRequest.properties).sort()).toEqual(['action', 'amount', 'expires_at', 'failure_code', 'gateway', 'id', 'order_id', 'review', 'status']);
  });
});

describe('guards: permission first, patient actors only', () => {
  for (const op of ['create', 'get'] as const) {
    it(`${op}: assertRole(${PERM}) runs before any query; without it auth.forbidden and no statement at all`, async () => {
      const f = setup(); const o = f.order(); const r = f.request({ order_id: o['order_id'] }); const call = () => (op === 'create' ? f.create(o['order_id']) : f.get(r['id']));
      await call(); const first = f.w.identity.calls[0]!; expect(first.permission).toBe(PERM); expect(first.at).toBe(0);
      const g = setup(); const o2 = g.order(); const r2 = g.request({ order_id: o2['order_id'] }); g.w.identity.grants = []; const before = g.w.stmts.length;
      const e = await rejection(op === 'create' ? g.create(o2['order_id']) : g.get(r2['id'])); expect(e.code).toBe('auth.forbidden'); expect(g.w.stmts.length).toBe(before);
    });
    it(`${op}: a non-patient actor (staff) is refused with auth.forbidden before any query`, async () => {
      const f = setup(); const o = f.order(); const r = f.request({ order_id: o['order_id'] }); const staff = f.w.patientCtx(f.a1, { actor: { type: 'user', id: ID(0x7aa) } });
      const req = op === 'create' ? { params: { order_id: o['order_id'] }, query: {}, headers: { ...HDR, 'idempotency-key': 'k-1' }, body: { gateway: 'khalti' } } : { params: { payment_request_id: r['id'] }, query: {}, headers: { ...HDR } };
      const e = await rejection(f.w.inTx(() => (handlers as any)[op === 'create' ? 'createPaymentRequest' : 'getPaymentRequest'](req, staff))); expect(e.code).toBe('auth.forbidden');
      expect(f.w.stmts).toHaveLength(0);
    });
  }
});

describe('E41 createPaymentRequest (US-EN-10.1)', () => {
  it('visible order, khalti: 202 + a queued PaymentRequest; ONE row for the caller\'s account and the projection\'s patient; create_payment_intent enqueued with job_key pay:<id>', async () => {
    const f = setup(); const o = f.order();
    const res = await f.create(o['order_id'], { gateway: 'khalti' });
    expect(res.status).toBe(202); expect(hdr(res, 'cache-control')).toBe('no-store');
    expect(schemaErrors('PaymentRequest', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ order_id: o['order_id'], gateway: 'khalti', status: 'queued', review: false });
    expect(res.body.action).toBeUndefined(); expect(res.body.amount).toBeUndefined(); expect(res.body.failure_code).toBeUndefined();
    const rows = f.rows(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: res.body.id, tenant_id: f.w.tenantId, account_id: f.a1['id'], patient_id: X, order_id: o['order_id'], gateway: 'khalti', status: 'queued', idempotency_key: 'k-pay1-0001', created_by: f.a1['user_id'] });
    expect(rows[0]!['action_json'] ?? null).toBeNull();
    const jobs = f.jobs(CREATE_JOB); expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ payload: { payment_request_id: res.body.id }, jobKey: `pay:${res.body.id}` });
  });
  it('eSewa is accepted too; the worker is the only caller of PaymentProviderPort: the API makes no port call at all (08 R8)', async () => {
    const f = setup(); const o = f.order(); const res = await f.create(o['order_id'], { gateway: 'esewa' });
    expect(res.status).toBe(202); expect(res.body.gateway).toBe('esewa'); expect(f.portCalls).toEqual([]);
  });
  it('the patient comes from the order projection, never from the client; no write touches another table than payment_requests (+ the job)', async () => {
    const f = setup(); const o = f.order(); await f.create(o['order_id']);
    const writes = f.w.writes().map((s) => s.text.replace(/\s+/g, ' ')).filter((t) => !/app\.enqueue_job/i.test(t));
    expect(writes).toHaveLength(1); expect(writes[0]).toMatch(/^insert into (engagement\.)?payment_requests/i);
  });

  it('an open (queued) request for the order -> 200 with THAT request: no new row, no new job (idempotent by order, TRD §4.7 step 1)', async () => {
    const f = setup(); const o = f.order(); const first = await f.create(o['order_id'], { gateway: 'khalti' });
    const again = await f.create(o['order_id'], { gateway: 'khalti' }, f.a1, { 'idempotency-key': 'k-pay1-0002' });
    expect(again.status).toBe(200); expect(again.body.id).toBe(first.body.id); expect(f.rows()).toHaveLength(1); expect(f.jobs(CREATE_JOB)).toHaveLength(1);
  });
  it('an open request in another gateway is returned as it is (the open one wins); a ready one is returned with its action', async () => {
    const f = setup(); const o = f.order(); const r = f.request({ order_id: o['order_id'], status: 'ready', gateway: 'esewa', action_json: { kind: 'form_post', url: `https://portal.invalid/launch/${SECRET}` } });
    const res = await f.create(o['order_id'], { gateway: 'khalti' }, f.a1, { 'idempotency-key': 'k-pay1-0003' });
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ id: r['id'], gateway: 'esewa', status: 'ready', action: { kind: 'form_post', url: `https://portal.invalid/launch/${SECRET}` } });
    expect(f.rows()).toHaveLength(1); expect(f.jobs(CREATE_JOB)).toEqual([]);
  });
  it('after a terminal request (failed / expired / completed) a new request is a new row: 202 + a new job', async () => {
    for (const status of ['failed', 'expired', 'completed']) {
      const f = setup(); const o = f.order(); const old = f.request({ order_id: o['order_id'], status });
      const res = await f.create(o['order_id'], { gateway: 'khalti' }, f.a1, { 'idempotency-key': `k-${status}` });
      expect(res.status, status).toBe(202); expect(res.body.id).not.toBe(old['id']); expect(f.rows()).toHaveLength(2); expect(f.jobs(CREATE_JOB)).toHaveLength(1);
    }
  });

  it('gateway not in settings.app_gateways -> 400 common.validation_failed, nothing written, nothing enqueued', async () => {
    for (const [gateways, gateway] of [[['khalti'], 'esewa'], [['esewa'], 'khalti'], [[], 'khalti']] as const) {
      const f = setup({ gateways: [...gateways] }); const o = f.order(); const e = await rejection(f.create(o['order_id'], { gateway }));
      expect(e.code).toBe('common.validation_failed'); expect(f.rows()).toEqual([]); expect(f.jobs()).toEqual([]);
    }
  });
  it('US-EN-10.6: an amount (or any unknown key / a foreign gateway) in the body -> 400 common.validation_failed; nothing written, nothing enqueued', async () => {
    for (const body of [{ gateway: 'khalti', amount: 1 }, { gateway: 'khalti', amount_paisa: 1 }, { gateway: 'khalti', amount: { amount_paisa: 1, currency: 'NPR' } }, { gateway: 'khalti', patient_id: Y }, { gateway: 'khalti', account_id: ID(1) },
      { gateway: 'fonepay' }, { gateway: ['khalti'] }, { gateway: null }, {}, null, 'khalti']) {
      const f = setup(); const o = f.order(); const e = await rejection(f.create(o['order_id'], body));
      expect(e.code, JSON.stringify(body)).toBe('common.validation_failed'); expect(f.rows()).toEqual([]); expect(f.jobs()).toEqual([]);
    }
  });
  it('tenant app_enabled = false -> 403 common.feature_disabled, nothing written', async () => {
    const f = setup(); const o = f.order(); f.w.setSetting('app_enabled', false); const e = await rejection(f.create(o['order_id']));
    expect(e.code).toBe('common.feature_disabled'); expect(f.rows()).toEqual([]); expect(f.jobs()).toEqual([]);
  });

  describe('US-EN-10.5 / P-L1: an order the caller cannot see -> 404 common.not_found, nothing written, nothing enqueued', () => {
    const none = (f: Fx) => { expect(f.rows()).toEqual([]); expect(f.jobs()).toEqual([]); expect(f.portCalls).toEqual([]); };
    it('account A2 (linked to Y) asks for the order of X', async () => {
      const f = setup(); const o = f.order(); const e = await rejection(f.create(o['order_id'], { gateway: 'khalti' }, f.a2)); expect(e.code).toBe('common.not_found'); none(f);
    });
    it('an unknown order id, and an order id of another tenant', async () => {
      const f = setup(); f.order(); const e = await rejection(f.create(ID(0xfeed))); expect(e.code).toBe('common.not_found'); none(f);
      const g = setup(); const foreign = g.order({ tenant_id: ID(0xb0b), order_id: ID(0xfeee) }); const e2 = await rejection(g.create(foreign['order_id'])); expect(e2.code).toBe('common.not_found'); none(g);
    });
    it('a suspended or revoked link hides the order; so does a link whose visible_from is later than the order (visible_at < visible_from)', async () => {
      for (const over of [{ status: 'suspended', suspend_reason: 'phone_mismatch', suspended_at: T0 }, { status: 'revoked', revoked_by_kind: 'patient', revoked_at: T0 }, { visible_from: iso(-DAY / 2) }]) {
        const f = setup(); const o = f.order(); Object.assign(f.linkX, over); const e = await rejection(f.create(o['order_id'])); expect(e.code, JSON.stringify(over)).toBe('common.not_found'); none(f);
      }
    });
    it('a malformed order id never reaches a statement with it: 404 or 400, nothing written', async () => {
      const f = setup(); f.order(); const e = await rejection(f.create("1'; DROP TABLE engagement.payment_requests; --")); expect(['common.not_found', 'common.validation_failed']).toContain(e.code); none(f);
    });
  });
});

describe('E42 getPaymentRequest (US-EN-10.2 / 10.3; TRD §4.7 steps 3-4)', () => {
  it('queued: the PaymentRequest without action / amount; completed: amount, NO action; failed: failure_code; review flag passed through', async () => {
    const f = setup(); const o = f.order();
    const q = f.request({ order_id: o['order_id'] }); const r = await f.get(q['id']);
    expect(r.status).toBe(200); expect(hdr(r, 'cache-control')).toBe('no-store'); expect(schemaErrors('PaymentRequest', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: q['id'], order_id: o['order_id'], gateway: 'khalti', status: 'queued', review: false }); expect(r.body.action).toBeUndefined(); expect(r.body.amount).toBeUndefined();
    const done = f.request({ status: 'completed', order_id: ID(0xe01) }); const d = await f.get(done['id']);
    expect(d.body).toMatchObject({ status: 'completed', amount: { amount_paisa: 225000, currency: 'NPR' } }); expect(d.body.action).toBeUndefined(); expect(schemaErrors('PaymentRequest', d.body)).toEqual([]);
    const bad = f.request({ status: 'failed', order_id: ID(0xe02) }); const b = await f.get(bad['id']);
    expect(b.body).toMatchObject({ status: 'failed', failure_code: 'payments.nothing_due' }); expect(b.body.action).toBeUndefined();
    const rev = f.request({ status: 'ready', review: true, order_id: ID(0xe03) }); const v = await f.get(rev['id']); expect(v.body).toMatchObject({ status: 'ready', review: true });
  });
  it('ready: action {kind, url} verbatim (redirect for Khalti, form_post launch url for eSewa), amount and expires_at; schema-valid', async () => {
    const f = setup(); const o = f.order(); const k = f.request({ order_id: o['order_id'], status: 'ready' }); const r = await f.get(k['id']);
    expect(r.body).toMatchObject({ status: 'ready', amount: { amount_paisa: 225000, currency: 'NPR' }, action: { kind: 'redirect', url: `https://pay.invalid/khalti/${SECRET}` }, expires_at: k['expires_at'] }); expect(schemaErrors('PaymentRequest', r.body)).toEqual([]);
    const e = f.request({ order_id: ID(0xe10), status: 'ready', gateway: 'esewa', action_json: { kind: 'form_post', url: `https://portal.invalid/launch/${SECRET}` } }); const s = await f.get(e['id']);
    expect(s.body.action).toEqual({ kind: 'form_post', url: `https://portal.invalid/launch/${SECRET}` }); expect(schemaErrors('PaymentRequest', s.body)).toEqual([]);
  });
  it('REQ-SEC-059 / 08 R8: E42 reads payment_requests only - no port call, whatever the status', async () => {
    const f = setup(); const o = f.order();
    for (const status of ['queued', 'ready', 'completed', 'failed', 'expired']) { const r = f.request({ status, order_id: ID(0xe20 + seq) }); void o; await f.get(r['id']); }
    expect(f.portCalls).toEqual([]);
    for (const s of f.w.stmts) expect(s.text, 'E42 touches only the engagement schema').not.toMatch(/\b(billing|frontdesk|payments|lab|core)\.\w+/i);
  });
  it('the action URL (it carries C15\'s callback token) is returned to the owner only and never ends up in logs, audit rows or metric labels (TRD §4.7 step 4)', async () => {
    const f = setup(); const o = f.order(); const k = f.request({ order_id: o['order_id'], status: 'ready' }); const r = await f.get(k['id']);
    expect(JSON.stringify(r.body)).toContain(SECRET); expect(f.w.observed()).not.toContain(SECRET);
    const c = setup(); const o2 = c.order(); const e = await c.create(o2['order_id']); void e; expect(c.w.observed()).not.toContain(SECRET);
  });

  it('A2 asks for the request of A1 -> 404 common.not_found (P-L1), identical to an unknown id; no job enqueued', async () => {
    const f = setup(); const o = f.order(); const k = f.request({ order_id: o['order_id'], status: 'ready', updated_at: iso(-60_000) });
    const e1 = await rejection(f.get(k['id'], f.a2)); const e2 = await rejection(f.get(ID(0xfade), f.a2));
    expect(e1.code).toBe('common.not_found'); expect({ code: e1.code, statusCode: e1.statusCode, detail: e1.detail }).toEqual({ code: e2.code, statusCode: e2.statusCode, detail: e2.detail }); expect(f.jobs()).toEqual([]);
  });
  it('a request of another tenant is not found', async () => {
    const f = setup(); const k = f.request({ tenant_id: ID(0xb0b), order_id: ID(0xe30) }); const e = await rejection(f.get(k['id'])); expect(e.code).toBe('common.not_found');
  });

  describe('refresh_payment_request is enqueued by E42 only for a ready request last checked >= 3 s ago (job_key payref:<id>)', () => {
    it('ready and updated 5 s ago -> one engagement.refresh_payment_request {payment_request_id}, job_key payref:<id>; a second E42 right after does not add a second job', async () => {
      const f = setup(); const o = f.order(); const k = f.request({ order_id: o['order_id'], status: 'ready', updated_at: iso(-5_000) });
      await f.get(k['id']); await f.get(k['id']);
      const jobs = f.jobs(REFRESH_JOB); expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ payload: { payment_request_id: k['id'] }, jobKey: `payref:${k['id']}` });
    });
    it('ready but checked 1 s ago -> no job yet', async () => {
      const f = setup(); const o = f.order(); const k = f.request({ order_id: o['order_id'], status: 'ready', updated_at: iso(-1_000) }); await f.get(k['id']); expect(f.jobs(REFRESH_JOB)).toEqual([]);
    });
    it('queued / completed / failed / expired -> never a refresh job', async () => {
      const f = setup();
      for (const status of ['queued', 'completed', 'failed', 'expired']) { const r = f.request({ status, order_id: ID(0xe40 + seq), updated_at: iso(-60_000) }); await f.get(r['id']); }
      expect(f.jobs(REFRESH_JOB)).toEqual([]);
    });
  });
});
