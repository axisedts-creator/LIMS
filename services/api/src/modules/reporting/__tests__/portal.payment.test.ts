// C6-T42 — portal dues payment, API side: PP1 createPortalPaymentRequest, PP2 getPortalPaymentRequest, P3 `dues` block, contract, probes, log scan.
// Spec: 02-TRD §6.6 PP1/PP2 (08 A11.1, CR-C15-010); 01-PRD AC-18.1..18.5; 07-SECURITY REQ-SEC-046/059 (amount never from the request; portal actors never call
// BillingPort / PaymentProviderPort); 05-SCHEMA §2.15; 02-TRD §14 row "Review fix pass" (n). Synthetic data only. Worker half: services/worker/.../portal_payment.tasks.test.ts.
// ASSUMED (repeated in .orchestra/notes/C6-T42-tests.md): manifest.handlers.createPortalPaymentRequest / getPortalPaymentRequest(req, ctx) exactly like P1-P6 (ctx from the real
//   portalSession resolver); req = { params:{portal_payment_request_id}, headers:{ 'idempotency-key' }, body:{ gateway } }; response { status, body: PortalPaymentRequest, headers? };
//   writes reporting.portal_payment_requests (status 'queued', expires_at = now + 90 d, created_by/updated_by = link id) and enqueues `reporting.create_portal_payment_intent`
//   {portal_payment_request_id} with job key `ppay:<id>` / `reporting.refresh_portal_payment_request` with job key `ppref:<id>` through app.enqueue_job (as P1);
//   single-table SQL in the dialect of the T20 fake (see portal.helpers.ts header); a unique-violation (23505) on the open-request index -> 409 common.version_conflict, detail `payment_in_progress`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });   // cold module load (jsdom pre-warm) can exceed the 5 s default, as in the other portal tests
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import { DUE, ORDER_A, REPORT_A, doneUrl, idem, makePayWorld, rejection } from './portal.payment.helpers.js';
import { idN, TENANT_A } from './portal.helpers.js';

const OPEN = ['queued', 'ready'];
const keysOf = (b: any) => Object.keys(b ?? {}).sort();
const SCHEMA_KEYS = ['action_url', 'amount_paisa', 'failure_code', 'gateway', 'id', 'intent_expires_at', 'review', 'status'];
const lower = (h: Record<string, string> | undefined) => Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

describe('contract (reporting.yaml)', () => {
  const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
  it('PP1: POST /portal/payment-requests, portal session, reporting.portal.view, Idempotency-Key required, body = {gateway} only (no amount field), 200 + 202', () => {
    const op = spec.paths['/v1/reporting/portal/payment-requests'].post;
    expect(op.operationId).toBe('createPortalPaymentRequest'); expect(op['x-permission']).toBe('reporting.portal.view'); expect(op['x-idempotency']).toBe('required');
    expect(op.security).toEqual([{ portalSession: [] }]);
    const body = op.requestBody.content['application/json'].schema;
    expect(body.additionalProperties).toBe(false); expect(Object.keys(body.properties)).toEqual(['gateway']); expect(body.required).toEqual(['gateway']); expect(body.properties.gateway.enum).toEqual(['esewa', 'khalti']);
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '202', '400', '401', '404', '409']));
    expect(op['x-error-codes']).toEqual(expect.arrayContaining(['common.validation_failed', 'common.not_found', 'common.version_conflict', 'reporting.report_cancelled', 'reporting.otp_required']));
  });
  it('PP2: GET /portal/payment-requests/{portal_payment_request_id}, session, reporting.portal.view, no Idempotency-Key, PortalPaymentRequest has no amount input and additionalProperties false', () => {
    const op = spec.paths['/v1/reporting/portal/payment-requests/{portal_payment_request_id}'].get;
    expect(op.operationId).toBe('getPortalPaymentRequest'); expect(op['x-permission']).toBe('reporting.portal.view'); expect(op['x-idempotency']).not.toBe('required');
    const s = spec.components.schemas.PortalPaymentRequest;
    expect(s.additionalProperties).toBe(false); expect(Object.keys(s.properties).sort()).toEqual(SCHEMA_KEYS); expect(s.required).toEqual(expect.arrayContaining(['id', 'status', 'gateway', 'review']));
    expect(s.properties.status.enum).toEqual(['queued', 'ready', 'completed', 'failed', 'expired']);
  });
  it('both operations have a registered handler (a 501 stub is caught by the behaviour tests below)', async () => {
    const m = (await import('../index.js')).manifest as any;
    expect(typeof m.handlers.createPortalPaymentRequest).toBe('function'); expect(typeof m.handlers.getPortalPaymentRequest).toBe('function');
  });
});

