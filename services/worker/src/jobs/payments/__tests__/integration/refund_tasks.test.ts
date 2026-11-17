// PG-T15 (C15) — worker tasks `payments.execute_refund` and `payments.check_refund` (02-TRD §8.3 rows 5-6, §6.6 steps 4 + 6, §7.4; AC-PG-09.4, 09.5, 09.7).
// REAL payments services over the in-memory DB fake + scripted gateways (api helpers/refundHarness.ts over portHarness.ts) and a fake clock: each job runs with ctx.now() = its run time.
// SEAM THE WRITER MUST FOLLOW (spec fixes the FILES and the task ids; the rest is the tester's reading, dispute via .orchestra/notes if wrong):
//   tasks/check_refund.ts    export const CHECK_REFUND = 'payments.check_refund'    export function createCheckRefund(deps: PaymentsDeps, ports: { BillingPort, FrontdeskPort }): TaskHandler
//   tasks/execute_refund.ts  export const EXECUTE_REFUND = 'payments.execute_refund' export function createExecuteRefund(deps: PaymentsDeps, ports): TaskHandler     (same shape as createPollIntent)
//   payload { tenant_id, refund_id }; JobContext has no `ports`, hence the second argument. Uses ctx.tx, ctx.now(), ctx.tenantId, ctx.actor (system), deps.adapters.<gw>.check,
//   deps.adapters.khalti.refundViaApi(stored, secretHandle, callCtx), deps.jobs.enqueue, ports.BillingPort.recordGatewayRefund. The completion step is the SAME function the P11 / P7b handlers use.
//   check_refund (TRD §6.6 step 6): refund requested | held_for_review -> one gateway check; confirmed -> completed + recordGatewayRefund + refunded_paisa + intent I10/I11/I12;
//     not confirmed -> held_for_review (held_reason refund_not_visible; an existing api_outcome_unknown is kept); kind mismatch -> held_for_review / refund_kind_mismatch; transient -> THROW
//     (graphile backoff, max_attempts 8; nothing written); any other status -> no gateway call, no write, no throw. No min interval (that is P7b's). It never touches unconfirmed_run_count.
//   execute_refund (steps 4, max_attempts 1): acts only on a `requested` refund with mode 'api' of a khalti intent whose merchant account has api_refunds_enabled (else: zero refund calls, no write);
//     lookup FIRST (deps.adapters.khalti.check) - already Refunded / Partially Refunded -> skip the POST; else refundViaApi ONCE (never retried);
//     'accepted' -> row stays `requested`; 'unknown' -> row held_for_review / api_outcome_unknown (the only place the schema can keep it); 'rejected' -> failed / refund_rejected_by_provider;
//     every outcome except 'rejected' enqueues payments.check_refund {tenant_id, refund_id}. A transient lookup -> no POST.
// Fails now: ../../tasks/check_refund.js and ../../tasks/execute_refund.js do not exist.
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { M, makeRefundHarness, uid, type RefundHarness } from '../../../../../../api/src/modules/payments/__tests__/helpers/refundHarness';
import { CHECK_REFUND, createCheckRefund } from '../../tasks/check_refund.js';
import { EXECUTE_REFUND, createExecuteRefund } from '../../tasks/execute_refund.js';

const A = TENANTS.A, B = TENANTS.B;
const RID = uid(700);
const CAPTURED = 225000;
const SECRET = 'synthetic-khalti-secret';
const at = (seconds: number): string => new Date(Date.parse(FIXED_NOW) + seconds * 1000).toISOString();
const GW = { khalti: { full: 'Refunded', partial: 'Partially Refunded', none: 'Completed' }, esewa: { full: 'FULL_REFUND', partial: 'PARTIAL_REFUND', none: 'COMPLETE' } } as const;

let t: RefundHarness;
let api: { calls: { refund: any; secret: string; c: any; checksBefore: number }[]; reply: any };
const empty = (row: any, ...cols: string[]): void => { for (const c of cols) expect(row[c] ?? null, c).toBeNull(); };

