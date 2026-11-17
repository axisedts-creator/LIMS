// PG-T08 — verify / applyCheck (TRD §6.2; mapping tables §7.2.4 / §7.3.4; event §8.1; REQ-SEC-046/047/048/053).
// One path for port verify, cancel and (later tasks) callbacks, polls, recheck and reconciliation. Money moves only on a gateway answer
// whose status is exactly the success string and whose amount equals the stored amount; callback input is never an argument here.
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as merchant.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { hold, STAY, RETRY, type GatewayOutcome } from '../domain/outcome.js';
import { mapEsewaStatus } from '../domain/mapping.esewa.js';
import { mapKhaltiStatus } from '../domain/mapping.khalti.js';
import type { GatewayCallRecord } from '../gateways/http.js';
import { accountById, findById, insertTransition, updateIntent, usable } from '../repository/intents.repo.js';
import { insertGatewayCall } from '../repository/gatewayCalls.repo.js';
import { guardActor, money, notFound, strict, uuid, type Ctx, type PaymentsDeps, type Row } from '../repository/shared.js';

export type { PaymentsDeps } from '../repository/shared.js';
export type CheckMode = 'verify' | 'reconciliation';
/** PG-T13: what applyCheck decided (final outcome, after the exceeds-due / already-held adjustments) — lets reconciliation derive its finding without a second gateway call. */
export interface CheckDecision { outcome: GatewayOutcome; beforeStatus: string; answer?: { statusRaw: string; amountPaisa?: number } }
// PG-T12 (P4): `reason` = reason_code of the settle transition row; `settleSets` = extra columns written in the same UPDATE as the settle (resolution_* fields). Both default to none.
export interface CheckOptions { cause?: string; allowExceedsDue?: boolean; suppressUnknownHold?: boolean; reason?: string; settleSets?: Row; onDecision?: (d: CheckDecision) => void }
export interface VerifyResult { intentId: string; status: string; gatewayStatusRaw?: string; verifiedAmount?: { amountPaisa: number; currency: 'NPR' } }

const SETTLED_FAMILY = ['settled', 'partially_refunded', 'refunded'];
const OPEN = ['created', 'initiated', 'pending'];
const SETTLEABLE = ['initiated', 'pending', 'held_for_review'];
const METHOD = { esewa: 'esewa_status_check', khalti: 'khalti_lookup' } as const;
const OPERATION = { esewa: 'esewa_status', khalti: 'khalti_lookup' } as const;
const CALL_OUTCOMES = ['answer', 'service_unavailable', 'timeout', 'network_error', 'http_error', 'auth_error', 'not_found', 'invalid_response'];

export const viewOf = (r: Row): VerifyResult => ({
  intentId: r['id'], status: r['status'],
  ...(r['last_gateway_status_raw'] ? { gatewayStatusRaw: r['last_gateway_status_raw'] } : {}),
  ...(SETTLED_FAMILY.includes(r['status']) && r['verified_amount_paisa'] != null ? { verifiedAmount: money(r['verified_amount_paisa']) } : {}),
});

type Check = Awaited<ReturnType<PaymentsDeps['adapters']['khalti']['check']>> | Awaited<ReturnType<PaymentsDeps['adapters']['esewa']['check']>>;