describe('PP1 createPortalPaymentRequest — AC-18.3', () => {
  it('patient-link session + configured gateway -> 202 queued, one row, one create job keyed ppay:<id>; the request path makes zero BillingPort / PaymentProviderPort calls', async () => {
    const p = makePayWorld(); const s = p.patient();
    const out = await p.pp1(s.cred, { gateway: 'esewa' });
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ status: 'queued', gateway: 'esewa', review: false }); expect(out.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(keysOf(out.body).every((k) => SCHEMA_KEYS.includes(k))).toBe(true);
    expect(out.body.action_url).toBeUndefined();
    const rows = p.reqs(); expect(rows).toHaveLength(1); const r = rows[0]!;
    expect(r).toMatchObject({ id: out.body.id, tenant_id: p.w.db.store['reports']![0]!['tenant_id'], link_id: s.linkId, report_id: REPORT_A, order_id: ORDER_A, gateway: 'esewa', status: 'queued', review: false });
    expect(r['intent_id']).toBeNull(); expect(r['amount_paisa']).toBeNull(); expect(r['action_json']).toBeNull();
    const ttl = Date.parse(r['expires_at']) - Date.parse(p.w.now()); expect(ttl).toBeGreaterThan(89 * 86400_000); expect(ttl).toBeLessThanOrEqual(90 * 86400_000);
    const jobs = p.jobs('reporting.create_portal_payment_intent'); expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ portal_payment_request_id: out.body.id }); expect(jobs[0]!.jobKey).toBe(`ppay:${out.body.id}`);
    expect(p.w.forbiddenCalls).toEqual([]); expect(p.providerCalls).toEqual([]); expect(p.balance.calls).toEqual([]);
  });
  it('khalti works the same; a dues-purpose link session may request too (08 A21.1)', async () => {
    const p = makePayWorld(); const s = p.patient({ purpose: 'dues' });
    const out = await p.pp1(s.cred, { gateway: 'khalti' }); expect(out.status).toBe(202); expect(out.body.gateway).toBe('khalti');
  });
  it('the amount is never taken from the request: a body with `amount` / `amount_paisa` / any extra field -> 400 common.validation_failed; no row, no job', async () => {
    const p = makePayWorld(); const s = p.patient();
    for (const body of [{ gateway: 'esewa', amount: 1 }, { gateway: 'esewa', amount_paisa: 1 }, { gateway: 'esewa', amount: { amountPaisa: 1, currency: 'NPR' } }, { gateway: 'esewa', order_id: ORDER_A }, { amount: 100 }, {}, { gateway: 5 }, null]) {
      const e = await rejection(p.pp1(s.cred, body as any)); expect(e.code, JSON.stringify(body)).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    }
    expect(p.reqs()).toHaveLength(0); expect(p.jobs('reporting.create_portal_payment_intent')).toHaveLength(0); expect(p.w.forbiddenCalls).toEqual([]);
  });
  it('a gateway that is not in settings.portal_payment_gateways (or not eSewa/Khalti; Fonepay is BLOCKED B8) -> 400 common.validation_failed on /gateway', async () => {
    const p = makePayWorld({ gateways: ['esewa'] }); const s = p.patient();
    for (const g of ['khalti', 'fonepay', 'ESEWA', '']) {
      const e = await rejection(p.pp1(s.cred, { gateway: g })); expect(e.code, g).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
      expect(JSON.stringify(e.errors ?? [])).toContain('/gateway');
    }
    expect(p.reqs()).toHaveLength(0);
  });
  it('AC-18.2: portal_payment_gateways = [] (default, always before C15 is live) -> 400 for every gateway; no row, no job', async () => {
    const p = makePayWorld({ gateways: [] }); const s = p.patient();
    for (const g of ['esewa', 'khalti']) expect((await rejection(p.pp1(s.cred, { gateway: g }))).code).toBe('common.validation_failed');
    expect(p.reqs()).toHaveLength(0); expect(p.jobs('reporting.create_portal_payment_intent')).toHaveLength(0);
  });
  it('AC-18.2: referrer / centre / partner link -> 404 common.not_found (no dues for them); no row, no job', async () => {
    const p = makePayWorld();
    for (const [kind, channel] of [['referrer', 'email'], ['centre', 'email'], ['partner', 'sms']] as const) {
      const s = p.patient({ recipient_kind: kind, channel });
      const e = await rejection(p.pp1(s.cred, { gateway: 'esewa' })); expect(e.code, kind).toBe('common.not_found'); expect(e.statusCode).toBe(404);
    }
    expect(p.reqs()).toHaveLength(0); expect(p.jobs('reporting.create_portal_payment_intent')).toHaveLength(0);
  });
  it('a cancelled report -> reporting.report_cancelled (409); no row', async () => {
    const p = makePayWorld(); const s = p.patient(); p.w.db.store['reports']!.find((r) => r['id'] === REPORT_A)!['state'] = 'cancelled';
    const e = await rejection(p.pp1(s.cred)); expect(e.code).toBe('reporting.report_cancelled'); expect(e.statusCode).toBe(409); expect(p.reqs()).toHaveLength(0);
  });
  it('link-stage credential (no OTP yet) -> 401 reporting.otp_required; unknown credential -> 404 reporting.link_invalid; nothing written', async () => {
    const p = makePayWorld(); const l = p.w.mkLink();
    const e = await rejection(p.pp1(l.cred)); expect(e.code).toBe('reporting.otp_required'); expect(e.statusCode).toBe(401);
    const e2 = await rejection(p.pp1('session.' + 'x'.repeat(43))); expect(e2.code).toMatch(/^(reporting\.link_invalid|reporting\.otp_required)$/);
    expect(p.reqs()).toHaveLength(0); expect(p.w.db.writes().filter((w) => /portal_payment_requests/.test(w.text))).toHaveLength(0);
  });
});

