// PG-T11 (C15) — worker task `payments.poll_intent` (02-TRD §8.3 row 1; AC-PG-05.1, AC-PG-05.2; 03-APP-FLOW "patient closes the tab").
// REAL payments services (createPaymentProviderPort / applyCheck) over the in-memory DB fake + scripted gateways (api helpers/portHarness.ts) and a FAKE CLOCK:
// each job runs with ctx.now() = its own run_at, jobs run in run_at order, no wall clock and no sleeping.
// SEAM THE WRITER MUST FOLLOW (spec fixes the FILE; dispute via .orchestra/notes if wrong):
//   tasks/poll_intent.ts  export const POLL_INTENT = 'payments.poll_intent'
//                         export function createPollIntent(deps: PaymentsDeps, ports: { BillingPort, FrontdeskPort }): TaskHandler
//     payload { tenant_id, intent_id, n }; handler = createOutcomeService(deps).applyCheck({ ...ctx, ports }, intent_id, <mode>) with transition cause 'poll'.
//     JobContext has no `ports`, hence the second argument (the same ledger/frontdesk ports the API wires). Uses ctx.tx, ctx.now(), ctx.tenantId, ctx.actor only.
//   Behaviour: open intent -> one gateway check, mapped exactly as US-PG-03/04 (applyCheck); settled / failed / expired / refunded -> NO gateway call, no write,
//   no enqueue (terminal stops the polls; the other keyed jobs of the intent run as no-ops); `retry` outcome (no usable gateway answer) -> the handler THROWS
//   (graphile built-in backoff, max_attempts 8). A poll never settles on anything but a gateway answer (callers pass no amount/status).
// Fails now: ../../tasks/poll_intent.js does not exist.
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { makePortHarness, type PortHarness } from '../../../../../../api/src/modules/payments/__tests__/helpers/portHarness';
import { POLL_INTENT, createPollIntent } from '../../tasks/poll_intent.js';

const A = TENANTS.A, B = TENANTS.B;
const O1 = '01900000-0000-7000-8000-0000000c1501';
const DUE = 225000;
const URLS = { returnUrl: 'https://app.lims.test/pay/done', cancelUrl: 'https://app.lims.test/pay/cancel' };
const at = (seconds: number): string => new Date(Date.parse(FIXED_NOW) + seconds * 1000).toISOString();
type Job = { task: string; payload: any; key: string; runAt?: Date };

let h: PortHarness;
const arrange = (gatewayStatus: string) => h.seed({ orders: [{ id: O1, tenantId: A, dueAmountPaisa: DUE, gatewayStatus }], returnUrlHosts: ['app.lims.test'] });
const gw = (gatewayStatus: string) => h.setOrder({ id: O1, tenantId: A, dueAmountPaisa: DUE, gatewayStatus });
const create = (gateway: 'esewa' | 'khalti') => h.impl.createIntent(h.ctxFor('A:system'), { orderId: O1, gateway, idempotencyKey: `k-${gateway}`, ...URLS });
const row = (id: string) => h.db.intents(A).find((r) => r.id === id)!;
const checks = () => h.gateway.calls.filter((c) => c.op === 'check');
const polls = (id: string): Job[] => h.jobs.filter((j) => j.task === POLL_INTENT && j.payload.intent_id === id).sort((a, b) => a.runAt!.getTime() - b.runAt!.getTime());
const writes = (from: number) => h.db.stmts.slice(from).filter((s) => /^\s*(update|insert|delete)\b/i.test(s.text));

/** Runs one job as graphile would: its own tenant transaction, system actor, ctx.now() = `now`. */
const run = (job: Pick<Job, 'payload'>, now: string, handler = createPollIntent(h.deps, h.ports)) => h.db.run(
  (ctx) => handler(job.payload, { ...ctx, tenantId: job.payload.tenant_id, actor: { type: 'system', id: job.payload.tenant_id }, attempt: 1, maxAttempts: 8, jobId: `job-${job.payload.n}` }),
  { tenantId: job.payload.tenant_id, now: () => new Date(now) });