async function arrange(o: Parameters<typeof makeRefundHarness>[0] = {}) {
  t = await makeRefundHarness(o);
  api = { calls: [], reply: { kind: 'accepted', detail: 'Transaction refund successful.' } };
  // the PG-T07 adapter double has no refund API; the scripted one records every call, what it was given, and how many lookups came first
  (t.h.deps.adapters.khalti as any).refundViaApi = async (refund: any, s: any, c: any) => {
    api.calls.push({ refund: structuredClone(refund), secret: await s.use((x: string) => x), c, checksBefore: t.h.gateway.calls.filter((g) => g.op === 'check').length });
    if (api.reply instanceof Error) throw api.reply;
    return api.reply;
  };
  script(GW.khalti.none);
}
const script = (raw: string, id = t.intentId): void => t.h.setOrder({ id: t.intent(id).order_id, tenantId: A, dueAmountPaisa: -Number(t.intent(id).amount_paisa), gatewayStatus: raw });
const checks = () => t.h.gateway.calls.filter((c) => c.op === 'check');
const jobs = (task: string) => t.h.jobs.filter((j) => j.task === task);
const writes = (from: number) => t.h.db.stmts.slice(from).filter((s) => /^\s*(update|insert|delete)\b/i.test(s.text));
const seed = (status = 'requested', o: Partial<Parameters<RefundHarness['addRefund']>[0]> = {}) => t.addRefund({ id: RID, intent: t.intentId, status, ...o });

/** Runs one job as graphile would: its own tenant transaction, system actor, ctx.now() = `now`; a throw rolls the unit (and the spies) back. */
async function run(make: (deps: any, ports: any) => any, payload: any, now = FIXED_NOW, tenantId = payload?.tenant_id ?? A) {
  let tx: unknown;
  try {
    await t.h.db.run((ctx: any) => { tx = ctx.tx; return make(t.h.deps, t.h.ports)(payload, { ...ctx, tenantId, actor: { type: 'system', id: tenantId }, attempt: 1, maxAttempts: 8, jobId: 'job-1' }); },
      { tenantId, now: () => new Date(now) });
  } catch (e) { if (tx !== undefined) t.h.rollback(tx); throw e; }
}
const check = (now = FIXED_NOW, payload: any = { tenant_id: A, refund_id: RID }) => run(createCheckRefund, payload, now);
const execute = (now = FIXED_NOW, payload: any = { tenant_id: A, refund_id: RID }) => run(createExecuteRefund, payload, now);

beforeEach(async () => { await arrange(); });

describe('task ids (TRD §8.3)', () => {
  it('are exactly payments.check_refund and payments.execute_refund', () => { expect(CHECK_REFUND).toBe('payments.check_refund'); expect(EXECUTE_REFUND).toBe('payments.execute_refund'); });
});