export function createOutcomeService(deps: PaymentsDeps) {
  const newId = (): string => deps.newId?.() ?? uuidv7();

  /** Gateway call evidence (TRD §6.2 step 2): the adapter's sink writes the redacted row; if the adapter did not, a minimal row is written here. */
  // PG-T15: `refundId` tags the row; `queue` defers the INSERT (the caller flushes it only when it goes on to write, so a refused / unanswered read-only check leaves no write).
  const gatewayLog = (ctx: Ctx, gateway: 'esewa' | 'khalti', intentId: string, acct: Row, operation: string, o: { refundId?: string; queue?: (() => Promise<void>)[] } = {}) => {
    let logged = false;
    const write = async (r: Pick<GatewayCallRecord, 'attempt' | 'httpStatus' | 'outcome' | 'gatewayStatusRaw' | 'responseRedacted' | 'durationMs'>): Promise<void> => {
      const go = (): Promise<void> => insertGatewayCall(ctx.tx, { id: newId(), tenantId: ctx.tenantId, intentId, refundId: o.refundId ?? null, merchantAccountId: acct['id'], gateway, operation, createdBy: ctx.actor.id, ...r });
      if (o.queue) o.queue.push(go); else await go();
    };
    return {
      sink: async (r: GatewayCallRecord): Promise<void> => { logged = true; await write(r); },
      async fallback(outcome: string, statusRaw: string | null = null): Promise<void> {
        if (logged) return;
        await write({ attempt: 1, httpStatus: null, outcome: (CALL_OUTCOMES.includes(outcome) ? outcome : 'invalid_response') as GatewayCallRecord['outcome'], gatewayStatusRaw: statusRaw, responseRedacted: null, durationMs: 0 });
      },
    };
  };

  async function callGateway(ctx: Ctx, row: Row, acct: Row, handle: ReturnType<typeof usable>['handle'], o: { refundId?: string; queue?: (() => Promise<void>)[] } = {}): Promise<Check> {
    const gateway = row['gateway'] as 'esewa' | 'khalti';
    const log = gatewayLog(ctx, gateway, row['id'], acct, OPERATION[gateway], o);
    let res: Check | undefined;    try {
      res = gateway === 'esewa'
        ? await deps.adapters.esewa.check({ id: row['id'], gatewayTxnRef: row['gateway_txn_ref'], amountPaisa: Number(row['amount_paisa']), productCode: acct['esewa_product_code'], callbackToken: '' }, handle,
          { timeoutClass: 'inrequest', sink: log.sink })
        : await deps.adapters.khalti.check({ intentId: row['id'], gatewayTxnRef: row['gateway_txn_ref'], amountPaisa: Number(row['amount_paisa']) }, handle, { timeoutClass: 'inrequest', sink: log.sink });
    } catch { res = undefined; } // adapters report transport trouble as a value; anything thrown is treated the same: no answer
    const done: Check = res ?? { kind: 'transient', reason: 'network_error' };
    await log.fallback(done.kind === 'transient' ? done.reason : done.kind, done.kind === 'answer' ? done.statusRaw : null);
    return done;
  }

  function decide(ctx: Ctx, row: Row, res: Check, o: CheckOptions): GatewayOutcome {
    const open = OPEN.includes(row['status']);
    if (res.kind !== 'answer') {
      if (res.kind === 'auth_error') deps.log?.error('payments_credential_rejected', { intentId: row['id'], gateway: row['gateway'] });
      if (res.kind === 'not_found' && open && Number(row['consecutive_unknown']) + 1 >= 3) return hold('gateway_not_found'); // TRD §7.3.3: retry <= 3 consecutive
      return RETRY;
    }
    const raw = res.statusRaw;
    const expires = row['expires_at'] ? new Date(row['expires_at']).getTime() : undefined;
    const input = {
      // Exact strings only: padded / odd-case text is an unknown status, never a success (REQ-SEC-047).
      statusRaw: raw === raw.trim() ? raw : '\u0000unknown',
      amountMatches: res.amountPaisa !== undefined && res.amountPaisa === Number(row['amount_paisa']),
      beforeDeadline: expires === undefined || Date.parse(ctx.now()) < expires + deps.config.expiryGraceMinutes * 60_000,
      intentStatus: row['status'],
    };
    let out = row['gateway'] === 'esewa' ? mapEsewaStatus(input) : mapKhaltiStatus(input);
    // [CONV] 03-IC §4.9 case 5 (higher precedence than TRD §7.2.4 "retry <= 3"): an unknown eSewa status on an open intent holds at once.
    if (out.kind === 'retry') out = hold('gateway_status_unknown');
    if (o.suppressUnknownHold && out.kind === 'hold' && out.reason === 'gateway_status_unknown') out = STAY; // cancel: no evidence of payment
    return out;
  }

  async function applyCheck(ctx: Ctx, intentId: string, mode: CheckMode, o: CheckOptions = {}): Promise<VerifyResult> {
    const nowIso = ctx.now();
    const first = await findById(ctx, intentId) ?? notFound();
    if (mode === 'verify') {
      if (SETTLED_FAMILY.includes(first['status'])) return viewOf(first); // nothing left to verify; reconciliation re-checks these
      if (first['last_checked_at'] && new Date(first['last_checked_at']).getTime() > Date.parse(nowIso) - deps.config.verifyMinIntervalSeconds * 1000) return viewOf(first);
    }
    const { acct, handle } = usable(deps.kek, ctx, await accountById(ctx, first['merchant_account_id']));
    const res = await callGateway(ctx, first, acct, handle);

    // Step 4: lock; decide with the status as it is NOW (no second gateway call if it moved since step 1).
    const row = await findById(ctx, intentId, true) ?? notFound();
    let out = decide(ctx, row, res, o);
    const answer = res.kind === 'answer' ? res : undefined;
    const book: Row = {
      last_checked_at: nowIso,
      consecutive_unknown: res.kind === 'answer' ? 0 : res.kind === 'not_found' ? Number(row['consecutive_unknown']) + 1 : Number(row['consecutive_unknown']),
      ...(answer ? { last_gateway_status_raw: answer.statusRaw.slice(0, 64) } : {}),
      ...(answer?.secondaryRef ? { gateway_secondary_ref: answer.secondaryRef.slice(0, 64) } : {}),
    };
    const cause = o.cause ?? (mode === 'reconciliation' ? 'reconciliation' : 'verify_call');
    const save = async (sets: Row, to?: string, reason?: string): Promise<Row> => {
      const upd = await updateIntent(ctx, row, { ...book, ...sets, ...(to ? { status: to } : {}) }, { inc: ['check_count'] });
      if (!upd) throw new LimsError('common.internal'); // row is locked; a lost update would be a bug, so roll the unit back
      if (to) await insertTransition(ctx, newId(), row['id'], { from: row['status'], to, cause, ...(reason ? { reason } : {}) });
      return upd;
    };
    const amount = Number(row['amount_paisa']);

    if (out.kind === 'settle' && !o.allowExceedsDue) {
      const bal = await ctx.ports.BillingPort.getOrderBalance(ctx, { orderId: row['order_id'] });
      if (amount > bal.balanceDue.amountPaisa) out = hold('exceeds_due'); // TRD §6.2 step 5a / AC-PG-06.3
    }
    if (out.kind === 'hold' && row['status'] === 'held_for_review') out = STAY;
    o.onDecision?.({ outcome: out, beforeStatus: row['status'], ...(answer ? { answer: { statusRaw: answer.statusRaw, ...(answer.amountPaisa !== undefined ? { amountPaisa: answer.amountPaisa } : {}) } } : {}) });

    let upd: Row;
    switch (out.kind) {
      case 'settle': {
        // Ledger first: the settled CHECK needs ledger_entry_id in the same UPDATE. The row lock replaces the step-5b version race.
        const led = await ctx.ports.BillingPort.recordGatewayPayment(ctx, { intentId: row['id'], orderId: row['order_id'], gateway: row['gateway'],
          gatewayTxnRef: row['gateway_txn_ref'], amount: money(amount), verifiedAt: nowIso, ...(o.allowExceedsDue ? { allowExceedsDue: true } : {}) });
        const settled = await updateIntent(ctx, row, { ...book, status: 'settled', settled_at: nowIso, verified_amount_paisa: amount,
          verification_method: METHOD[row['gateway'] as 'esewa' | 'khalti'], ledger_entry_id: led.ledgerEntryId, ...o.settleSets }, { from: SETTLEABLE, inc: ['check_count'] });
        if (!settled) throw new LimsError('common.internal');
        await deps.events.publish(ctx, 'payments.intent.settled.v1', {
          aggregate: { type: 'payment_intent', id: row['id'], seq: Number(settled['version']) },
          idempotencyKey: `${row['gateway']}:${row['gateway_txn_ref']}:settled`,
          payload: { intent_id: row['id'], order_id: row['order_id'], gateway: row['gateway'], gateway_txn_ref: row['gateway_txn_ref'],
            amount: { amount_paisa: amount, currency: 'NPR' }, verified_at: nowIso, verification_method: METHOD[row['gateway'] as 'esewa' | 'khalti'], ledger_entry_id: led.ledgerEntryId } });
        await insertTransition(ctx, newId(), row['id'], { from: row['status'], to: 'settled', cause, ...(o.reason ? { reason: o.reason } : {}) });
        upd = settled;
        break;
      }
      case 'hold':
        upd = await save({ hold_reason: out.reason }, 'held_for_review', out.reason);
        if (out.reason === 'amount_mismatch') deps.log?.error('payment_amount_mismatch', { intentId: row['id'], tenantId: ctx.tenantId, gateway: row['gateway'] }); // ids only
        break;
      case 'fail': upd = await save({ failure_reason: out.reason, closed_at: nowIso }, 'failed', out.reason); break;
      case 'expire': upd = await save({ failure_reason: 'expired_unpaid', closed_at: nowIso }, 'expired', 'expired_unpaid'); break;
      case 'to_pending': upd = await save({ pending_at: nowIso }, 'pending'); break;
      default: upd = await save({}); // stay / retry / ok / finding: check bookkeeping only (findings are PG-T11)
    }
    return viewOf(upd);
  }

  async function verify(ctx: Ctx, input: unknown): Promise<VerifyResult> {
    guardActor(ctx);
    const i = strict(input, ['intentId']);
    return applyCheck(ctx, uuid(i['intentId'], 'intentId'), 'verify');
  }

  /** PG-T13: one gateway status call for an intent with the call evidence row, no intent bookkeeping or transition (reconciliation of refunds). */
  async function probe(ctx: Ctx, intentId: string): Promise<Check> {
    const row = await findById(ctx, intentId) ?? notFound();
    const { acct, handle } = usable(deps.kek, ctx, await accountById(ctx, row['merchant_account_id']));
    return callGateway(ctx, row, acct, handle);
  }

  /** PG-T15: the refund checks' gateway call. The evidence row is QUEUED, not written: the caller runs `flush()` once it decides to write (a refused / transient read stays write-free). */
  async function probeDeferred(ctx: Ctx, intentId: string, refundId: string): Promise<{ res: Check; flush(): Promise<void> }> {
    const row = await findById(ctx, intentId) ?? notFound();
    const { acct, handle } = usable(deps.kek, ctx, await accountById(ctx, row['merchant_account_id']));
    const queue: (() => Promise<void>)[] = [];
    const res = await callGateway(ctx, row, acct, handle, { refundId, queue });
    return { res, async flush() { for (const go of queue.splice(0)) await go(); } };
  }

  return { verify, applyCheck, probe, probeDeferred, gatewayLog };
}