const at_ = (j: Job) => j.runAt!.toISOString();

beforeEach(async () => { h = await makePortHarness(); await arrange('PENDING'); });

describe('task id', () => {
  it('is exactly payments.poll_intent (<module>.<snake_task>, TRD §8.3)', () => { expect(POLL_INTENT).toBe('payments.poll_intent'); });
});

describe('AC-PG-05.1 polls follow the schedule and use the US-PG-03/04 mapping (fake clock)', () => {
  it('Khalti: polls at +120/+300 see "Initiated" (stay open), the poll at +600 sees "Completed" -> settled once; the later keyed polls are no-ops (terminal stops polls)', async () => {
    gw('Initiated'); const r = await create('khalti');
    const jobs = polls(r.intentId);
    expect(jobs).toHaveLength(h.config.pollScheduleSeconds.length + 1);
    expect(jobs.map((j) => j.payload.n).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const j of jobs.slice(0, 2)) { await run(j, at_(j)); expect(row(r.intentId).status).toBe('initiated'); }
    expect(checks()).toHaveLength(2);
    expect(row(r.intentId)).toMatchObject({ check_count: 2 }); expect(new Date(row(r.intentId).last_checked_at).toISOString()).toBe(at(300));
    gw('Completed');
    await run(jobs[2]!, at_(jobs[2]!));
    expect(row(r.intentId)).toMatchObject({ status: 'settled', verification_method: 'khalti_lookup' }); expect(Number(row(r.intentId).verified_amount_paisa)).toBe(DUE);
    expect(new Date(row(r.intentId).settled_at).toISOString()).toBe(at(600));
    expect(h.db.transitions(A).filter((t) => t.intent_id === r.intentId).at(-1)).toMatchObject({ from_status: 'initiated', to_status: 'settled', cause: 'poll', actor_type: 'system' });
    expect(h.ledger.calls).toHaveLength(1); expect(h.events.ofType('payments.intent.settled.v1')).toHaveLength(1);
    const calls = checks().length; const mark = h.db.stmts.length; const jobsBefore = h.jobs.length;
    for (const j of jobs.slice(3)) await run(j, at_(j));                                   // +1200, +2400, final: terminal -> nothing
    expect(checks()).toHaveLength(calls); expect(writes(mark)).toEqual([]);
    expect(h.jobs).toHaveLength(jobsBefore); expect(h.ledger.calls).toHaveLength(1); expect(h.events.ofType('payments.intent.settled.v1')).toHaveLength(1);
    expect(row(r.intentId).status).toBe('settled');
  });

  it('eSewa: the first poll sees PENDING -> pending (cause poll); a later poll sees COMPLETE with the exact amount -> settled', async () => {
    gw('PENDING'); const r = await create('esewa'); const jobs = polls(r.intentId);
    await run(jobs[0]!, at_(jobs[0]!));
    expect(row(r.intentId).status).toBe('pending');
    expect(h.db.transitions(A).filter((t) => t.intent_id === r.intentId).at(-1)).toMatchObject({ from_status: 'initiated', to_status: 'pending', cause: 'poll' });
    gw('COMPLETE'); await run(jobs[1]!, at_(jobs[1]!));
    expect(row(r.intentId)).toMatchObject({ status: 'settled', verification_method: 'esewa_status_check' });
    expect(h.ledger.calls).toEqual([expect.objectContaining({ intentId: r.intentId, orderId: O1, gateway: 'esewa', gatewayTxnRef: r.intentId })]);
  });

  it('a poll never settles a mismatching amount: COMPLETE with another amount holds for review, no ledger write', async () => {
    h.setOrder({ id: O1, tenantId: A, dueAmountPaisa: DUE, gatewayStatus: 'COMPLETE', gatewayAmountPaisa: DUE - 100 });
    const r = await create('esewa'); const [j] = polls(r.intentId);
    await run(j!, at_(j!));
    expect(row(r.intentId).status).toBe('held_for_review'); expect(h.ledger.calls).toHaveLength(0); expect(h.events.ofType('payments.intent.settled.v1')).toHaveLength(0);
  });

  it('each poll records its gateway evidence row (payments.gateway_calls) for the intent', async () => {
    gw('Initiated'); const r = await create('khalti'); const [j] = polls(r.intentId);
    await run(j!, at_(j!));
    expect(h.db.gatewayCalls(A).filter((c) => c.intent_id === r.intentId && c.operation === 'khalti_lookup')).toHaveLength(1);
  });
});