describe('check_refund: confirmation (AC-PG-09.4)', () => {
  it('requested + gateway shows the refund -> completed, ledger once (approver = the approving membership), intent refunded, transition cause refund by the system actor', async () => {
    seed(); script(GW.khalti.full);
    await check(at(3600));
    expect(t.refundRow(RID).status).toBe('completed');
    expect(new Date(t.refundRow(RID).completed_at).toISOString()).toBe(at(3600)); expect(new Date(t.refundRow(RID).last_checked_at).toISOString()).toBe(at(3600));
    expect(t.refundRow(RID).ledger_entry_id).toBe('01900000-0000-7000-8000-0000000cc000'); empty(t.refundRow(RID), 'held_reason');
    expect(t.h.ledger.refunds).toHaveLength(1);
    expect(t.h.ledger.refunds[0]).toMatchObject({ refundId: RID, intentId: t.intentId, orderId: t.orderId, gateway: 'khalti', gatewayTxnRef: t.intent().gateway_txn_ref,
      amount: { amountPaisa: CAPTURED, currency: 'NPR' }, reasonCode: 'test_cancelled', approvedByMembershipId: M.B });
    expect(t.intent()).toMatchObject({ status: 'refunded' }); expect(Number(t.intent().refunded_paisa)).toBe(CAPTURED);
    expect(t.h.db.transitions(A).filter((x: any) => x.intent_id === t.intentId).at(-1)).toMatchObject({ to_status: 'refunded', cause: 'refund', actor_type: 'system' });
    expect(checks()).toHaveLength(1); expect(t.access()).toEqual([]);
  });

  it('held_for_review + the refund has become visible -> completed (a later run fixes an earlier "not visible")', async () => {
    seed('held_for_review'); script(GW.khalti.partial); t.refundRow(RID).amount_paisa = 100000;
    await check();
    expect(t.refundRow(RID).status).toBe('completed'); expect(t.intent()).toMatchObject({ status: 'partially_refunded' }); expect(Number(t.intent().refunded_paisa)).toBe(100000);
  });

  it('eSewa FULL_REFUND confirms a full refund', async () => {
    await arrange({ intents: [{ gateway: 'esewa' }] }); seed('requested', { gateway: 'esewa' }); script(GW.esewa.full);
    await check();
    expect(t.refundRow(RID).status).toBe('completed'); expect(t.h.ledger.refunds[0]).toMatchObject({ gateway: 'esewa' });
  });

  it('a re-delivered job after completion is a no-op: no gateway call, no write, ledger still once', async () => {
    seed(); script(GW.khalti.full); await check();
    const calls = checks().length, mark = t.h.db.stmts.length;
    await expect(check(at(60))).resolves.toBeUndefined();
    expect(checks()).toHaveLength(calls); expect(writes(mark)).toEqual([]); expect(t.h.ledger.refunds).toHaveLength(1);
  });
});

describe('check_refund: not confirmed (AC-PG-09.5)', () => {
  it('requested + no refund visible -> held_for_review / refund_not_visible, last_checked_at = now, no ledger row, intent untouched, unconfirmed_run_count untouched', async () => {
    seed(); await check(at(3700));
    expect(t.refundRow(RID)).toMatchObject({ status: 'held_for_review', held_reason: 'refund_not_visible', version: 2 });
    expect(new Date(t.refundRow(RID).last_checked_at).toISOString()).toBe(at(3700)); expect(Number(t.refundRow(RID).unconfirmed_run_count ?? 0)).toBe(0);
    expect(t.h.ledger.refunds).toEqual([]); expect(t.intent()).toMatchObject({ status: 'settled', version: 1 }); expect(Number(t.intent().refunded_paisa)).toBe(0);
  });

  it('held_for_review + still not visible stays held; the held reason of an earlier API call whose outcome was unknown is kept', async () => {
    seed('held_for_review'); t.refundRow(RID).held_reason = 'api_outcome_unknown';
    await check(at(60));
    expect(t.refundRow(RID)).toMatchObject({ status: 'held_for_review', held_reason: 'api_outcome_unknown' }); expect(new Date(t.refundRow(RID).last_checked_at).toISOString()).toBe(at(60));
    expect(t.h.ledger.refunds).toEqual([]);
  });

  it.each([['full expected, "Partially Refunded"', 225000, GW.khalti.partial], ['partial expected, "Refunded"', 100000, GW.khalti.full]] as const)(
    'kind mismatch (%s) -> held_for_review / refund_kind_mismatch, no ledger row', async (_n, amount, raw) => {
      seed('requested', { amountPaisa: amount }); script(raw); await check();
      expect(t.refundRow(RID)).toMatchObject({ status: 'held_for_review', held_reason: 'refund_kind_mismatch' }); expect(t.h.ledger.refunds).toEqual([]); expect(Number(t.intent().refunded_paisa)).toBe(0);
    });

  it('no usable gateway answer (transient) -> the handler THROWS (backoff), refund and intent untouched, nothing enqueued', async () => {
    seed(); script('code:0'); const before = structuredClone([t.refundRow(RID), t.intent()]); const mark = t.h.db.stmts.length;
    await expect(check()).rejects.toThrow();
    expect(checks()).toHaveLength(1); expect(writes(mark)).toEqual([]); expect(structuredClone([t.refundRow(RID), t.intent()])).toEqual(before); expect(t.h.jobs).toEqual([]);
    script(GW.khalti.full); await expect(check(at(30))).resolves.toBeUndefined(); expect(t.refundRow(RID).status).toBe('completed');   // the same job succeeds on a later attempt
  });

  it('the task is not throttled by P7b\'s 10 s interval: a check 1 s after the last one still calls the gateway', async () => {
    seed('held_for_review'); t.refundRow(RID).last_checked_at = new Date(Date.parse(FIXED_NOW) - 1000);
    await check(); expect(checks()).toHaveLength(1);
  });
});