describe('PP1 — AC-18.4 open request handling', () => {
  it('a second request on the same link while one is open -> 200 with the open request (same id), no new row, no second job', async () => {
    const p = makePayWorld(); const s = p.patient();
    const first = await p.pp1(s.cred, { gateway: 'esewa' }, idem(1));
    const again = await p.pp1(s.cred, { gateway: 'khalti' }, idem(2));
    expect(again.status).toBe(200); expect(again.body.id).toBe(first.body.id); expect(again.body.gateway).toBe('esewa');
    expect(p.reqs()).toHaveLength(1); expect(p.jobs('reporting.create_portal_payment_intent')).toHaveLength(1);
  });
  it('a ready open request is returned with its action_url (this link only)', async () => {
    const p = makePayWorld(); const s = p.patient(); const ready = await p.seedReady(s.linkId, 'khalti');
    const out = await p.pp1(s.cred, { gateway: 'khalti' }, idem(3)); expect(out.status).toBe(200); expect(out.body).toMatchObject({ id: ready['id'], status: 'ready', review: false, amount_paisa: DUE });
    expect(out.body.action_url).toBe(ready['action_json'].url); expect(p.jobs('reporting.create_portal_payment_intent')).toHaveLength(0);
  });
  it('an open request created through ANOTHER link of the same order -> 409 common.version_conflict, detail payment_in_progress; no row, no job, the other request is not exposed', async () => {
    const p = makePayWorld(); const a = p.patient(); const b = p.patient();
    const first = await p.pp1(a.cred, { gateway: 'esewa' }, idem(1));
    const e = await rejection(p.pp1(b.cred, { gateway: 'esewa' }, idem(2)));
    expect(e.code).toBe('common.version_conflict'); expect(e.statusCode).toBe(409); expect(e.detail).toBe('payment_in_progress');
    expect(JSON.stringify([e.message, e.detail, e.errors])).not.toContain(first.body.id);
    expect(p.reqs()).toHaveLength(1); expect(p.jobs('reporting.create_portal_payment_intent')).toHaveLength(1);
  });
  it('a finished request (completed / failed / expired) does not block a new one on any link', async () => {
    const p = makePayWorld(); const a = p.patient(); const b = p.patient();
    p.seedRequest(a.linkId, { status: 'failed', failure_code: 'gateway_not_available' });
    p.seedRequest(a.linkId, { status: 'expired' });
    p.seedRequest(b.linkId, { status: 'completed', intent_id: idN(0x7001), amount_paisa: DUE, completed_at: p.w.now() });
    const out = await p.pp1(a.cred, { gateway: 'esewa' }, idem(4)); expect(out.status).toBe(202); expect(p.reqs((r) => OPEN.includes(r['status']))).toHaveLength(1);
  });
  it('the unique index is the arbiter: two simultaneous PP1 calls from two links of one order -> exactly one open request, one 202 and one 409', async () => {
    const p = makePayWorld(); const a = p.patient(); const b = p.patient();
    const res = await Promise.allSettled([p.pp1(a.cred, { gateway: 'esewa' }, idem(5)), p.pp1(b.cred, { gateway: 'khalti' }, idem(6))]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1); const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('common.version_conflict'); expect(p.reqs((r) => OPEN.includes(r['status']))).toHaveLength(1); expect(p.jobs('reporting.create_portal_payment_intent')).toHaveLength(1);
  });
});