describe('AC-PG-05.2 the final check closes an unpaid intent', () => {
  it('eSewa: NOT_FOUND before expires_at + grace keeps the intent open; at the deadline (+2400 s) it becomes expired (cause poll, closed_at set, no ledger, no event); the duplicate final job is a no-op', async () => {
    gw('NOT_FOUND'); const r = await create('esewa'); const jobs = polls(r.intentId);
    expect(at_(jobs.at(-1)!)).toBe(at(h.config.esewaIntentTtlMinutes * 60 + h.config.expiryGraceMinutes * 60));
    for (const j of jobs.filter((x) => Date.parse(at_(x)) < Date.parse(at_(jobs.at(-1)!)))) { await run(j, at_(j)); expect(row(r.intentId).status).toBe('initiated'); }
    expect(checks().length).toBeGreaterThanOrEqual(4);
    const atDeadline = jobs.filter((x) => at_(x) === at_(jobs.at(-1)!));
    await run(atDeadline[0]!, at_(atDeadline[0]!));
    const x = row(r.intentId);
    expect(x.status).toBe('expired'); expect(x.failure_reason).toBeTruthy(); expect(new Date(x.closed_at).toISOString()).toBe(at_(atDeadline[0]!));
    expect(h.db.transitions(A).filter((t) => t.intent_id === r.intentId).at(-1)).toMatchObject({ to_status: 'expired', cause: 'poll' });
    expect(h.ledger.calls).toHaveLength(0); expect(h.events.ofType('payments.intent.settled.v1')).toHaveLength(0);
    const calls = checks().length; const mark = h.db.stmts.length;
    for (const j of atDeadline.slice(1)) await run(j, at_(j));
    expect(checks()).toHaveLength(calls); expect(writes(mark)).toEqual([]); expect(row(r.intentId).status).toBe('expired');
  });

  it('Khalti: "Expired" on the final check (expires_at + grace) -> expired, no ledger, no event', async () => {
    gw('Expired'); const r = await create('khalti'); const last = polls(r.intentId).at(-1)!;
    await run(last, at_(last));
    expect(row(r.intentId)).toMatchObject({ status: 'expired' }); expect(row(r.intentId).failure_reason).toBeTruthy();
    expect(h.ledger.calls).toHaveLength(0); expect(h.events.ofType('payments.intent.settled.v1')).toHaveLength(0);
  });

  it('if the gateway reports success on a check made before expires_at + grace, the intent settles instead of expiring', async () => {
    gw('COMPLETE'); const r = await create('esewa'); const last = polls(r.intentId).at(-1)!;
    await run(last, at(h.config.esewaIntentTtlMinutes * 60 + 5 * 60));                     // inside expires_at + grace
    expect(row(r.intentId).status).toBe('settled'); expect(h.ledger.calls).toHaveLength(1);
  });
});