describe('check_refund: other states and untrusted payloads', () => {
  it.each(['pending_approval', 'approved', 'rejected', 'completed', 'failed'])('refund in %s -> no gateway call, no write, no enqueue, does not throw', async (status) => {
    seed(status); script(GW.khalti.full); const before = structuredClone(t.refundRow(RID)); const mark = t.h.db.stmts.length;
    await expect(check()).resolves.toBeUndefined();
    expect(checks()).toHaveLength(0); expect(writes(mark)).toEqual([]); expect(t.refundRow(RID)).toEqual(before); expect(t.h.jobs).toEqual([]); expect(t.h.ledger.refunds).toEqual([]);
  });

  it('a job of tenant B naming tenant A\'s refund touches nothing and calls no gateway', async () => {
    seed(); script(GW.khalti.full); const mark = t.h.db.stmts.length;
    await check(FIXED_NOW, { tenant_id: B, refund_id: RID }).catch(() => undefined);
    await run(createCheckRefund, { tenant_id: A, refund_id: RID }, FIXED_NOW, B).catch(() => undefined);
    expect(checks()).toHaveLength(0); expect(writes(mark)).toEqual([]); expect(t.refundRow(RID).status).toBe('requested'); expect(t.h.ledger.refunds).toEqual([]);
  });

  it.each([[{ tenant_id: A }], [{ tenant_id: A, refund_id: 'not-a-uuid' }], [{ tenant_id: A, refund_id: { $ne: null } }], [{ tenant_id: A, refund_id: uid(799) }]])(
    'malformed or unknown refund_id %j: no gateway call, no write, no retry', async (payload) => {
      seed(); script(GW.khalti.full); const mark = t.h.db.stmts.length;
      await expect(check(FIXED_NOW, payload)).resolves.toBeUndefined();
      expect(checks()).toHaveLength(0); expect(writes(mark)).toEqual([]);
    });

  it('a status / amount / reference smuggled into the payload is ignored: completion needs the gateway answer and the approved amount', async () => {
    seed('requested', { amountPaisa: 100000 }); script(GW.khalti.none);
    await check(FIXED_NOW, { tenant_id: A, refund_id: RID, status: 'completed', amount_paisa: 1, gateway_refund_reference: 'FORGED', ledger_entry_id: uid(1) });
    expect(t.refundRow(RID).status).toBe('held_for_review'); expect(t.h.ledger.refunds).toEqual([]);
  });
});

