// Two-person manual refunds (02-TRD §5 B10 requestRefund, B10a approveRefund, B10b rejectRefund, B10c listRefundRequests, §6.5 "Manual refund"; PRD US-BL-06.2/.3;
// 07-SECURITY REQ-SEC-055/056/057; 08 A13 D-24) and finance review items (B36, PRD US-BL-09.2).
// Money moves only on approval: B10 stores a pending request, B10a inserts the one refund ledger row (approver = collector, approver != requester) and recomputes the balance in the
// same transaction. Refundable = paid - (invoiced - credited), checked at request AND at approval under the order_balances lock (TRD §12). Tenant and actor come from ctx only.
import type { IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { fiscalYearOf } from '../domain/fiscalYear.js';
import { moneyOf, toPaisa } from '../domain/money/paisa.js';
import type { BillingEvents } from '../events/publish.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import { createBalanceService, type BalanceCtx } from './balance.service.js';
import { DEFAULT_TZ, ledgerEntryDto, localDate, names } from './ledgerDto.js';
import { bad, decodeCursor, encodeCursor, isRec, iso, limitOf, present, STAFF_DISPLAY, UUID, uuid } from './invoiceRead.service.js';

type Row = Record<string, any>;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CARD_DIGITS = /[0-9]{13,19}/; // refund_requests__text__ck / ledger_entries__ref__ck (REQ-SEC-056)
const REQUEST_STATUSES = ['pending', 'approved', 'rejected'];
const ITEM_STATUSES = ['open', 'resolved'];
const RESOLUTIONS = ['refunded', 'kept_as_advance', 'other'];

const invalid = (...errors: FieldError[]): LimsError => new LimsError('common.validation_failed', undefined, errors);

function scope(ctx: BalanceCtx): { tx: never; tenantId: string; actorId: string; membershipId: string | undefined } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as never, tenantId: ctx.tenantId, actorId: ctx.actor.id, membershipId: ctx.actor.membershipId };
}
/** Requester / approver / resolver is a membership: an actor without one cannot act. */
function member(ctx: BalanceCtx) {
  const s = scope(ctx);
  if (s.membershipId === undefined) throw new LimsError('auth.forbidden');
  return { ...s, membershipId: s.membershipId };
}

/** Optional string of at most `max` chars. Never echoes the value. */
function optText(v: unknown, path: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) throw bad(path);
  return v;
}
function versionOf(v: unknown): number {
  if (v === undefined) throw new LimsError('common.precondition_required');
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw bad('/expectedVersion');
  return v;
}
function note500(v: unknown, required: boolean): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || v.trim().length > 500 || (required && v.trim().length === 0)) throw bad('/note');
  const t = v.trim();
  return t === '' ? undefined : t;
}
const unique = (e: unknown, part: string): boolean => {
  const x = e as { code?: unknown; message?: unknown; constraint?: unknown } | null;
  return x?.code === '23505' && `${String(x.constraint ?? '')} ${String(x.message ?? '')}`.includes(part);
};

const actor = (id: unknown, display: ReadonlyMap<string, string>) => (typeof id === 'string' ? { membership_id: id, display_name: display.get(id) ?? STAFF_DISPLAY } : undefined);

function refundDto(r: Row, display: ReadonlyMap<string, string>, ledgerEntry?: object) {
  return present({
    id: r['id'], order_id: r['order_id'], method_code: r['method_code'], refund_amount: moneyOf(toPaisa(r['refund_amount_paisa'])), reason_code: r['reason_code'], reason_text: r['reason_text'],
    reference_masked: r['reference_text'], status: r['status'], requested_by: actor(r['requested_by_membership_id'], display), requested_at: iso(r['created_at']),
    decided_by: actor(r['decided_by_membership_id'], display), decided_at: r['decided_at'] ? iso(r['decided_at']) : undefined, note: r['decision_note'],
    ledger_entry: ledgerEntry, version: Number(r['version']),
  });
}
function itemDto(r: Row, display: ReadonlyMap<string, string>) {
  return present({
    id: r['id'], order_id: r['order_id'], kind: r['kind'], status: r['status'], amount: moneyOf(toPaisa(r['amount_paisa'])), ledger_entry_id: r['ledger_entry_id'], created_at: iso(r['created_at']),
    resolved_at: r['resolved_at'] ? iso(r['resolved_at']) : undefined, resolved_by: actor(r['resolved_by'], display), resolution_code: r['resolution_code'], note: r['note'],
    refund_ledger_entry_id: r['refund_ledger_entry_id'], version: Number(r['version']),
  });
}

