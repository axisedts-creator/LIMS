// C6-T42 worker side of the portal dues payment (08 A11.1; 02-TRD §6.6 PP1/PP2 steps 2-3, §9; 01-PRD AC-18.3, 18.5, 18.6, 18.7; 07-SECURITY REQ-SEC-046/059).
// Tasks: reporting.create_portal_payment_intent, reporting.refresh_portal_payment_request (maxAttempts 3), cron reporting.expire_portal_payment_requests (*/10, per_tenant, 5),
// purge of expired payment rows by reporting.purge_ephemeral. Ports: BillingPort spy + the real C15 PaymentProviderPort fake (+ throwing phase stub); both as the system actor.
// ASSUMED (also in .orchestra/notes/C6-T42-tests.md): tasks are TaskHandler(payload, ctx) registered in jobs/reporting/index.ts manifest.tasks; payload { tenant_id, portal_payment_request_id };
//   ctx = JobContext (+ ports, audit, tx) as in send_portal_otp; single-table SQL in the T20 fake dialect (api __tests__/portal.helpers.ts); expire / purge payload { tenant_id }.
import '../../../../../api/src/__tests__/setup-env.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });   // LD-91: jsdom cold load 25-60 s on shared machine

const P = () => import('../../../../../api/src/modules/reporting/__tests__/portal.payment.helpers.js');
const H = () => import('../../../../../api/src/modules/reporting/__tests__/portal.helpers.js');
// C6-T42 ruling #1: returnUrl = LIMS_ORIGIN_PORTAL + '/r/payments/<id>/done' (02-TRD:664, :845); the env comes from C1, so the test supplies it (as assemble_report.test.ts).
beforeEach(async () => { vi.stubEnv('LIMS_ORIGIN_PORTAL', (await H()).PORTAL_ORIGIN); });
afterEach(() => { vi.unstubAllEnvs(); });
const T = manifest.tasks as Record<string, (p: any, c: any) => Promise<void>>;
const CREATE = 'reporting.create_portal_payment_intent'; const REFRESH = 'reporting.refresh_portal_payment_request';
const EXPIRE = 'reporting.expire_portal_payment_requests'; const PURGE = 'reporting.purge_ephemeral';
const MIN = 60_000;
const stub = (code: string) => ({ async createIntent() { throw new LimsError(code as any); }, async getIntent() { throw new LimsError(code as any); } });   // C15 phase stub / any payments.* error
const setup = async (o: Parameters<Awaited<ReturnType<typeof P>>['makePayWorld']>[0] = {}) => { const m = await P(); const p = m.makePayWorld(o); return { m, p, s: p.patient() }; };
const queued = (p: any, s: any, over: Record<string, any> = {}) => p.seedRequest(s.linkId, over);
const iso = (p: any, ms: number) => new Date(Date.parse(p.w.now()) + ms).toISOString();

describe('manifest registration', () => {
  it('registers both tasks (maxAttempts 3), the expire cron (*/10 * * * *, per_tenant, 5) and purge_ephemeral; the manifest stays valid', () => {
    expect(typeof T[CREATE]).toBe('function'); expect(typeof T[REFRESH]).toBe('function'); expect(typeof T[EXPIRE]).toBe('function'); expect(typeof T[PURGE]).toBe('function');
    expect(manifest.maxAttempts?.[CREATE]).toBe(3); expect(manifest.maxAttempts?.[REFRESH]).toBe(3);
    expect(manifest.crontab).toEqual(expect.arrayContaining([expect.objectContaining({ identifier: EXPIRE, schedule: '*/10 * * * *', tenantScope: 'per_tenant', maxAttempts: 5 })]));
    expect(() => validateManifests([manifest])).not.toThrow();
  });
});