describe('execute_refund: the API path is behind the tenant flag (AC-PG-09.7)', () => {
  it('flag OFF (default) but a stale mode "api" refund: ZERO refund API calls, nothing written, nothing enqueued, no throw', async () => {
    seed('requested', { mode: 'api' }); const mark = t.h.db.stmts.length;
    await expect(execute()).resolves.toBeUndefined();
    expect(api.calls).toHaveLength(0); expect(writes(mark)).toEqual([]); expect(t.refundRow(RID).status).toBe('requested');
  });

  it('manual-mode refund (the flag never mattered): zero refund API calls', async () => {
    await arrange({ apiRefunds: true }); seed('requested', { mode: 'manual' });
    await execute(); expect(api.calls).toHaveLength(0); expect(t.refundRow(RID).status).toBe('requested');
  });

  it('eSewa has no refund API: even a (corrupt) api-mode eSewa refund makes zero refund API calls', async () => {
    await arrange({ apiRefunds: true, intents: [{ gateway: 'esewa' }] }); seed('requested', { mode: 'api', gateway: 'esewa' });
    await execute().catch(() => undefined); expect(api.calls).toHaveLength(0);
  });

  it.each(['pending_approval', 'approved', 'held_for_review', 'completed', 'failed', 'rejected'])('flag on but refund in %s: zero refund API calls, no write', async (status) => {
    await arrange({ apiRefunds: true }); seed(status, { mode: 'api' }); const mark = t.h.db.stmts.length;
    await expect(execute()).resolves.toBeUndefined();
    expect(api.calls).toHaveLength(0); expect(writes(mark)).toEqual([]);
  });

  it('other tenants\' flags do not count: tenant B has the flag, tenant A does not -> A\'s refund makes zero refund API calls', async () => {
    await arrange(); t.h.db.accounts(B).find((a: any) => a.gateway === 'khalti')!.api_refunds_enabled = true;
    seed('requested', { mode: 'api' }); await execute(); expect(api.calls).toHaveLength(0);
  });
});