export function createRefundService(deps: { repo?: BillingRepo; events: BillingEvents }) {
  const repo = deps.repo ?? billingRepo;
  const balance = createBalanceService({ repo, events: deps.events });

  const activity = (ctx: BalanceCtx, a: { action: string; kind: string; id: string; centreId: unknown; membershipId: string; details: Record<string, unknown> }) =>
    repo.insertActivity(ctx.tx as never, {
      id: uuidv7(), tenant_id: ctx.tenantId, centre_id: typeof a.centreId === 'string' ? a.centreId : null, action: a.action, document_kind: a.kind, document_id: a.id, document_no: null,
      actor_id: ctx.actor.id, actor_membership_id: a.membershipId, actor_type: ctx.actor.type, occurred_at: ctx.now(), request_id: ctx.requestId ?? null, details: a.details, created_by: ctx.actor.id,
    }); // details never carry free text or the payout reference

  /** B10: a pending request; no money moves. */
  async function requestRefund(ctx: BalanceCtx, raw: unknown) {
    const { tx, tenantId, actorId, membershipId } = member(ctx);
    if (!isRec(raw)) throw bad('/');
    const errors: FieldError[] = [];
    const check = (path: string, ok: boolean) => { if (!ok) errors.push({ path, code: 'common.field_invalid', message: 'Field invalid' }); };
    const orderId = raw['orderId'];
    check('/orderId', typeof orderId === 'string' && UUID.test(orderId));
    const method = raw['methodCode'];
    check('/methodCode', typeof method === 'string' && method.length >= 1 && method.length <= 64 && !CONTROL.test(method));
    const amount = raw['refundAmountPaisa'];
    check('/refundAmountPaisa', typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 1);
    const code = raw['reasonCode'];
    check('/reasonCode', typeof code === 'string' && code.length >= 1 && code.length <= 64 && !CONTROL.test(code));
    const text = raw['reasonText'];
    check('/reasonText', text === undefined || (typeof text === 'string' && text.length <= 500));
    let reference: string | undefined;
    if (raw['reference'] !== undefined) {
      const t = typeof raw['reference'] === 'string' ? raw['reference'].trim() : undefined;
      if (t === undefined || t.length > 100 || CONTROL.test(t) || CARD_DIGITS.test(t)) check('/reference', false);
      else if (t !== '') reference = t;
    }
    if (errors.length) throw invalid(...errors);
    const o = orderId as string, m = method as string, a = amount as number;

    const totals = await repo.readOrderTotals(tx, { tenantId, orderId: o });
    if (!totals || typeof totals.branch_id !== 'string' || typeof totals.centre_id !== 'string') throw new LimsError('common.not_found');
    if (!(await repo.getPaymentMethod(tx, { tenantId, code: m }))) throw invalid({ path: '/methodCode', code: 'common.field_invalid', message: 'Field invalid' });
    if (a > refundable(totals)) throw new LimsError('billing.ledger_reversal_invalid');

    const row = await repo.insertRefundRequest(tx, {
      id: uuidv7(), tenant_id: tenantId, branch_id: totals.branch_id, centre_id: totals.centre_id, order_id: o, method_code: m, refund_amount_paisa: a, reason_code: code,
      reason_text: text ?? null, reference_text: reference ?? null, status: 'pending', requested_by_membership_id: membershipId, created_by: actorId,
    });
    if (!row) throw new LimsError('common.internal');
    await activity(ctx, { action: 'refund_requested', kind: 'refund_request', id: String(row['id']), centreId: totals.centre_id, membershipId, details: { order_id: o, method_code: m, amount_paisa: a } });
    return refundDto(row, await names(ctx, [membershipId]));
  }

  /** B10a: the second person approves; the refund ledger row, the balance and the request move in one transaction. */
  async function approveRefund(ctx: BalanceCtx, raw: unknown) {
    const { tx, tenantId, actorId, membershipId } = member(ctx);
    const i = isRec(raw) ? raw : {};
    const id = uuid(i['refundRequestId'], '/refundRequestId');
    const expectedVersion = versionOf(i['expectedVersion']);
    const decisionNote = note500(i['note'], false);

    const q = await repo.getRefundRequest(tx, { tenantId, refundRequestId: id });
    if (!q) throw new LimsError('common.not_found');
    if (q['status'] !== 'pending') throw new LimsError('common.immutable_record');
    if (q['requested_by_membership_id'] === membershipId) throw new LimsError('billing.refund_self_approval_forbidden');
    if (Number(q['version']) !== expectedVersion) throw new LimsError('common.version_conflict');

    const idp = ctx.ports?.IdentityPort;
    if (!idp) throw new LimsError('common.internal');
    const nowIso = ctx.now();
    const timezone: string = (await idp.getTenantSettings(ctx, { keys: ['timezone'] }))?.timezone ?? DEFAULT_TZ;
    const fy = fiscalYearOf(nowIso as IsoUtc, timezone);

    // TRD §12: order_balances first; the cap is re-read under the lock, so two approvals of one order serialize and the second sees the first.
    const orderId = String(q['order_id']);
    await repo.lockOrderBalance(tx, { tenantId, orderId });
    const totals = await repo.readOrderTotals(tx, { tenantId, orderId });
    if (!totals) throw new LimsError('common.not_found');
    const amount = toPaisa(q['refund_amount_paisa']);
    if (amount > refundable(totals)) throw new LimsError('billing.ledger_reversal_invalid');

    // the approver pays out: their open session at the order's centre, opened now when there is none (manual rows always have a session, like B8)
    const centreId = String(q['centre_id']);
    const find = () => repo.findOpenCashSession(tx, { tenantId, membershipId, centreId });
    const session = (await find())
      ?? (await repo.insertCashSession(tx, { id: uuidv7(), tenantId, branchId: String(q['branch_id']), centreId, membershipId, openedAt: nowIso, userId: actorId }))
      ?? (await find());
    if (!session) throw new LimsError('common.internal');

    const ledgerId = uuidv7();
    let entry: Row | undefined;
    try {
      entry = await repo.insertLedgerEntry(tx, {
        id: ledgerId, tenantId, branchId: String(q['branch_id']), centreId, orderId, invoiceId: null, entryKind: 'refund', captureKind: 'manual', methodCode: String(q['method_code']),
        amountPaisa: -amount, fiscalYearBs: fy.long, businessDate: localDate(nowIso, timezone), collectedByMembershipId: membershipId, approvedByMembershipId: membershipId, userId: actorId,
        reasonCode: String(q['reason_code']), reasonText: typeof q['reason_text'] === 'string' ? q['reason_text'] : null, refundRequestId: id,
        cashSessionId: String(session['id']), referenceText: typeof q['reference_text'] === 'string' ? q['reference_text'] : null,
      });
    } catch (e) {
      throw unique(e, 'refund_request') ? new LimsError('common.version_conflict') : e; // decided by someone else in the meantime
    }
    if (!entry) throw new LimsError('common.internal');

    await balance.applyChange(ctx, { orderId, cause: 'payment_reversed' });
    const decided = await repo.decideRefundRequest(tx, {
      tenantId, refundRequestId: id, expectedVersion, status: 'approved', decidedByMembershipId: membershipId, decidedAt: nowIso, decisionNote: decisionNote ?? null, ledgerEntryId: ledgerId, userId: actorId,
    });
    if (!decided) throw new LimsError('common.version_conflict'); // the throw rolls the refund row and the balance back
    await activity(ctx, { action: 'refund_recorded', kind: 'ledger_entry', id: ledgerId, centreId, membershipId, details: { order_id: orderId, refund_request_id: id, method_code: q['method_code'], amount_paisa: -amount } });
    const display = await names(ctx, [q['requested_by_membership_id'], membershipId]);
    return refundDto(decided, display, ledgerEntryDto(entry, display));
  }

  /** B10b: decline (the requester may withdraw). No money moves. */
  async function rejectRefund(ctx: BalanceCtx, raw: unknown) {
    const { tx, tenantId, actorId, membershipId } = member(ctx);
    const i = isRec(raw) ? raw : {};
    const id = uuid(i['refundRequestId'], '/refundRequestId');
    const expectedVersion = versionOf(i['expectedVersion']);
    const decisionNote = note500(i['note'], true);

    const q = await repo.getRefundRequest(tx, { tenantId, refundRequestId: id });
    if (!q) throw new LimsError('common.not_found');
    if (q['status'] !== 'pending') throw new LimsError('common.immutable_record');
    if (Number(q['version']) !== expectedVersion) throw new LimsError('common.version_conflict');
    const decided = await repo.decideRefundRequest(tx, {
      tenantId, refundRequestId: id, expectedVersion, status: 'rejected', decidedByMembershipId: membershipId, decidedAt: ctx.now(), decisionNote: decisionNote ?? null, ledgerEntryId: null, userId: actorId,
    });
    if (!decided) throw new LimsError('common.version_conflict');
    await activity(ctx, { action: 'refund_rejected', kind: 'refund_request', id, centreId: q['centre_id'], membershipId, details: { order_id: q['order_id'] } });
    return refundDto(decided, await names(ctx, [q['requested_by_membership_id'], membershipId]));
  }

  /** B10c: approver inbox, newest first. */
  async function listRefundRequests(ctx: BalanceCtx, rawQuery: unknown) {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(rawQuery) ? rawQuery : {};
    const limit = limitOf(q['limit']);
    const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], '-created_at', 'time');
    const status = q['status'];
    if (status !== undefined && (typeof status !== 'string' || !REQUEST_STATUSES.includes(status))) throw bad('/status');
    const orderId = q['order_id'] === undefined ? undefined : uuid(q['order_id'], '/order_id');
    const rows = await repo.pageRefundRequests(tx, {
      tenantId, limit: limit + 1, ...(after === undefined ? {} : { after: { value: String(after.value), id: after.id } }),
      ...(status === undefined ? {} : { status }), ...(orderId === undefined ? {} : { orderId }),
    });
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    const page: { limit: number; next_cursor?: string } = { limit };
    if (rows.length > limit && last) page.next_cursor = encodeCursor('-created_at', iso(last['created_at']), String(last['id']));
    const display = await names(ctx, data.flatMap((r) => [r['requested_by_membership_id'], r['decided_by_membership_id']]));
    const out = [];
    // ponytail: one lookup per approved row (at most `limit` <= 200); join in SQL if the inbox is ever read in bulk.
    for (const r of data) {
      const le = typeof r['ledger_entry_id'] === 'string' ? await repo.getLedgerEntry(tx, { tenantId, entryId: r['ledger_entry_id'] }) : undefined;
      out.push(refundDto(r, display, le ? ledgerEntryDto(le, display) : undefined));
    }
    return { data: out, page };
  }

  /** B36 list. */
  async function listFinanceReviewItems(ctx: BalanceCtx, rawQuery: unknown) {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(rawQuery) ? rawQuery : {};
    const limit = limitOf(q['limit']);
    const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], '-created_at', 'time');
    const status = q['status'];
    if (status !== undefined && (typeof status !== 'string' || !ITEM_STATUSES.includes(status))) throw bad('/status');
    const rows = await repo.pageFinanceReviewItems(tx, {
      tenantId, limit: limit + 1, ...(after === undefined ? {} : { after: { value: String(after.value), id: after.id } }), ...(status === undefined ? {} : { status }),
    });
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    const page: { limit: number; next_cursor?: string } = { limit };
    if (rows.length > limit && last) page.next_cursor = encodeCursor('-created_at', iso(last['created_at']), String(last['id']));
    const display = await names(ctx, data.map((r) => r['resolved_by']));
    return { data: data.map((r) => itemDto(r, display)), page };
  }

  /** B36 resolve: closes the work item only. Money moves through B10/B10a; the balance is not touched. */
  async function resolveFinanceReviewItem(ctx: BalanceCtx, raw: unknown) {
    const { tx, tenantId, actorId, membershipId } = member(ctx);
    const i = isRec(raw) ? raw : {};
    const id = uuid(i['itemId'], '/itemId');
    const expectedVersion = versionOf(i['expectedVersion']);
    const code = i['resolutionCode'];
    if (typeof code !== 'string' || !RESOLUTIONS.includes(code)) throw bad('/resolutionCode');
    const note = optText(i['note'], '/note', 500);
    const refundId = i['refundLedgerEntryId'] === undefined ? undefined : uuid(i['refundLedgerEntryId'], '/refundLedgerEntryId');
    if (refundId !== undefined && code !== 'refunded') throw bad('/refundLedgerEntryId');

    const item = await repo.getFinanceReviewItem(tx, { tenantId, itemId: id });
    if (!item) throw new LimsError('common.not_found');
    if (item['status'] !== 'open') throw new LimsError('common.immutable_record');
    if (Number(item['version']) !== expectedVersion) throw new LimsError('common.version_conflict');
    if (refundId !== undefined) {
      const e = await repo.getLedgerEntry(tx, { tenantId, entryId: refundId }); // tenant-scoped: another tenant's row is simply absent
      if (!e || e['entry_kind'] !== 'refund' || e['order_id'] !== item['order_id']) throw bad('/refundLedgerEntryId');
    }
    const row = await repo.resolveFinanceReviewItem(tx, {
      tenantId, itemId: id, expectedVersion, resolutionCode: code, note: note ?? null, refundLedgerEntryId: refundId ?? null, resolvedAt: ctx.now(), membershipId, userId: actorId,
    });
    if (!row) throw new LimsError('common.version_conflict');
    await activity(ctx, { action: 'finance_review_resolved', kind: 'finance_review_item', id, centreId: item['centre_id'], membershipId, details: { order_id: item['order_id'], resolution_code: code } });
    return itemDto({ ...row, resolved_by: membershipId }, await names(ctx, [membershipId])); // resolved_by is a membership id ([CONV], refundRequests.repo.ts)
  }

  return { requestRefund, approveRefund, rejectRefund, listRefundRequests, listFinanceReviewItems, resolveFinanceReviewItem };
}
export type RefundService = ReturnType<typeof createRefundService>;

/** paid - (invoiced - credited): what was received beyond what is still owed (TRD §6.5). `paid` is the signed ledger sum, earlier refunds and reversals included. */
function refundable(t: { invoiced_paisa: string; paid_paisa: string; credited_paisa: string }): number {
  return toPaisa(t.paid_paisa) - (toPaisa(t.invoiced_paisa) - toPaisa(t.credited_paisa));
}
