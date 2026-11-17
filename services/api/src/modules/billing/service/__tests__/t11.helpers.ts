// BL-T11 test helpers (not a test file): the BL-T08 ledger world + ledger corrections (B9), refund requests (B10/B10a/B10b/B10c) and finance review items (B36).
// ASSUMED repo seams added by BL-T11 (all (tx, args), tenantId in args; rows snake_case like node-pg returns them; bigint columns as strings or numbers; writer: dispute if wrong):
//   repo.getLedgerEntry(tx,{tenantId,entryId})                      -> ledger row | undefined
//   repo.findReversalOf(tx,{tenantId,entryId})                      -> the reversal row whose reverses_entry_id = entryId | undefined  (unique index ledger_entries__tenant_id_reverses__p_uq)
//   repo.insertLedgerEntry(tx, NewLedgerEntry + {reasonText?,approvedByMembershipId?,refundRequestId?,creditPartyId?,gateway?,gatewayTxnRef?,intentId?}) -> ledger row
//        (reversalGuard + refund CHECKs of 05-SCHEMA are modelled below; the service must satisfy them, never rely on them)
//   repo.insertRefundRequest(tx,row)                                -> row   (snake_case = billing.refund_requests columns; status 'pending', version 1)
//   repo.getRefundRequest(tx,{tenantId,refundRequestId})            -> row | undefined
//   repo.decideRefundRequest(tx,{tenantId,refundRequestId,expectedVersion,status,decidedByMembershipId,decidedAt,decisionNote,ledgerEntryId,userId}) -> row | undefined (undefined = version moved / not pending)
//   repo.pageRefundRequests(tx,{tenantId,status?,orderId?,after?:{value,id},limit}) -> rows newest first (created_at desc, id desc), keyset `after` = the last row of the previous page
//   repo.getFinanceReviewItem(tx,{tenantId,itemId})                 -> row | undefined
//   repo.pageFinanceReviewItems(tx,{tenantId,status?,after?:{value,id},limit}) -> rows, newest first
//   repo.resolveFinanceReviewItem(tx,{tenantId,itemId,expectedVersion,resolutionCode,note,refundLedgerEntryId,resolvedAt,userId}) -> row | undefined
//   plus the BL-T08 seams (lockOrderBalance, readOrderTotals, findOpenCashSession, insertCashSession, insertActivity, upsertOrderBalance ...). readOrderTotals is ledger-aware (paid = signed ledger sum) and
//   its credited_paisa is set with world.setCredited().
// Synthetic data only.
import { pgError } from '../../../../core/events/__tests__/helpers.js';
import { BASE, BL, IDS, INVOICE, makeLedgerWorld, MEMBERSHIP, OTHER_MEMBER, TENANT_A, V7, type LedgerOpts } from './t08.helpers.js';

export * from './t08.helpers.js';
export const F1 = MEMBERSHIP;            // finance user 1: requests refunds, reverses entries
export const F2 = OTHER_MEMBER;          // finance user 2: approves
export const F2_USER = V7('000000030002');
export const CASHIER = V7('000000030003');
export const REQ = (n: number) => V7(`0000000e${String(n).padStart(4, '0')}`);
export const REVIEW = (n: number) => V7(`0000000f${String(n).padStart(4, '0')}`);
export const SESSION = (n: number) => V7(`0000000d${String(n).padStart(4, '0')}`);

const stampOf = (ms: number) => new Date(Date.parse(BASE) + ms).toISOString();