describe('execute_refund: lookup first, one attempt (TRD §6.6 step 4)', () => {
  beforeEach(async () => { await arrange({ apiRefunds: true }); });

  it('flag on, not refunded yet: ONE lookup, then exactly ONE refund API call (after the lookup) with the stored Khalti transaction id and the approved amount; check_refund enqueued; refund stays requested', async () => {
    seed('requested', { mode: 'api' }); script(GW.khalti.none);
    await execute();
    expect(checks()).toHaveLength(1);
    expect(api.calls).toHaveLength(1); expect(api.calls[0]!.checksBefore).toBe(1);
    expect(api.calls[0]!.refund).toMatchObject({ refundId: RID, intentId: t.intentId, transactionId: 'SYN-TXN-REF-1', amountPaisa: CAPTURED, fullRefund: true });
    expect(api.calls[0]!.secret).toBe(SECRET);                                                       // the decrypted merchant secret reaches the adapter only as a SecretHandle
    expect(jobs(CHECK_REFUND)).toHaveLength(1); expect(jobs(CHECK_REFUND)[0]!.payload).toEqual({ tenant_id: A, refund_id: RID });
    expect(t.refundRow(RID).status).toBe('requested'); expect(t.h.ledger.refunds).toEqual([]);      // confirmation is by lookup only, never by the POST answer
  });

  it('a partial refund is sent as partial (fullRefund false, the approved amount)', async () => {
    seed('requested', { mode: 'api', amountPaisa: 100000 }); await execute();
    expect(api.calls[0]!.refund).toMatchObject({ amountPaisa: 100000, fullRefund: false });
  });

  it.each([['Refunded', GW.khalti.full], ['Partially Refunded', GW.khalti.partial]] as const)('the lookup already says "%s" -> the POST is SKIPPED, check_refund enqueued', async (_n, raw) => {
    seed('requested', { mode: 'api' }); script(raw);
    await execute();
    expect(api.calls).toHaveLength(0); expect(checks()).toHaveLength(1); expect(jobs(CHECK_REFUND)).toHaveLength(1);
  });

  it('a transient lookup -> NO POST (never POST blind); nothing written', async () => {
    seed('requested', { mode: 'api' }); script('code:0'); const mark = t.h.db.stmts.length;
    await execute().catch(() => undefined);
    expect(api.calls).toHaveLength(0); expect(writes(mark)).toEqual([]); expect(t.refundRow(RID).status).toBe('requested');
  });

  it('outcome "unknown" -> held_for_review / api_outcome_unknown, check_refund still enqueued, exactly one POST', async () => {
    seed('requested', { mode: 'api' }); api.reply = { kind: 'unknown', detail: 'timeout' };
    await execute();
    expect(api.calls).toHaveLength(1);
    expect(t.refundRow(RID)).toMatchObject({ status: 'held_for_review', held_reason: 'api_outcome_unknown' }); expect(jobs(CHECK_REFUND)).toHaveLength(1);
    expect(t.h.ledger.refunds).toEqual([]);
  });

  it('then check_refund: refund visible -> completed; still not visible -> stays held with api_outcome_unknown', async () => {
    seed('requested', { mode: 'api' }); api.reply = { kind: 'unknown' }; await execute();
    await check(at(60)); expect(t.refundRow(RID)).toMatchObject({ status: 'held_for_review', held_reason: 'api_outcome_unknown' });
    script(GW.khalti.full); await check(at(120)); expect(t.refundRow(RID).status).toBe('completed'); expect(t.h.ledger.refunds).toHaveLength(1);
  });

  it('a throwing adapter is an "unknown" outcome and is NOT retried by the task (the POST happened at most once)', async () => {
    seed('requested', { mode: 'api' }); api.reply = new Error('socket hang up');
    await execute().catch(() => undefined);
    expect(api.calls).toHaveLength(1);
  });

  it('a documented rejection -> failed / refund_rejected_by_provider (the slot is freed), no ledger row', async () => {
    t.h.db.put('payments.g_cs_reasons', { id: uid(8900), set_name: 'refund_fail_reasons', code: 'refund_rejected_by_provider', display: 'Refund rejected by provider', requires_text: false, sort_order: 2 });
    seed('requested', { mode: 'api' }); api.reply = { kind: 'rejected', detail: 'not refundable' };
    await execute();
    expect(t.refundRow(RID)).toMatchObject({ status: 'failed', failure_reason: 'refund_rejected_by_provider' }); expect(t.h.ledger.refunds).toEqual([]); expect(Number(t.intent().refunded_paisa)).toBe(0);
  });

  it('a re-delivered job never POSTs twice: after an unknown outcome the refund is held, so the second run makes no refund call', async () => {
    seed('requested', { mode: 'api' }); api.reply = { kind: 'unknown' };
    await execute(); await execute(at(5));
    expect(api.calls).toHaveLength(1);
  });

  it('a re-delivered job after the refund completed makes no refund call and no gateway call', async () => {
    seed('requested', { mode: 'api' }); script(GW.khalti.full); await execute(); await check();
    const calls = checks().length; await execute(at(5));
    expect(api.calls).toHaveLength(0); expect(checks()).toHaveLength(calls);
  });

  it('the secret never appears in jobs, alerts or the refund row; the payload carries ids only', async () => {
    seed('requested', { mode: 'api' }); api.reply = { kind: 'unknown', detail: 'x' }; await execute();
    expect(JSON.stringify([t.h.jobs, t.h.alerts, t.refundRow(RID), t.h.db.stmts.map((s) => s.params ?? [])])).not.toContain(SECRET);
    for (const j of t.h.jobs) expect(Object.keys(j.payload).sort()).toEqual(['refund_id', 'tenant_id']);
  });

  it.each([[{ tenant_id: A }], [{ tenant_id: A, refund_id: 'nope' }], [{ tenant_id: B, refund_id: RID }], [{ tenant_id: A, refund_id: { $ne: null } }]])(
    'malformed / foreign payload %j: zero refund API calls, no gateway call, no write', async (payload) => {
      seed('requested', { mode: 'api' }); const mark = t.h.db.stmts.length;
      await execute(FIXED_NOW, payload).catch(() => undefined);
      expect(api.calls).toHaveLength(0); expect(checks()).toHaveLength(0); expect(writes(mark)).toEqual([]);
    });
});