describe('terminal intents stop the polls', () => {
  const TERMINAL: [string, string][] = [['settled', 'COMPLETE'], ['failed', 'COMPLETE'], ['expired', 'COMPLETE'], ['refunded', 'COMPLETE'], ['partially_refunded', 'COMPLETE']];
  it.each(TERMINAL)('%s: the poll makes no gateway call, writes nothing, enqueues nothing and does not throw', async (status, gatewayStatus) => {
    const id = '01900000-0000-7000-8000-0000000d1101';
    await h.seed({ orders: [{ id: O1, tenantId: A, dueAmountPaisa: DUE, gatewayStatus }], returnUrlHosts: ['app.lims.test'],
      intents: [{ id, tenantId: A, orderId: O1, gateway: 'esewa', status, amountPaisa: DUE, idempotencyKey: 'seeded-1', ...(status === 'partially_refunded' ? { refundedPaisa: 1000 } : status === 'refunded' ? { refundedPaisa: DUE } : {}) }] });
    const before = { ...row(id) }; const mark = h.db.stmts.length; const jobs = h.jobs.length;
    await expect(run({ payload: { tenant_id: A, intent_id: id, n: 3 } }, at(1200))).resolves.toBeUndefined();
    expect(checks()).toHaveLength(0); expect(writes(mark)).toEqual([]); expect(h.jobs).toHaveLength(jobs);
    expect(row(id).status).toBe(status); expect(row(id).version).toBe(before.version); expect(h.ledger.calls).toHaveLength(0);
  });
});

describe('retry -> throw (graphile built-in backoff, max_attempts 8)', () => {
  it('no usable gateway answer (transient) makes the handler throw and leaves the intent open and untouched', async () => {
    gw('code:0'); const r = await create('esewa'); const [j] = polls(r.intentId); const before = { ...row(r.intentId) };
    await expect(run(j!, at_(j!))).rejects.toThrow();
    expect(checks()).toHaveLength(1);
    expect(row(r.intentId)).toMatchObject({ status: 'initiated', version: before.version, check_count: before.check_count });
    expect(h.ledger.calls).toHaveLength(0);
  });
  it('the same job succeeds on a later attempt once the gateway answers (retry is not terminal)', async () => {
    gw('code:0'); const r = await create('khalti'); const [j] = polls(r.intentId);
    await expect(run(j!, at_(j!))).rejects.toThrow();
    gw('Completed'); await expect(run(j!, new Date(j!.runAt!.getTime() + 30_000).toISOString())).resolves.toBeUndefined();
    expect(row(r.intentId).status).toBe('settled');
  });
});

describe('security: payload is untrusted (REQ-SEC-046/053, tenant isolation)', () => {
  it('a job for tenant B naming tenant A\'s intent touches nothing and calls no gateway', async () => {
    gw('COMPLETE'); const r = await create('esewa'); const before = { ...row(r.intentId) }; const mark = h.db.stmts.length;
    await run({ payload: { tenant_id: B, intent_id: r.intentId, n: 1 } }, at(120)).catch(() => undefined);
    expect(checks()).toHaveLength(0); expect(writes(mark)).toEqual([]); expect(row(r.intentId)).toMatchObject({ status: before.status, version: before.version });
    expect(h.ledger.calls).toHaveLength(0);
  });
  it.each([[{ tenant_id: A, n: 1 }], [{ tenant_id: A, intent_id: 'not-a-uuid', n: 1 }], [{ tenant_id: A, intent_id: { $ne: null }, n: 1 }], [{ tenant_id: A, intent_id: '01900000-0000-7000-8000-0000000d9999', n: 1 }]])(
    'malformed or unknown intent_id %j: no gateway call, no write', async (payload) => {
      gw('COMPLETE'); const mark = h.db.stmts.length;
      await run({ payload } as any, at(120)).catch(() => undefined);
      expect(checks()).toHaveLength(0); expect(writes(mark)).toEqual([]); expect(h.ledger.calls).toHaveLength(0);
    });
  it('an amount or status smuggled into the payload is ignored: settlement needs the gateway answer', async () => {
    gw('PENDING'); const r = await create('esewa'); const [j] = polls(r.intentId);
    await run({ payload: { ...j!.payload, status: 'COMPLETE', amount_paisa: DUE, total_amount: '2250' } }, at_(j!)).catch(() => undefined);
    expect(row(r.intentId).status).not.toBe('settled'); expect(h.ledger.calls).toHaveLength(0);
  });
});