export function makeRefundWorld(opts: LedgerOpts = {}) {
  const w = makeLedgerWorld(opts);
  const st = w.s as any;
  st.requests = []; st.reviewItems = []; st.credited = 0;
  const RQ = (): any[] => (w.s as any).requests;
  const RV = (): any[] => (w.s as any).reviewItems;
  const L = (): any[] => (w.s as any).ledger;
  const S = (): any[] => (w.s as any).sessions;
  const r: any = w.repo;
  let clock = 100000;
  const stamp = () => stampOf(++clock * 1000);
  const rec = (name: string, a: any) => {
    if (typeof a?.tenantId !== 'string' && typeof a?.tenant_id !== 'string') throw new Error(`fake repo: ${name} called without a tenant id`);
    w.repoCalls.push({ name, args: a });
  };
  const tenantOf = (a: any) => a.tenantId ?? a.tenant_id;

  // ---- order totals: credited is settable (a cancelled invoice is credited in full) ----
  const baseTotals = r.readOrderTotals;
  r.readOrderTotals = async (tx: unknown, a: any) => {
    const t = await baseTotals(tx, a);
    return t && { ...t, credited_paisa: String((w.s as any).credited) };
  };

  // ---- ledger ----
  r.getLedgerEntry = async (_tx: unknown, a: any) => { rec('getLedgerEntry', a); const e = L().find((x) => x.tenant_id === a.tenantId && x.id === a.entryId); return e && structuredClone(e); };
  r.findReversalOf = async (_tx: unknown, a: any) => { rec('findReversalOf', a); const e = L().find((x) => x.tenant_id === a.tenantId && x.reverses_entry_id === a.entryId); return e && structuredClone(e); };
  r.insertLedgerEntry = async (_tx: unknown, e: any) => {
    rec('insertLedgerEntry', e);
    const kind = e.entryKind;
    if (kind === 'payment' ? !(e.amountPaisa > 0) : !(e.amountPaisa < 0)) throw pgError('23514', 'violates check constraint "ledger_entries__sign__ck"');
    if ((kind === 'reversal') !== (e.reversesEntryId != null)) throw pgError('23514', 'violates check constraint "ledger_entries__reversal__ck"');
    if (kind !== 'payment' && e.reasonCode == null) throw pgError('23514', 'violates check constraint "ledger_entries__reason__ck"');
    if (kind === 'refund' && e.approvedByMembershipId == null) throw pgError('23514', 'violates check constraint "ledger_entries__refund_approver__ck"');
    if (e.refundRequestId != null && kind !== 'refund') throw pgError('23514', 'violates check constraint "ledger_entries__refund_request__ck"');
    if ((e.captureKind === 'gateway') !== (e.collectedByMembershipId == null)) throw pgError('23514', 'violates check constraint "ledger_entries__collector__ck"');
    if ((e.captureKind === 'gateway') !== (e.gateway != null && e.gatewayTxnRef != null && e.intentId != null)) throw pgError('23514', 'violates check constraint "ledger_entries__gateway__ck"');
    if (e.referenceText != null && (e.referenceText.length > 100 || /[0-9]{13,19}/.test(e.referenceText))) throw pgError('23514', 'violates check constraint "ledger_entries__ref__ck"');
    if (e.idempotencyKey != null && L().some((x) => x.tenant_id === e.tenantId && x.idempotency_key === e.idempotencyKey)) throw pgError('23505', 'duplicate key "ledger_entries__tenant_id_idem__p_uq"');
    if (e.receiptSeq != null && L().some((x) => x.tenant_id === e.tenantId && x.fiscal_year_bs === e.fiscalYearBs && x.receipt_seq === e.receiptSeq)) throw pgError('23505', 'duplicate key "ledger_entries__tenant_id_receipt__p_uq"');
    if (e.reversesEntryId != null && L().some((x) => x.tenant_id === e.tenantId && x.reverses_entry_id === e.reversesEntryId)) throw pgError('23505', 'duplicate key "ledger_entries__tenant_id_reverses__p_uq"');
    if (e.refundRequestId != null && L().some((x) => x.tenant_id === e.tenantId && x.refund_request_id === e.refundRequestId)) throw pgError('23505', 'duplicate key "ledger_entries__tenant_id_refund_request__p_uq"');
    if (kind === 'reversal') { // billing.ledger_reversal_guard (05-SCHEMA)
      const o = L().find((x) => x.tenant_id === e.tenantId && x.id === e.reversesEntryId);
      const copy = (x: any) => [x.capture_kind, x.method_code, x.gateway ?? null, x.gateway_txn_ref ?? null, x.intent_id ?? null, x.collected_by_membership_id ?? null, x.order_id ?? null, x.invoice_id ?? null, x.credit_party_id ?? null, x.branch_id, x.centre_id ?? null];
      const mine = [e.captureKind, e.methodCode, e.gateway ?? null, e.gatewayTxnRef ?? null, e.intentId ?? null, e.collectedByMembershipId ?? null, e.orderId ?? null, e.invoiceId ?? null, e.creditPartyId ?? null, e.branchId, e.centreId ?? null];
      if (!o || o.entry_kind !== 'payment' || e.amountPaisa !== -Number(o.amount_paisa) || JSON.stringify(copy(o)) !== JSON.stringify(mine)) throw Object.assign(pgError('P0001', 'reversal_mismatch'), { detail: 'billing.ledger_entries' });
      const orig = o.cash_session_id ? S().find((s) => s.id === o.cash_session_id && s.status === 'open') : undefined;
      const expected = orig ? orig.id : S().find((s) => s.tenant_id === e.tenantId && s.membership_id === e.approvedByMembershipId && s.centre_id === o.centre_id && s.status === 'open')?.id ?? null;
      if ((e.cashSessionId ?? null) !== expected) throw Object.assign(pgError('P0001', 'reversal_mismatch'), { detail: 'billing.ledger_entries' });
    }
    const row = {
      id: e.id, tenant_id: e.tenantId, branch_id: e.branchId, centre_id: e.centreId, order_id: e.orderId, invoice_id: e.invoiceId, credit_party_id: e.creditPartyId ?? null,
      entry_kind: kind, capture_kind: e.captureKind, method_code: e.methodCode, amount_paisa: e.amountPaisa, reverses_entry_id: e.reversesEntryId ?? null,
      reason_code: e.reasonCode ?? null, reason_text: e.reasonText ?? null, gateway: e.gateway ?? null, gateway_txn_ref: e.gatewayTxnRef ?? null, intent_id: e.intentId ?? null,
      fiscal_year_bs: e.fiscalYearBs, business_date: e.businessDate, collected_by_membership_id: e.collectedByMembershipId, approved_by_membership_id: e.approvedByMembershipId ?? null,
      refund_request_id: e.refundRequestId ?? null, cash_session_id: e.cashSessionId ?? null, reference_text: e.referenceText ?? null, receipt_no: e.receiptNo ?? null, receipt_seq: e.receiptSeq ?? null,
      idempotency_key: e.idempotencyKey ?? null, captured_at_device: e.capturedAtDevice ?? null, created_by: e.userId, created_at: stamp(),
    };
    L().push(row); return structuredClone(row);
  };

  // ---- refund requests ----
  r.insertRefundRequest = async (_tx: unknown, row: any) => {
    rec('insertRefundRequest', row);
    if (!(row.refund_amount_paisa >= 1 && row.refund_amount_paisa <= 9007199254740991)) throw pgError('23514', 'violates check constraint "refund_requests__amount__ck"');
    if (row.reference_text != null && (row.reference_text.length > 100 || /[0-9]{13,19}/.test(row.reference_text))) throw pgError('23514', 'violates check constraint "refund_requests__text__ck"');
    if (row.status !== 'pending') throw pgError('23514', 'violates check constraint "refund_requests__decision__ck"');
    const saved = { version: 1, is_active: true, decided_by_membership_id: null, decided_at: null, decision_note: null, ledger_entry_id: null, created_at: stamp(), updated_at: stamp(), ...structuredClone(row) };
    RQ().push(saved); return structuredClone(saved);
  };
  r.getRefundRequest = async (_tx: unknown, a: any) => { rec('getRefundRequest', a); const q = RQ().find((x) => x.tenant_id === a.tenantId && x.id === a.refundRequestId); return q && structuredClone(q); };
  r.decideRefundRequest = async (_tx: unknown, a: any) => {
    rec('decideRefundRequest', a);
    const q = RQ().find((x) => x.tenant_id === a.tenantId && x.id === a.refundRequestId);
    if (!q || q.status !== 'pending' || q.version !== a.expectedVersion) return undefined;
    if (a.status === 'approved' && a.decidedByMembershipId === q.requested_by_membership_id) throw pgError('23514', 'violates check constraint "refund_requests__two_person__ck"');
    if ((a.status === 'approved') !== (a.ledgerEntryId != null)) throw pgError('23514', 'violates check constraint "refund_requests__approved__ck"');
    Object.assign(q, { status: a.status, decided_by_membership_id: a.decidedByMembershipId, decided_at: a.decidedAt, decision_note: a.decisionNote ?? null, ledger_entry_id: a.ledgerEntryId ?? null, version: q.version + 1, updated_by: a.userId, updated_at: stamp() });
    return structuredClone(q);
  };
  const keyset = (rows: any[], a: any) => {
    const sorted = [...rows].sort((x, y) => (x.created_at === y.created_at ? (x.id < y.id ? 1 : -1) : x.created_at < y.created_at ? 1 : -1));
    const after = a.after ? sorted.filter((x) => x.created_at < a.after.value || (x.created_at === a.after.value && x.id < a.after.id)) : sorted;
    return after.slice(0, a.limit).map((x) => structuredClone(x));
  };
  r.pageRefundRequests = async (_tx: unknown, a: any) => {
    rec('pageRefundRequests', a);
    return keyset(RQ().filter((x) => x.tenant_id === a.tenantId && (a.status === undefined || x.status === a.status) && (a.orderId === undefined || x.order_id === a.orderId)), a);
  };

  // ---- finance review items (B36) ----
  r.getFinanceReviewItem = async (_tx: unknown, a: any) => { rec('getFinanceReviewItem', a); const x = RV().find((i) => i.tenant_id === a.tenantId && i.id === a.itemId); return x && structuredClone(x); };
  r.pageFinanceReviewItems = async (_tx: unknown, a: any) => {
    rec('pageFinanceReviewItems', a);
    return keyset(RV().filter((x) => x.tenant_id === a.tenantId && (a.status === undefined || x.status === a.status)), a);
  };
  r.resolveFinanceReviewItem = async (_tx: unknown, a: any) => {
    rec('resolveFinanceReviewItem', a);
    const x = RV().find((i) => i.tenant_id === a.tenantId && i.id === a.itemId);
    if (!x || x.status !== 'open' || x.version !== a.expectedVersion) return undefined;
    Object.assign(x, { status: 'resolved', resolution_code: a.resolutionCode, note: a.note ?? null, refund_ledger_entry_id: a.refundLedgerEntryId ?? null, resolved_at: a.resolvedAt, resolved_by: a.userId, version: x.version + 1, updated_by: a.userId });
    return structuredClone(x);
  };

  return Object.assign(w, {
    requests: RQ, reviewItems: RV,
    setCredited(n: number) { (w.s as any).credited = n; },
    /** A payment row put straight into the ledger (bypasses the service). Returns its id. */
    seedPayment(n: number, over: Record<string, unknown> = {}): string {
      const id = BL(n);
      w.addLedger({ id, invoice_id: INVOICE, amount_paisa: 225000, ...over });
      return id;
    },
    /** A refund request row (default: pending, 2,250.00 cash, requested by F1). Returns its id. */
    seedRequest(n: number, over: Record<string, unknown> = {}): string {
      const id = REQ(n);
      RQ().push({ id, tenant_id: TENANT_A, branch_id: IDS.branch, centre_id: IDS.centre, order_id: IDS.order, method_code: 'cash', refund_amount_paisa: 225000, reason_code: 'SYN_REASON',
        reason_text: null, reference_text: null, status: 'pending', requested_by_membership_id: F1, decided_by_membership_id: null, decided_at: null, decision_note: null, ledger_entry_id: null,
        version: 1, is_active: true, created_at: stampOf(n * 1000), created_by: V7('000000030001'), updated_at: stampOf(n * 1000), updated_by: V7('000000030001'), ...over });
      return id;
    },
    seedReviewItem(n: number, over: Record<string, unknown> = {}): string {
      const id = REVIEW(n);
      RV().push({ id, tenant_id: TENANT_A, centre_id: IDS.centre, order_id: IDS.order, kind: 'home_payment_exceeds_due', ledger_entry_id: BL(1), amount_paisa: 50000, status: 'open', resolution_code: null,
        note: null, refund_ledger_entry_id: null, resolved_at: null, resolved_by: null, version: 1, is_active: true, created_at: stampOf(n * 1000), created_by: V7('000000030001'),
        updated_at: stampOf(n * 1000), updated_by: V7('000000030001'), ...over });
      return id;
    },
    /** ctx for finance user 2 (the approver). */
    ctxF2: (over: Record<string, unknown> = {}) => w.ctx({ actor: { type: 'user', id: F2_USER, membershipId: F2 }, ...over }),
    ledgerOf: (kind: string) => L().filter((e) => e.entry_kind === kind),
    activityOf: (action: string) => (w.s as any).activity.filter((a: any) => a.action === action),
    writes: (from = 0) => w.names().slice(from).filter((x: string) => ['insertLedgerEntry', 'insertCashSession', 'insertActivity', 'upsertOrderBalance', 'insertRefundRequest', 'decideRefundRequest', 'resolveFinanceReviewItem'].includes(x)),
  });
}
export type RefundWorld = ReturnType<typeof makeRefundWorld>;