describe('PP2 getPortalPaymentRequest — AC-18.5', () => {
  it('queued -> {id,status,gateway,review:false}; no action_url / amount; Cache-Control: no-store; reads only (no write), no job', async () => {
    const p = makePayWorld(); const s = p.patient(); const r = p.seedRequest(s.linkId);
    const before = p.w.db.writes().length; const out = await p.pp2(s.cred, r['id']);
    expect(out.status).toBe(200); expect(out.body).toMatchObject({ id: r['id'], status: 'queued', gateway: 'esewa', review: false });
    expect(out.body.action_url).toBeUndefined(); expect(keysOf(out.body).every((k) => SCHEMA_KEYS.includes(k))).toBe(true);
    expect(lower(out.headers)['cache-control']).toMatch(/no-store/);
    expect(p.w.db.writes().length).toBe(before); expect(p.jobs('reporting.refresh_portal_payment_request')).toHaveLength(0);
    expect(p.w.forbiddenCalls).toEqual([]);
  });
  it('ready (review false) -> action_url (the stored gateway URL), amount_paisa, intent_expires_at', async () => {
    const p = makePayWorld(); const s = p.patient(); const r = await p.seedReady(s.linkId, 'khalti');
    const out = await p.pp2(s.cred, r['id']);
    expect(out.body).toMatchObject({ status: 'ready', gateway: 'khalti', review: false, amount_paisa: DUE, action_url: r['action_json'].url }); expect(Date.parse(out.body.intent_expires_at)).toBe(Date.parse(r['intent_expires_at']));
    expect(lower(out.headers)['cache-control']).toMatch(/no-store/);
  });
  it('the action URL is returned only while ready and review = false: review, completed, failed, expired never carry it', async () => {
    const p = makePayWorld(); const s = p.patient();
    const review = await p.seedReady(s.linkId); Object.assign(review, { review: true, action_json: null });
    expect((await p.pp2(s.cred, review['id'])).body).toMatchObject({ status: 'ready', review: true }); expect((await p.pp2(s.cred, review['id'])).body.action_url).toBeUndefined();
    for (const status of ['completed', 'failed', 'expired']) {
      Object.assign(review, { status, review: false, action_json: null, failure_code: status === 'failed' ? 'payment_failed' : null, completed_at: status === 'completed' ? p.w.now() : null });
      const out = await p.pp2(s.cred, review['id']); expect(out.body.status).toBe(status); expect(out.body.action_url, status).toBeUndefined();
      if (status === 'failed') expect(out.body.failure_code).toBe('payment_failed');
    }
  });
  it("another link's request -> 404 common.not_found (same order, same report): the id of a request is not enough", async () => {
    const p = makePayWorld(); const a = p.patient(); const b = p.patient(); const r = await p.seedReady(a.linkId);
    const e = await rejection(p.pp2(b.cred, r['id'])); expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
    expect(JSON.stringify(e)).not.toContain(r['action_json'].url);
    const e2 = await rejection(p.pp2(a.cred, idN(0x7fff))); expect(e2.code).toBe('common.not_found');                      // unknown id: identical answer
  });
  it('a dues-purpose session reads its own request; a link-stage credential -> 401 reporting.otp_required', async () => {
    const p = makePayWorld(); const s = p.patient({ purpose: 'dues' }); const r = p.seedRequest(s.linkId);
    expect((await p.pp2(s.cred, r['id'])).body.id).toBe(r['id']);
    const l = p.w.mkLink(); const e = await rejection(p.pp2(l.cred, r['id'])); expect(e.code).toBe('reporting.otp_required');
  });
  it('refresh enqueue: ready + last_checked_at >= 3 s old -> one `reporting.refresh_portal_payment_request` keyed ppref:<id>; < 3 s, queued, terminal -> none; PP2 itself never writes', async () => {
    const p = makePayWorld(); const s = p.patient(); const r = await p.seedReady(s.linkId); const seededCalls = p.providerCalls.length;   // ruling #3: seedReady itself calls createIntent
    await p.pp2(s.cred, r['id']); expect(p.jobs('reporting.refresh_portal_payment_request')).toHaveLength(0);          // checked just now
    p.w.advance(3_000); await p.pp2(s.cred, r['id']);
    const j = p.jobs('reporting.refresh_portal_payment_request'); expect(j).toHaveLength(1); expect(j[0]!.jobKey).toBe(`ppref:${r['id']}`); expect(j[0]!.payload).toMatchObject({ portal_payment_request_id: r['id'] });
    p.w.advance(10_000); await p.pp2(s.cred, r['id']); expect(p.jobs('reporting.refresh_portal_payment_request')).toHaveLength(1);   // same job key collapses
    const t = p.patient(); const q = p.seedRequest(t.linkId, { status: 'completed', intent_id: idN(0x7002), amount_paisa: DUE, completed_at: p.w.now() });
    const before = p.jobs('reporting.refresh_portal_payment_request').length; expect((await p.pp2(t.cred, q['id'])).body.status).toBe('completed'); expect(p.jobs('reporting.refresh_portal_payment_request')).toHaveLength(before);
    expect(p.w.db.writes().filter((x) => /portal_payment_requests/i.test(x.text) && x.verb !== 'insert')).toHaveLength(0);
    expect(p.w.forbiddenCalls).toEqual([]); expect(p.providerCalls).toHaveLength(seededCalls);
  });
});

