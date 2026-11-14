// PG-T08 — createIntent / getIntent / cancelIntent (TRD §5.3, §6.1, §6.4; REQ-SEC-046/053; 03-IC §4.9).
// The amount is always BillingPort.getOrderBalance(...).balanceDue read here; no caller amount is accepted (strict input keys).
import { createHash, randomBytes } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as merchant.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { assertAmountSupported, formatRupees } from '../domain/amount.js';
import { assertReturnUrlAllowed } from '../domain/returnurl.js';
import { accountBySlot, accountById, findById, findByKey, insertIntent, insertTransition, purchaseOrderLabel, updateIntent, usable } from '../repository/intents.repo.js';
import { CODE, IDEM_KEY, OPEN_STATUSES, guardActor, invalid, iso, money, notFound, strict, uuid, type Ctx, type PaymentsDeps, type Row } from '../repository/shared.js';
import { createOutcomeService } from './outcome.service.js';

const GATEWAYS = ['esewa', 'khalti', 'fonepay'];
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const unavailable = (): LimsError => new LimsError('payments.gateway_not_available');

export function createIntentService(deps: PaymentsDeps) {
  const outcome = createOutcomeService(deps);
  const newId = (): string => deps.newId?.() ?? uuidv7();

  /** Stored intent -> gateway action. eSewa re-signs (signed fields are deterministic). */
  async function actionFor(ctx: Ctx, row: Row, token: string) {
    const { acct, handle } = usable(deps.kek, ctx, await accountById(ctx, row['merchant_account_id']));
    if (row['gateway'] === 'khalti') return deps.adapters.khalti.buildAction({ paymentUrl: row['gateway_payment_url'] }, handle);
    return deps.adapters.esewa.buildAction({ id: row['id'], gatewayTxnRef: row['gateway_txn_ref'], amountPaisa: Number(row['amount_paisa']),
      productCode: acct['esewa_product_code'], callbackToken: token }, handle);
  }
  // SPEC GAP (see .orchestra/cr/PG-T08.md): only sha256(token) is stored, so a replay / getIntent cannot reproduce the original callback URLs.
  const freshToken = (): string => randomBytes(32).toString('base64url');

  const result = (row: Row, action: unknown, replayed: boolean) => ({
    intentId: row['id'] as string, gateway: row['gateway'] as string, amount: money(row['amount_paisa']), action: action as any,
    ...(row['expires_at'] ? { expiresAt: iso(row['expires_at']) } : {}), replayed,
  });

  async function replay(ctx: Ctx, existing: Row, fingerprint: string) {
    if (existing['request_fingerprint'] !== fingerprint) throw new LimsError('common.idempotency_key_reused');
    return result(existing, await actionFor(ctx, existing, freshToken()), true);
  }

  async function createIntent(ctx: Ctx, input: unknown) {
    guardActor(ctx);
    const i = strict(input, ['orderId', 'gateway', 'idempotencyKey', 'returnUrl', 'cancelUrl']);
    const orderId = uuid(i['orderId'], 'orderId');
    const key = typeof i['idempotencyKey'] === 'string' && IDEM_KEY.test(i['idempotencyKey']) ? i['idempotencyKey'] : invalid('idempotencyKey');
    const gateway = typeof i['gateway'] === 'string' && GATEWAYS.includes(i['gateway']) ? i['gateway'] as 'esewa' | 'khalti' | 'fonepay' : invalid('gateway');
    const returnUrl = typeof i['returnUrl'] === 'string' ? i['returnUrl'] : invalid('returnUrl');
    const cancelUrl = typeof i['cancelUrl'] === 'string' ? i['cancelUrl'] : invalid('cancelUrl');
    assertReturnUrlAllowed(returnUrl, deps.config.returnUrlAllowlist);
    assertReturnUrlAllowed(cancelUrl, deps.config.returnUrlAllowlist);

    const fingerprint = sha256(`${orderId}|${gateway}|${returnUrl}|${cancelUrl}`);
    const seen = await findByKey(ctx, key);
    if (seen) return replay(ctx, seen, fingerprint);

    if (gateway === 'fonepay') throw unavailable(); // B8
    const { acct, handle } = usable(deps.kek, ctx, await accountBySlot(ctx, gateway, deps.config.gatewayEnv));
    const order = await ctx.ports.FrontdeskPort.getOrderSummary(ctx, { orderId });
    if (order.status === 'cancelled') throw new LimsError('payments.nothing_due');
    const due = (await ctx.ports.BillingPort.getOrderBalance(ctx, { orderId })).balanceDue.amountPaisa;
    if (!(due > 0)) throw new LimsError('payments.nothing_due');
    assertAmountSupported(gateway, due);
    if (gateway === 'esewa') formatRupees(due, { allowFractional: deps.config.esewaAllowFractionalRupees }); // amount_not_supported unless whole rupees

    const id = newId();
    const token = freshToken();
    const inserted = await insertIntent(ctx, { id, tenant_id: ctx.tenantId, order_id: orderId, branch_id: order.branchId, centre_id: order.centreId, gateway,
      environment: deps.config.gatewayEnv, merchant_account_id: acct['id'], status: 'created', amount_paisa: due, idempotency_key: key, request_fingerprint: fingerprint,
      return_url: returnUrl, cancel_url: cancelUrl, callback_token_sha256: createHash('sha256').update(token).digest(), created_actor_type: ctx.actor.type,
      created_by: ctx.actor.id, updated_by: ctx.actor.id });
    if (!inserted) { // lost a race: same key -> replay; otherwise another intent holds the order's open slot
      const again = await findByKey(ctx, key);
      if (again) return replay(ctx, again, fingerprint);
      throw new LimsError('payments.intent_open_exists');
    }
    await insertTransition(ctx, newId(), id, { from: null, to: 'created', cause: 'create' });

    // Step 9: eSewa signs locally; Khalti initiates server-side. Any failure aborts the whole request (nothing persisted).
    const now = Date.parse(ctx.now());
    let refs: Row, action: unknown;
    try {
      if (gateway === 'esewa') {
        action = await deps.adapters.esewa.buildAction({ id, gatewayTxnRef: id, amountPaisa: due, productCode: acct['esewa_product_code'], callbackToken: token }, handle);
        refs = { gateway_txn_ref: id, expires_at: new Date(now + deps.config.esewaIntentTtlMinutes * 60_000).toISOString() };
      } else {
        const log = outcome.gatewayLog(ctx, 'khalti', id, acct, 'khalti_initiate');
        let r;
        try {
          r = await deps.adapters.khalti.initiate({ intentId: id, amountPaisa: due, callbackToken: token, websiteUrl: acct['khalti_website_url'],
            purchaseOrderName: await purchaseOrderLabel(ctx) }, handle, { sink: log.sink });
          await log.fallback('answer');
        } catch (e) { await log.fallback('network_error'); throw e; }
        action = r.action;
        refs = { gateway_txn_ref: r.gatewayTxnRef, gateway_payment_url: r.paymentUrl, expires_at: r.expiresAt };
      }
    } catch { throw unavailable(); }

    const created = await findById(ctx, id, true) ?? notFound();
    const row = await updateIntent(ctx, created, { ...refs, status: 'initiated', initiated_at: ctx.now() }, { from: ['created'] }) ?? notFound();
    await insertTransition(ctx, newId(), id, { from: 'created', to: 'initiated', cause: 'create' });

    // Step 11: poll schedule + one final check at expires_at + grace; job keys poll:<intent_id>:<n> (unique, so a replay never doubles them).
    const expires = new Date(row['expires_at']).getTime();
    const runs = [...deps.config.pollScheduleSeconds.map((s) => now + s * 1000), expires + deps.config.expiryGraceMinutes * 60_000];
    for (const [n, at] of runs.entries()) {
      await deps.jobs.enqueue(ctx, 'payments.poll_intent', { tenant_id: ctx.tenantId, intent_id: id, n: n + 1 }, { key: `poll:${id}:${n + 1}`, runAt: new Date(at) });
    }
    return result(row, action, false);
  }

  async function getIntent(ctx: Ctx, input: unknown) {
    guardActor(ctx);
    const id = uuid(strict(input, ['intentId'])['intentId'], 'intentId');
    const r = await findById(ctx, id) ?? notFound();
    let action: unknown;
    if (r['status'] === 'initiated' || r['status'] === 'pending') {
      try { action = await actionFor(ctx, r, freshToken()); } catch { /* account disabled since creation: no action to offer; getIntent never throws for it */ }
    }
    return {
      intentId: r['id'] as string, orderId: r['order_id'] as string, gateway: r['gateway'] as string, status: r['status'] as string,
      amount: money(r['amount_paisa']), refundedAmount: money(r['refunded_paisa']),
      ...(r['expires_at'] ? { expiresAt: iso(r['expires_at']) } : {}), ...(r['settled_at'] ? { settledAt: iso(r['settled_at']) } : {}),
      ...(action ? { action: action as any } : {}),
    };
  }

  async function cancelIntent(ctx: Ctx, input: unknown) {
    guardActor(ctx);
    const i = strict(input, ['intentId', 'reasonCode']);
    const id = uuid(i['intentId'], 'intentId');
    const reason = typeof i['reasonCode'] === 'string' && CODE.test(i['reasonCode']) ? i['reasonCode'] : invalid('reasonCode');
    const cur = await findById(ctx, id) ?? notFound();
    if (!(OPEN_STATUSES as readonly string[]).includes(cur['status'])) throw new LimsError('payments.intent_invalid_transition');

    // Verify first; a gateway "paid" settles instead (TRD §6.4). Unknown-status holds are suppressed: cancelling needs no evidence of payment.
    const checked = await outcome.applyCheck(ctx, id, 'reconciliation', { cause: 'cancel', suppressUnknownHold: true });
    if (!(OPEN_STATUSES as readonly string[]).includes(checked.status)) return { intentId: id, status: checked.status };

    const row = await findById(ctx, id, true) ?? notFound();
    const upd = await updateIntent(ctx, row, { status: 'failed', failure_reason: 'abandoned', closed_at: ctx.now() }, { from: OPEN_STATUSES });
    if (!upd) throw new LimsError('payments.intent_invalid_transition');
    await insertTransition(ctx, newId(), id, { from: row['status'], to: 'failed', cause: 'cancel', reason }); // the deadline check job stays queued (late success -> I13 hold)
    return { intentId: id, status: 'failed' };
  }

  return { createIntent, getIntent, cancelIntent };
}
