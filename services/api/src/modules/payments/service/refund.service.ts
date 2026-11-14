// PG-T14 — refund operations P6 listPaymentRefunds, P7 getPaymentRefund, P8 createPaymentRefundRequest, P9 approvePaymentRefund, P10 rejectPaymentRefund and the
// PaymentProviderPort.refund() (TRD §5.1, §5.4, §6.6 steps 1-3; REQ-SEC-055; 08 A19 P-40 key grammar, D-112 row audit only: no ctx.audit here).
// Order in every staff operation: actor guard, assertRole WITHOUT a centre (before any payments.* read), shape validation, load (tenant-scoped, so another tenant's id is
// not_found), assertRole WITH the row's centre (auth.forbidden there is answered as 404, ST-18), state rules and the work.
// Completion (R5-R8: ledger, refunded_paisa, execute / check tasks) is PG-T15; this service ends at `requested`.
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as the PG-T08 services).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { REFUND_STATUSES } from '../domain/refund.state.js';
import { accountById, findById } from '../repository/intents.repo.js';
import { findRefund, updateRefund } from '../repository/refunds.repo.js';
import { CODE, IDEM_KEY, guardActor, invalid, notFound, strict, uuid, type Ctx, type PaymentsDeps, type Row } from '../repository/shared.js';

type Port = { assertRole(c: unknown, r: { permission: string; centreId?: string }): Promise<unknown> };
type RCtx = Omit<Ctx, 'ports' | 'actor'> & { actor: Ctx['actor'] & { membershipId?: string }; ports: Ctx['ports'] & { IdentityPort: Port } };

const READ = 'payments.reconciliation.read', REQUEST = 'payments.refund.request', APPROVE = 'payments.refund.approve';
const GATEWAYS = ['esewa', 'khalti', 'fonepay'];
const CONSUMED = ['requested', 'held_for_review', 'completed', 'failed'];   // the port call already ran for these (the key is spent)
const LIST_KEYS = ['status', 'gateway', 'intent_id', 'created_at_from', 'created_at_to', 'sort', 'cursor', 'limit'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const BATCH = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text500 = (v: unknown, path: string): string | undefined => (v === undefined ? undefined : typeof v === 'string' && v.length <= 500 ? v : invalid(path));
const safeInt = (v: unknown, path: string): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : invalid(path));

async function centreAllowed(ctx: RCtx, permission: string, centreId: string): Promise<boolean> {
  try { await ctx.ports.IdentityPort.assertRole(ctx, { permission, centreId }); return true; } catch (e) {
    if (e instanceof LimsError && e.code === 'auth.forbidden') return false;
    throw e;
  }
}
const roleAt = async (ctx: RCtx, permission: string, centreId: string): Promise<void> => { if (!(await centreAllowed(ctx, permission, centreId))) notFound(); };

export interface CodeItem { code: string; requires_text: boolean; is_active: boolean }
/** Global set + the tenant's override shadowing by code (relabel / deactivate only, 05-SCHEMA cs_reasons). */
export async function activeCode(ctx: Pick<Ctx, 'tenantId' | 'tx'>, set: string, v: unknown): Promise<CodeItem> {
  const code = typeof v === 'string' && CODE.test(v) ? v : invalid('reason_code');
  const g = (await ctx.tx.query('SELECT code, requires_text, is_active FROM payments.g_cs_reasons WHERE set_name = $1 ORDER BY sort_order ASC', [set])).rows.find((r) => r['code'] === code);
  if (!g) return invalid('reason_code');
  const o = (await ctx.tx.query('SELECT code, is_active FROM payments.cs_reasons WHERE tenant_id = $1 AND set_name = $2', [ctx.tenantId, set])).rows.find((r) => r['code'] === code);
  const active = (o ? o['is_active'] : g['is_active']) === true;
  return active ? { code, requires_text: g['requires_text'] === true, is_active: true } : invalid('reason_code');
}