describe('P3 getPortalReport — dues block (AC-18.1, AC-18.2)', () => {
  it('AC-18.1: patient link, balance hint 500, gateways [esewa, khalti] -> dues {balance_due_paisa: 50000, online_gateways: [esewa, khalti]}; no open_request yet', async () => {
    const p = makePayWorld(); const s = p.patient(); const out = await p.w.call.p3(s.cred);
    expect(out.body.dues).toMatchObject({ balance_due_paisa: DUE, online_gateways: ['esewa', 'khalti'] }); expect(out.body.dues.open_request).toBeUndefined();
    expect(p.w.forbiddenCalls).toEqual([]);
  });
  it('AC-18.2: gateways [] -> amount only (online_gateways empty); referrer link -> no dues at all', async () => {
    const p = makePayWorld({ gateways: [] }); const s = p.patient();
    expect((await p.w.call.p3(s.cred)).body.dues).toMatchObject({ balance_due_paisa: DUE, online_gateways: [] });
    const ref = p.patient({ recipient_kind: 'referrer', channel: 'email' }); expect((await p.w.call.p3(ref.cred)).body.dues).toBeUndefined();
  });
  it('balance 0 or unknown -> no dues block; an open request of this link -> dues.open_request {id, status}', async () => {
    const p = makePayWorld({ balanceHint: 0 }); const s = p.patient(); expect((await p.w.call.p3(s.cred)).body.dues).toBeUndefined();
    p.hint(null); expect((await p.w.call.p3(s.cred)).body.dues).toBeUndefined();
    p.hint(DUE); const r = p.seedRequest(s.linkId); expect((await p.w.call.p3(s.cred)).body.dues.open_request).toEqual({ id: r['id'], status: 'queued' });
    const other = p.patient(); expect((await p.w.call.p3(other.cred)).body.dues.open_request).toBeUndefined();               // another link's request is not shown
  });
});