describe(`${CREATE} — AC-18.3, AC-18.7`, () => {
  it('queued -> getOrderBalance FIRST, then createIntent as the system actor with idempotencyKey rpt_<id> and return/cancel URL = <PORTAL>/r/payments/<id>/done; no amount is passed; row ready', async () => {
    const { m, p, s } = await setup(); const r = queued(p, s, { gateway: 'khalti' });
    await p.runTask(T[CREATE]!, r['id']);
    expect(p.balance.calls).toHaveLength(1); expect(p.balance.calls[0]).toMatchObject({ actor: 'system', orderId: m.ORDER_A });
    const ci = p.callsOf('createIntent'); expect(ci).toHaveLength(1);
    expect(ci[0]!.actor).toBe('system'); expect(ci[0]!.n).toBeGreaterThan(p.balance.calls[0]!.n);
    expect(ci[0]!.input).toEqual({ orderId: m.ORDER_A, gateway: 'khalti', idempotencyKey: `rpt_${r['id']}`, returnUrl: m.doneUrl(r['id']), cancelUrl: m.doneUrl(r['id']) });
    expect(JSON.stringify(ci[0]!.input)).not.toMatch(/amount/i);                                                  // REQ-SEC-046: C15 computes it
    expect(r).toMatchObject({ status: 'ready', review: false, amount_paisa: m.DUE, failure_code: null }); expect(r['intent_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(r['action_json']).toEqual({ url: expect.stringMatching(/^https:\/\/khalti\.sandbox\.invalid\/pay\//) }); expect(r['intent_expires_at']).toBeTruthy(); expect(r['last_checked_at']).toBeTruthy();
    expect(p.balance.ledger).toHaveLength(0);                                                                    // C6 writes no ledger data
  });
  it('the stored amount is what C15 charged (intent amount), not what the balance read said', async () => {
    const { m, p, s } = await setup(); p.balance.due = 40_000; const r = queued(p, s, { gateway: 'khalti' });
    await p.runTask(T[CREATE]!, r['id']); expect(r['status']).toBe('ready'); expect(r['amount_paisa']).toBe(m.DUE);
  });
  it('eSewa form_post -> action_json.url = launchUrl; a form_post WITHOUT launchUrl -> failed `unsupported_action`, nothing stored', async () => {
    const a = await setup(); const r = queued(a.p, a.s, { gateway: 'esewa' }); await a.p.runTask(T[CREATE]!, r['id']);
    expect(r['status']).toBe('ready'); expect(r['action_json']).toEqual({ url: expect.stringMatching(/^https:\/\/launch\.gateway\.invalid\/pay\//) });
    const b = await setup({ withLaunchUrl: false }); const r2 = queued(b.p, b.s, { gateway: 'esewa' }); await b.p.runTask(T[CREATE]!, r2['id']);
    expect(r2).toMatchObject({ status: 'failed', failure_code: 'unsupported_action', action_json: null });
  });
  it('AC-18.7: balance 0 (or less) -> failed `nothing_due` and createIntent is NOT called', async () => {
    for (const due of [0, -5]) {
      const { p, s } = await setup(); p.balance.due = due; const r = queued(p, s); await p.runTask(T[CREATE]!, r['id']);
      expect(r).toMatchObject({ status: 'failed', failure_code: 'nothing_due', intent_id: null, action_json: null }); expect(p.callsOf('createIntent')).toHaveLength(0); expect(p.balance.calls).toHaveLength(1);
    }
  });
  it('AC-18.7: the C15 phase stub (payments.gateway_not_available) -> failed `gateway_not_available`', async () => {
    const { p, s } = await setup(); const r = queued(p, s);
    await p.runTask(T[CREATE]!, r['id'], { ports: { ...p.workerPorts(), PaymentProviderPort: stub('payments.gateway_not_available') } });
    expect(r).toMatchObject({ status: 'failed', failure_code: 'gateway_not_available', action_json: null, intent_id: null });
  });
  it('payments.* errors end the request failed with the code suffix; the task does not throw (terminal, no retry)', async () => {
    for (const code of ['intent_open_exists', 'nothing_due', 'amount_not_supported', 'return_url_not_allowed', 'gateway_not_available']) {
      const { p, s } = await setup(); const r = queued(p, s);
      await p.runTask(T[CREATE]!, r['id'], { ports: { ...p.workerPorts(), PaymentProviderPort: stub(`payments.${code}`) } });
      expect(r, code).toMatchObject({ status: 'failed', failure_code: code });
    }
  });
  it('any other error (network, internal) THROWS for the queue retry and leaves the row queued', async () => {
    const { p, s } = await setup(); const r = queued(p, s);
    await expect(p.runTask(T[CREATE]!, r['id'], { ports: { ...p.workerPorts(), PaymentProviderPort: { async createIntent() { throw new Error('ECONNRESET'); } } } })).rejects.toThrow();
    expect(r['status']).toBe('queued');
    p.balance.failNext = new LimsError('common.internal' as any); await expect(p.runTask(T[CREATE]!, r['id'])).rejects.toThrow(); expect(r['status']).toBe('queued');
  });
  it('idempotent: a retry after a lost run reuses the intent (same rpt_<id> key -> replay, one intent); a request that is no longer queued is a no-op with no port call', async () => {
    const { m, p, s } = await setup(); const r = queued(p, s, { gateway: 'khalti' });
    const first = await p.provider.createIntent(p.providerCtx(), { orderId: m.ORDER_A, gateway: 'khalti', idempotencyKey: `rpt_${r['id']}`, returnUrl: m.doneUrl(r['id']), cancelUrl: m.doneUrl(r['id']) });  // the lost run
    await p.runTask(T[CREATE]!, r['id']); expect(r['status']).toBe('ready'); expect(r['intent_id']).toBe(first.intentId);
    const calls = p.providerCalls.length; const bal = p.balance.calls.length; await p.runTask(T[CREATE]!, r['id']);
    expect(p.providerCalls).toHaveLength(calls); expect(p.balance.calls).toHaveLength(bal);                       // already ready
    for (const status of ['completed', 'failed', 'expired']) { const x = queued(p, p.patient(), { status, failure_code: status === 'failed' ? 'payment_failed' : null, intent_id: status === 'failed' ? null : m.ORDER_A, amount_paisa: status === 'failed' ? null : 1, completed_at: status === 'completed' ? p.w.now() : null }); await p.runTask(T[CREATE]!, x['id']); expect(x['status']).toBe(status); }
    expect(p.providerCalls).toHaveLength(calls);
  });
  it('link revoked before the worker runs, unknown id, tenant mismatch, bad payload -> no balance read, no intent; never ready; no throw', async () => {
    const { p, s } = await setup(); const r = queued(p, s); s.link.row['revoked_at'] = p.w.now();
    await p.runTask(T[CREATE]!, r['id']); expect(r['status']).not.toBe('ready');
    const ok = queued(p, p.patient());
    await p.runTask(T[CREATE]!, (await H()).idN(0x7ffe)); await p.runTask(T[CREATE]!, 'not-a-uuid'); await p.w.runTask(T[CREATE]!, { tenant_id: (await H()).TENANT_B, portal_payment_request_id: ok['id'] }, { ports: p.workerPorts() });
    await p.w.runTask(T[CREATE]!, {}, { ports: p.workerPorts() });
    expect(ok['status']).toBe('queued'); expect(p.balance.calls).toHaveLength(0); expect(p.providerCalls).toHaveLength(0);
  });
  it('log scan: the gateway URL never reaches a log line, audit row or metric label (AC-18.5)', async () => {
    const { p, s } = await setup(); const a = queued(p, s, { gateway: 'khalti' }); const b = queued(p, p.patient(), { gateway: 'esewa' });
    const metrics: any[] = []; await p.runTask(T[CREATE]!, a['id'], { metrics: { inc: (...x: any[]) => metrics.push(x), set: (...x: any[]) => metrics.push(x), observe: (...x: any[]) => metrics.push(x) } }).catch(() => undefined);
    await p.runTask(T[CREATE]!, b['id']).catch(() => undefined);
    const scan = JSON.stringify([p.w.logs, p.w.audit, metrics, p.w.db.jobs.map((j) => j.payload)]);
    expect(scan).not.toMatch(/sandbox\.invalid|launch\.gateway|SYN-/);
  });
});

describe(`${REFRESH} — AC-18.6`, () => {
  const ready = async (o: Parameters<typeof setup>[0] = {}, gateway: 'esewa' | 'khalti' = 'esewa') => { const w = await setup(o); const r = await w.p.seedReady(w.s.linkId, gateway); w.p.w.advance(5_000); return { ...w, r }; };
  it('gateway still pending -> row unchanged except last_checked_at; getIntent as the system actor; no createIntent / verify / BillingPort call', async () => {
    const { p, r } = await ready(); const before = { ...r }; const t0 = p.w.now(); await p.runTask(T[REFRESH]!, r['id']);
    expect(r).toMatchObject({ status: 'ready', review: false, action_json: before['action_json'], amount_paisa: before['amount_paisa'] }); expect(Date.parse(r['last_checked_at'])).toBe(Date.parse(t0));
    expect(p.callsOf('getIntent')).toHaveLength(1); expect(p.callsOf('getIntent')[0]!.actor).toBe('system'); expect(p.callsOf('getIntent')[0]!.input).toMatchObject({ intentId: r['intent_id'] });
    expect(p.callsOf('verify')).toHaveLength(0); expect(p.balance.calls).toHaveLength(0);
  });
  it('AC-18.6: C15 settled -> completed, completed_at set, action_json NULL; the ledger row is C15\'s (exactly one, written in its settle) and the refresh writes none', async () => {
    const { p, r } = await ready({ gatewayStatus: 'COMPLETE' }); await p.runTask(T[REFRESH]!, r['id']); expect(r['status']).toBe('ready');   // C15 has not verified yet
    await p.verify(r['intent_id']); expect(p.balance.ledger).toHaveLength(1);
    await p.runTask(T[REFRESH]!, r['id']);
    expect(r).toMatchObject({ status: 'completed', action_json: null, review: false }); expect(r['completed_at']).toBeTruthy(); expect(p.balance.ledger).toHaveLength(1); expect(p.balance.calls).toHaveLength(0);
  });
  it('refunded / partially_refunded count as completed too', async () => {
    const { p, r } = await ready({ gatewayStatus: 'Completed' }, 'khalti'); await p.verify(r['intent_id']);
    await p.provider.refund(p.providerCtx(), { intentId: r['intent_id'], amount: { amountPaisa: 1000, currency: 'NPR' }, idempotencyKey: 'refund-0001-abcdefgh', approvalId: 'appr-1', reasonCode: 'other' });
    await p.runTask(T[REFRESH]!, r['id']); expect(r).toMatchObject({ status: 'completed', action_json: null });
  });
  it('failed at the gateway -> failed `payment_failed`; expired -> expired; both scrub action_json', async () => {
    const a = await ready({ gatewayStatus: 'CANCELED' }); await a.p.verify(a.r['intent_id']); await a.p.runTask(T[REFRESH]!, a.r['id']);
    expect(a.r).toMatchObject({ status: 'failed', failure_code: 'payment_failed', action_json: null });
    const b = await ready({ gatewayStatus: 'Expired' }, 'khalti'); await b.p.verify(b.r['intent_id']); await b.p.runTask(T[REFRESH]!, b.r['id']);
    expect(b.r).toMatchObject({ status: 'expired', action_json: null });
  });
  it('held_for_review -> stays ready with review = true and the action URL scrubbed (DB CHECK); the amount stays', async () => {
    const { p, r } = await ready({ gatewayStatus: 'AMBIGUOUS' }); await p.verify(r['intent_id']); await p.runTask(T[REFRESH]!, r['id']);
    expect(r).toMatchObject({ status: 'ready', review: true, action_json: null }); expect(r['amount_paisa']).toBeGreaterThan(0);
  });
  it('getIntent failure THROWS (retry) and leaves the row as it was; a request that is not ready is a no-op (no getIntent)', async () => {
    const { p, r } = await ready(); const url = r['action_json'].url;
    await expect(p.runTask(T[REFRESH]!, r['id'], { ports: { ...p.workerPorts(), PaymentProviderPort: { async getIntent() { throw new Error('ECONNRESET'); } } } })).rejects.toThrow();
    expect(r).toMatchObject({ status: 'ready', action_json: { url } });
    const done = p.seedRequest(p.patient().linkId, { status: 'failed', failure_code: 'nothing_due' }); const n = p.callsOf('getIntent').length; await p.runTask(T[REFRESH]!, done['id']); await p.runTask(T[REFRESH]!, 'nope'); expect(p.callsOf('getIntent')).toHaveLength(n);
  });
  it('terminal rows are immutable: a late "pending" answer cannot reopen a completed request', async () => {
    const { p, r } = await ready({ gatewayStatus: 'COMPLETE' }); await p.verify(r['intent_id']); await p.runTask(T[REFRESH]!, r['id']); const snap = JSON.stringify(r);
    await p.runTask(T[REFRESH]!, r['id']); expect(JSON.stringify(r)).toBe(snap);
  });
});

describe(`${EXPIRE}`, () => {
  it('ready with intent_expires_at + 30 min passed -> expired (also with review), action scrubbed; not yet -> unchanged; queued older than 15 min -> failed `timeout`; younger -> unchanged; terminal rows untouched', async () => {
    const { p } = await setup(); const h = await H(); const L = () => p.patient().linkId; let n = 0x7100;
    // one open request per order (partial unique index) -> every open row gets its own order; ready rows are seeded directly (no C15 intent needed: the cron makes no port call)
    const rdy = (over: Record<string, any>) => p.seedRequest(L(), { order_id: h.idN(++n), status: 'ready', intent_id: h.idN(++n), amount_paisa: 1000, action_json: { url: 'https://khalti.sandbox.invalid/pay/x' }, last_checked_at: p.w.now(), ...over });
    const old = rdy({ intent_expires_at: iso(p, -31 * MIN) });
    const oldReview = rdy({ intent_expires_at: iso(p, -40 * MIN), review: true, action_json: null });
    const fresh = rdy({ intent_expires_at: iso(p, -29 * MIN) });
    const q1 = p.seedRequest(L(), { order_id: h.idN(++n), created_at: iso(p, -16 * MIN) }); const q2 = p.seedRequest(L(), { order_id: h.idN(++n), created_at: iso(p, -14 * MIN) });
    const done = p.seedRequest(L(), { status: 'failed', failure_code: 'nothing_due', created_at: iso(p, -3600 * 1000) }); const snap = JSON.stringify(done);
    await p.w.runTask(T[EXPIRE]!, { tenant_id: (await H()).TENANT_A });
    expect(old).toMatchObject({ status: 'expired', action_json: null }); expect(oldReview).toMatchObject({ status: 'expired', action_json: null });
    expect(fresh['status']).toBe('ready'); expect(fresh['action_json']).not.toBeNull();
    expect(q1).toMatchObject({ status: 'failed', failure_code: 'timeout' }); expect(q2['status']).toBe('queued'); expect(JSON.stringify(done)).toBe(snap);
    expect(p.providerCalls).toHaveLength(0); expect(p.balance.calls).toHaveLength(0);                           // the cron only touches the table
  });
  it('is tenant-scoped (payload tenant only) and a bad payload is a logged no-op', async () => {
    const { p } = await setup(); const h = await H(); const other = p.seedRequest(p.patient().linkId, { tenant_id: h.TENANT_B, created_at: iso(p, -60 * MIN) });
    await p.w.runTask(T[EXPIRE]!, { tenant_id: h.TENANT_A }); expect(other['status']).toBe('queued');
    await p.w.runTask(T[EXPIRE]!, {}); expect(other['status']).toBe('queued');
  });
});

describe(`${PURGE} — portal_payment_requests`, () => {
  it('deletes rows whose expires_at has passed (any status), keeps the rest and other tenants; payload tenant only', async () => {
    const { p, s } = await setup(); const h = await H();
    const gone1 = p.seedRequest(s.linkId, { status: 'failed', failure_code: 'nothing_due', created_at: iso(p, -91 * 86400_000), expires_at: iso(p, -1 * 86400_000) });
    const gone2 = p.seedRequest(p.patient().linkId, { status: 'expired', created_at: iso(p, -91 * 86400_000), expires_at: iso(p, -MIN) });
    const keep = p.seedRequest(p.patient().linkId); const otherTenant = p.seedRequest(p.patient().linkId, { tenant_id: h.TENANT_B, status: 'expired', created_at: iso(p, -91 * 86400_000), expires_at: iso(p, -MIN) });
    await p.w.runTask(T[PURGE]!, { tenant_id: h.TENANT_A });
    const ids = p.reqs().map((r) => r['id']); expect(ids).not.toContain(gone1['id']); expect(ids).not.toContain(gone2['id']); expect(ids).toContain(keep['id']); expect(ids).toContain(otherTenant['id']);
    expect(p.providerCalls).toHaveLength(0);
  });
});

describe('end to end across API + worker (fake gateway): PP1 -> create -> PP2 -> settle at C15 -> refresh -> PP2', () => {
  it('AC-18.3, 18.5, 18.6: queued -> ready with Continue URL for this link only -> "checking" while pending -> completed after C15 settles; the URL disappears; one ledger row (C15)', async () => {
    const { m, p, s } = await setup({ gatewayStatus: 'Completed' });   // ruling #2: Khalti settles only on 'Completed' ('COMPLETE' is eSewa)
    const out = await p.pp1(s.cred, { gateway: 'khalti' }); const id = out.body.id; await p.runTask(T[CREATE]!, id);
    p.w.advance(4_000); const rdy = await p.pp2(s.cred, id); expect(rdy.body).toMatchObject({ status: 'ready', amount_paisa: m.DUE }); expect(rdy.body.action_url).toMatch(/^https:\/\/khalti\.sandbox\.invalid\//);
    expect((await p.pp2(p.patient().cred, id).catch((e) => e)).code).toBe('common.not_found');
    await p.runTask(T[REFRESH]!, id); expect((await p.pp2(s.cred, id)).body.status).toBe('ready');                      // gateway redirected back but C15 still pending: page shows "checking", outcome never trusted
    await p.verify(p.byId(id)['intent_id']); p.w.advance(4_000); await p.runTask(T[REFRESH]!, id);
    const done = await p.pp2(s.cred, id); expect(done.body.status).toBe('completed'); expect(done.body.action_url).toBeUndefined(); expect(p.balance.ledger).toHaveLength(1);
    expect(p.w.forbiddenCalls).toEqual([]);
  });
  it('AC-18.7: before C15 is live (phase stub) the request ends failed `gateway_not_available` and PP2 exposes no URL', async () => {
    const { p, s } = await setup(); const out = await p.pp1(s.cred, { gateway: 'esewa' });
    await p.runTask(T[CREATE]!, out.body.id, { ports: { ...p.workerPorts(), PaymentProviderPort: stub('payments.gateway_not_available') } });
    const after = await p.pp2(s.cred, out.body.id); expect(after.body).toMatchObject({ status: 'failed', failure_code: 'gateway_not_available' }); expect(after.body.action_url).toBeUndefined();
    expect((await p.pp1(s.cred, { gateway: 'esewa' }, 'portal-pay-nonce-9999-abcdefghij')).status).toBe(202);          // a failed request does not block a retry
  });
});