export function createRefundService(deps: PaymentsDeps) {
  const newId = (): string => deps.newId?.() ?? uuidv7();

  /** TRD §6.6 step 1 bounds (re-run at approve): what the intent still holds, then C4's refundable rule. */
  async function assertBounds(ctx: RCtx, intent: Row, amount: number): Promise<void> {
    if (amount > Number(intent['amount_paisa']) - Number(intent['refunded_paisa'])) throw new LimsError('payments.refund_exceeds_captured');
    const due = (await ctx.ports.BillingPort.getOrderBalance(ctx, { orderId: intent['order_id'] })).balanceDue.amountPaisa;
    if (amount > Math.max(0, -due)) throw new LimsError('payments.refund_exceeds_captured', 'exceeds refundable balance');
  }

  // ------------------------------------------------------------------------------------------------ P6
  async function listPaymentRefunds(ctx: RCtx, query: unknown) {
    guardActor(ctx);
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: READ });
    const q = query === undefined ? {} : isObj(query) ? query : invalid('query');
    for (const k of Object.keys(q)) if (!LIST_KEYS.includes(k)) invalid(k);
    const list = (v: unknown, allowed: readonly string[], path: string): string[] => {
      const items = typeof v === 'string' ? v.split(',') : v;
      if (!Array.isArray(items) || items.length < 1 || items.length > 20 || !items.every((x) => typeof x === 'string' && allowed.includes(x))) return invalid(path);
      return [...new Set(items as string[])];
    };
    const sort = q['sort'] === undefined ? '-created_at' : q['sort'] === '-created_at' || q['sort'] === 'created_at' ? q['sort'] : invalid('sort');
    const desc = sort === '-created_at';
    const limit = q['limit'] === undefined ? 50 : typeof q['limit'] === 'number' ? q['limit'] : typeof q['limit'] === 'string' && /^[0-9]{1,4}$/.test(q['limit']) ? Number(q['limit']) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('limit');
    const when = (v: unknown, path: string): Date => (typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v) : invalid(path));

    const conds = ['tenant_id = $1'], vals: unknown[] = [ctx.tenantId];
    const add = (cond: string, v: unknown): void => { vals.push(v); conds.push(cond.replace('?', `$${vals.length}`)); };
    if (q['status'] !== undefined) add('status = ANY(?)', list(q['status'], REFUND_STATUSES, 'status'));
    if (q['gateway'] !== undefined) add('gateway = ANY(?)', list(q['gateway'], GATEWAYS, 'gateway'));
    if (q['intent_id'] !== undefined) add('intent_id = ?', uuid(q['intent_id'], 'intent_id'));
    if (q['created_at_from'] !== undefined) add('created_at >= ?', when(q['created_at_from'], 'created_at_from'));
    if (q['created_at_to'] !== undefined) add('created_at <= ?', when(q['created_at_to'], 'created_at_to'));
    // [CONV] keyset on id as P1 (UUIDv7 = created-time order, never ties); the cursor carries no authority: tenant, filters and centre scope are re-applied per page.
    let after: string | undefined;
    if (q['cursor'] !== undefined) {
      try {
        const c = JSON.parse(Buffer.from(String(q['cursor']), 'base64url').toString('utf8')) as { i?: unknown; d?: unknown };
        if (typeof q['cursor'] === 'string' && q['cursor'].length <= 200 && isObj(c) && c['d'] === (desc ? '-' : '+')) after = uuid(c['i'], 'cursor');
      } catch { /* falls through to the 400 below */ }
      if (after === undefined) invalid('cursor');
    }
    // ponytail: probes each row's centre through IdentityPort (cached per centre) and scans on until the page is full; swap for a SQL predicate once it exposes the caller's centre set.
    const seen = new Map<string, boolean>(), out: Row[] = [];
    while (out.length <= limit) {
      const w = [...conds], v = [...vals];
      if (after) { v.push(after); w.push(`id ${desc ? '<' : '>'} $${v.length}`); }
      const rows = (await ctx.tx.query(`SELECT * FROM payments.refunds WHERE ${w.join(' AND ')} ORDER BY id ${desc ? 'DESC' : 'ASC'} LIMIT ${BATCH}`, v)).rows;
      for (const r of rows) {
        let ok = seen.get(r['centre_id']);
        if (ok === undefined) seen.set(r['centre_id'], ok = await centreAllowed(ctx, READ, r['centre_id']));
        if (ok) out.push(r);
        if (out.length > limit) break;
      }
      if (rows.length < BATCH) break;
      after = rows[rows.length - 1]!['id'];
    }
    const data = out.slice(0, limit);
    const next = out.length > limit ? Buffer.from(JSON.stringify({ i: data[data.length - 1]!['id'], d: desc ? '-' : '+' })).toString('base64url') : undefined;
    return { data, page: { limit, ...(next ? { next_cursor: next } : {}) } };
  }

  // ------------------------------------------------------------------------------------------------ P7
  async function getPaymentRefund(ctx: RCtx, input: unknown) {
    guardActor(ctx);
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: READ });
    const id = uuid(strict(input, ['refundId'])['refundId'], 'refund_id');
    const row = await findRefund(ctx, id) ?? notFound();
    await roleAt(ctx, READ, row['centre_id']);
    return row;
  }

  // ------------------------------------------------------------------------------------------------ P8
  async function createPaymentRefundRequest(ctx: RCtx, input: unknown) {
    guardActor(ctx);
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: REQUEST });
    const i = strict(input, ['intentId', 'body']);
    const intentId = uuid(i['intentId'], 'intent_id');
    const b = strict(i['body'], ['refund_amount_paisa', 'reason_code', 'reason_text']);
    const amount = safeInt(b['refund_amount_paisa'], 'refund_amount_paisa');
    const reasonText = text500(b['reason_text'], 'reason_text');
    const reason = await activeCode(ctx, 'refund_reasons', b['reason_code']);
    if (reason.requires_text && !reasonText?.trim()) invalid('reason_text');

    const intent = await findById(ctx, intentId, true) ?? notFound();
    await roleAt(ctx, REQUEST, intent['centre_id']);
    if (intent['status'] !== 'settled' && intent['status'] !== 'partially_refunded') throw new LimsError('payments.refund_not_allowed');
    await assertBounds(ctx, intent, amount);

    const acct = await accountById(ctx, intent['merchant_account_id']);
    const membership = ctx.actor.membershipId ?? (() => { throw new LimsError('auth.forbidden'); })();
    const id = newId();
    const row = (await ctx.tx.query(
      `INSERT INTO payments.refunds (id, tenant_id, intent_id, order_id, centre_id, gateway, mode, status, amount_paisa, reason_code, reason_text, idempotency_key, requested_by_membership_id, requested_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval', $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT DO NOTHING RETURNING *`,
      [id, ctx.tenantId, intentId, intent['order_id'], intent['centre_id'], intent['gateway'], intent['gateway'] === 'khalti' && acct?.['api_refunds_enabled'] === true ? 'api' : 'manual',
        amount, reason.code, reasonText ?? null, `refund:${id}`, membership, ctx.now(), ctx.actor.id, ctx.actor.id])).rows[0];
    if (!row) throw new LimsError('payments.refund_not_allowed');      // the in-flight partial unique index: one open refund per intent
    return row;
  }

  // ------------------------------------------------------------------------------------------------ P9
  async function approvePaymentRefund(ctx: RCtx, input: unknown) {
    guardActor(ctx);
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: APPROVE });
    const i = strict(input, ['refundId', 'body']);
    const id = uuid(i['refundId'], 'refund_id');
    const b = i['body'] === undefined ? {} : strict(i['body'], ['note']);
    const note = text500(b['note'], 'note');

    const row = await findRefund(ctx, id, true) ?? notFound();
    await roleAt(ctx, APPROVE, row['centre_id']);
    if (row['status'] !== 'pending_approval') throw new LimsError('payments.refund_not_allowed');
    const amount = Number(row['amount_paisa']);
    const approver = ctx.actor.membershipId ?? (() => { throw new LimsError('auth.forbidden'); })();
    if (row['requested_by_membership_id'] === approver) {   // two-person rule; default threshold 0 = always two people
      const s = (await ctx.tx.query('SELECT refund_two_person_threshold_paisa FROM payments.settings WHERE tenant_id = $1', [ctx.tenantId])).rows[0];
      if (!(amount <= Number(s?.['refund_two_person_threshold_paisa'] ?? 0))) throw new LimsError('payments.refund_self_approval_forbidden');
    }
    await assertBounds(ctx, await findById(ctx, row['intent_id'], true) ?? notFound(), amount);

    const approved = await updateRefund(ctx, row, { status: 'approved', approved_by_membership_id: approver, approved_at: ctx.now(), ...(note !== undefined ? { decision_note: note } : {}) }, ['pending_approval']);
    if (!approved) throw new LimsError('payments.refund_not_allowed');
    // Same transaction: a failure of the port call rolls the approval back with it.
    await refund(ctx, { intentId: row['intent_id'], amount: { amountPaisa: amount, currency: 'NPR' }, reasonCode: row['reason_code'], idempotencyKey: `refund:${id}`, approvalId: id });
    if (row['mode'] === 'api') await deps.jobs.enqueue(ctx, 'payments.execute_refund', { tenant_id: ctx.tenantId, refund_id: id }, { key: `execute_refund:${id}` });
    return await findRefund(ctx, id) ?? notFound();
  }

  // ------------------------------------------------------------------------------------------------ P10
  async function rejectPaymentRefund(ctx: RCtx, input: unknown) {
    guardActor(ctx);
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: APPROVE });
    const i = strict(input, ['refundId', 'body']);
    const id = uuid(i['refundId'], 'refund_id');
    const b = strict(i['body'], ['reason_code', 'note']);
    const note = text500(b['note'], 'note');
    const reason = await activeCode(ctx, 'refund_reject_reasons', b['reason_code']);
    if (reason.requires_text && !note?.trim()) invalid('note');

    const row = await findRefund(ctx, id, true) ?? notFound();
    await roleAt(ctx, APPROVE, row['centre_id']);
    if (row['status'] !== 'pending_approval') throw new LimsError('payments.refund_not_allowed');
    const rejecter = ctx.actor.membershipId ?? (() => { throw new LimsError('auth.forbidden'); })();
    return await updateRefund(ctx, row, { status: 'rejected', rejected_by_membership_id: rejecter, rejected_at: ctx.now(), reject_reason_code: reason.code, ...(note !== undefined ? { decision_note: note } : {}) },
      ['pending_approval']) ?? (() => { throw new LimsError('payments.refund_not_allowed'); })();
  }

  // ------------------------------------------------------------------------------------------------ port refund()
  /** TRD §6.6 step 3 / AC-PG-09.6, 09.8. Order: shape + key grammar, then the key lookup (a spent key replays or is reused), then the approval. */
  async function refund(ctx: Ctx, input: unknown): Promise<{ refundId: string; status: string; replayed: boolean }> {
    guardActor(ctx);
    const i = strict(input, ['intentId', 'amount', 'reasonCode', 'idempotencyKey', 'approvalId']);
    const intentId = uuid(i['intentId'], 'intentId');
    const m = strict(i['amount'], ['amountPaisa', 'currency']);
    const amount = safeInt(m['amountPaisa'], 'amount');
    if (m['currency'] !== 'NPR') invalid('amount');
    const reasonCode = typeof i['reasonCode'] === 'string' && CODE.test(i['reasonCode']) ? i['reasonCode'] : invalid('reasonCode');
    const key = typeof i['idempotencyKey'] === 'string' && IDEM_KEY.test(i['idempotencyKey']) ? i['idempotencyKey'] : invalid('idempotencyKey');
    const rctx = ctx as unknown as RCtx;

    const spent = (await ctx.tx.query('SELECT * FROM payments.refunds WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE', [ctx.tenantId, key])).rows[0];
    if (spent && CONSUMED.includes(spent['status'])) {
      if (spent['intent_id'] !== intentId || Number(spent['amount_paisa']) !== amount || spent['reason_code'] !== reasonCode) throw new LimsError('common.idempotency_key_reused');
      return { refundId: spent['id'], status: spent['status'], replayed: true };
    }
    // No existence oracle: a missing, foreign-tenant, unknown or wrongly-stated approval id all answer the same (a malformed one is a plain 400).
    const denied = (): never => { throw new LimsError('payments.refund_requires_approval'); };
    const approval = typeof i['approvalId'] === 'string' && uuid(i['approvalId'], 'approvalId') ? await findRefund(rctx, i['approvalId'], true) : undefined;
    if (!approval || approval['status'] !== 'approved' || approval['intent_id'] !== intentId || Number(approval['amount_paisa']) !== amount || approval['reason_code'] !== reasonCode
      || approval['idempotency_key'] !== key) return denied();
    const requested = await updateRefund(rctx, approval, { status: 'requested' }, ['approved']);
    if (!requested) return denied();
    return { refundId: requested['id'], status: 'requested', replayed: false };
  }

  return { listPaymentRefunds, getPaymentRefund, createPaymentRefundRequest, approvePaymentRefund, rejectPaymentRefund, refund };
}