describe('probes: portal request paths stay payment-free (REQ-SEC-046/059)', () => {
  it('PP1, PP2 and P3 together: zero calls on BillingPort / PaymentProviderPort (the world throws and records any)', async () => {
    const p = makePayWorld(); const s = p.patient(); const first = await p.pp1(s.cred); await p.pp2(s.cred, first.body.id); await p.w.call.p3(s.cred);
    p.w.advance(5_000); await p.pp2(s.cred, first.body.id);
    expect(p.w.forbiddenCalls).toEqual([]); expect(p.providerCalls).toEqual([]); expect(p.balance.calls).toEqual([]);
  });
  it('static: no portal request-path source (service / handlers / repository of the portal, PP1/PP2) references BillingPort or PaymentProviderPort or their methods', () => {
    const root = join(REPO_ROOT, 'services/api/src/modules/reporting');
    const files = ['service', 'handlers', 'repository'].flatMap((d) => readdirSync(join(root, d)).filter((f) => /portal|payment/i.test(f) && f.endsWith('.ts')).map((f) => join(root, d, f)));
    expect(files.length).toBeGreaterThan(0);
    const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');   // comments may mention the ports; code may not use them
    for (const f of files) expect(code(f), f).not.toMatch(/BillingPort|PaymentProviderPort|\.getOrderBalance|\.createIntent|\.getIntent|\.recordGatewayPayment/);
  });
  it('the portal never writes ledger data and never UPDATEs a payment request (only the worker does): PP1 statements touch portal_payment_requests with INSERT / SELECT only', async () => {
    const p = makePayWorld(); const s = p.patient(); const first = await p.pp1(s.cred); await p.pp2(s.cred, first.body.id); await p.pp1(s.cred, { gateway: 'esewa' }, idem(9));
    const own = p.w.db.stmts.filter((x) => /portal_payment_requests/i.test(x.text)); expect(own.length).toBeGreaterThan(0);
    for (const x of own) expect(['insert', 'select']).toContain(x.verb);
    expect(p.w.db.stmts.some((x) => /ledger|billing\./i.test(x.text))).toBe(false);
  });
  it('tenant scoping: every statement on portal_payment_requests is parameterised with the tenant and carries no inlined id / token', async () => {
    const p = makePayWorld(); const s = p.patient(); const first = await p.pp1(s.cred); await p.pp2(s.cred, first.body.id);
    for (const x of p.w.db.stmts.filter((y) => /portal_payment_requests/i.test(y.text))) {
      if (x.verb === 'insert') {   // ruling #4: an INSERT has no predicate; the tenant_id column must be bound to a parameter whose value is TENANT_A
        const cols = /\(([^)]*)\)\s*values\s*\(([^)]*)\)/i.exec(x.text); expect(cols, x.text).toBeTruthy();
        const i = cols![1]!.split(',').map((c) => c.trim()).indexOf('tenant_id'); expect(i, x.text).toBeGreaterThanOrEqual(0);
        const ph = /^\$(\d+)$/.exec(cols![2]!.split(',')[i]!.trim()); expect(ph, x.text).toBeTruthy(); expect(x.values[Number(ph![1]) - 1]).toBe(TENANT_A);
      } else expect(x.text, x.text).toMatch(/tenant_id\s*=\s*\$\d+/);
      expect(x.text).not.toContain(first.body.id); expect(x.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
  });
});

describe('log scan: no gateway URL, token or amount-bearing request body in logs / audit / job payloads (AC-18.5, REQ-SEC-059)', () => {
  it('a planted action URL is returned by PP2 but appears in no log line, audit row or job payload; the access log has no payment row', async () => {
    const p = makePayWorld(); const s = p.patient(); const r = await p.seedReady(s.linkId, 'khalti');
    const PLANT = 'https://planted-gateway.invalid/pay/SECRET-PLANT-0001'; r['action_json'] = { url: PLANT };
    p.w.advance(5_000); const out = await p.pp2(s.cred, r['id']); expect(out.body.action_url).toBe(PLANT);
    const first = await p.pp1(p.patient().cred).catch((e) => e);                                                                     // 409 for the other link: error path logged too
    const scan = JSON.stringify([p.w.logs, p.w.audit, p.w.db.jobs.map((j) => [j.identifier, j.payload, j.jobKey]), first?.message, first?.detail]);
    expect(scan).not.toContain('planted-gateway'); expect(scan).not.toContain('SECRET-PLANT'); expect(scan).not.toContain(s.session.token); expect(scan).not.toContain(s.link.token);
    expect(p.w.audit.filter((e) => /payment/i.test(JSON.stringify(e)))).toHaveLength(0);
  });
  it('done-page URL shape is the fixed route portal.payment_done: /r/payments/<id>/done under LIMS_ORIGIN_PORTAL', () => {
    const routes: any = loadSpec(join(REPO_ROOT, 'contracts/routes.yaml')); const row = (routes.routes ?? routes).find((x: any) => x.id === 'portal.payment_done');
    expect(row.path).toBe('/r/payments/{portal_payment_request_id}/done'); expect(row.origin).toBe('portal'); expect(doneUrl('abc')).toBe('https://portal.lims.invalid/r/payments/abc/done');
  });
});
