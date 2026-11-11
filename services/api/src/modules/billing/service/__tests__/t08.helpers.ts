// BL-T08 test helpers (not a test file): the BL-T06 world (real core event publisher, in-memory invoices/balances, counter fake) + ledger and cash-session state.
// ASSUMED repo seams added by BL-T08 (all (tx, args), tenantId in args; rows snake_case like node-pg returns them; bigint columns as strings; writer: dispute if wrong):
//   repo.lockOrderBalance(tx,{tenantId,orderId})                    -> void   (SELECT ... FOR UPDATE on billing.order_balances; TRD §6.5 / §12 lock order: BEFORE the RC counter)
//   repo.getPaymentMethod(tx,{tenantId,code})                       -> {code,is_cash,requires_reference,is_active} | undefined  (tenant cs_payment_methods over global g_cs_payment_methods)
//   repo.findLedgerByIdempotencyKey(tx,{tenantId,idempotencyKey})   -> ledger row | undefined
//   repo.findInvoiceForPayment(tx,{tenantId,invoiceId})             -> {id,order_id,status} | undefined
//   repo.insertLedgerEntry(tx, NewLedgerEntry + {receiptNo?,receiptSeq?,cashSessionId?,referenceText?,capturedAtDevice?}) -> ledger row  (ledger.repo.ts today lacks those five fields)
//   repo.findOpenCashSession(tx,{tenantId,membershipId,centreId})   -> session row | undefined
//   repo.insertCashSession(tx,{id,tenantId,branchId,centreId,membershipId,openedAt,userId}) -> session row  (23505 cash_sessions__tenant_id_open__p_uq when one is open already)
//   repo.getCashSession(tx,{tenantId,sessionId})                    -> existing cashSessions.repo.ts
//   repo.sumLedgerBySession(tx,{tenantId,sessionId})                -> [{method_code, amount_paisa:string}]  (signed sum per method: payments, reversals, refunds)
//   repo.closeCashSession(tx,{tenantId,sessionId,expectedVersion,expected,counted,variancePaisa,note,closedAt,userId}) -> row | undefined  (undefined = version moved / not open)
//   (findOpenCashSession without centreId = any centre: B17 "current" has no centre parameter)
//   plus the BL-T06 seams (readOrderTotals is replaced here by a ledger-aware one: paid = signed sum of ledger rows of the order; it also returns branch_id = the order's invoice branch).
// Synthetic data only.
import { pgError } from '../../../../core/events/__tests__/helpers.js';
import { createBillingEvents } from '../../events/publish.js';
import { createBalanceService } from '../balance.service.js';
import { BASE, IDS, makeWorld, TENANT_A, V7, type WorldOpts } from './t06.helpers.js';

export { BASE, FY_LONG, FY_SHORT, IDS, MEMBERSHIP, money, npr, REQ_ID, TENANT_A, USER, V7, rejection, errCode } from './t06.helpers.js';
export const OTHER_MEMBER = V7('000000030099');
export const OTHER_TENANT = '0190a000-0000-7000-8000-0000000000ff';
export const INVOICE = V7('000000a00001');
export const BL = (n: number) => V7(`0000000c${String(n).padStart(4, '0')}`);

export const METHODS: Record<string, { code: string; is_cash: boolean; requires_reference: boolean; is_active: boolean }> = {
  cash: { code: 'cash', is_cash: true, requires_reference: false, is_active: true },
  card: { code: 'card', is_cash: false, requires_reference: true, is_active: true },
  wallet: { code: 'wallet', is_cash: false, requires_reference: true, is_active: true },
  old_cheque: { code: 'old_cheque', is_cash: false, requires_reference: false, is_active: false },
};

export interface LedgerOpts extends WorldOpts {
  /** net of the order's registration invoice in paisa; null = the order has no invoice. Default 225000 (NPR 2,250.00). */
  invoiceNet?: number | null;
  billingMode?: 'cash' | 'credit';
  methods?: typeof METHODS;
}

export function makeLedgerWorld(opts: LedgerOpts = {}) {
  const w = makeWorld({
    ...opts,
    tenantSettings: { numbering: { invoiceNoPattern: '{fy}-{seq:6}', receiptNoPattern: 'RC-{fy}-{seq:6}' }, ...(opts.tenantSettings ?? {}) },
  });
  const st = w.s as any;
  st.ledger = []; st.sessions = []; st.locks = [];
  const L = (): any[] => (w.s as any).ledger;
  const S = (): any[] => (w.s as any).sessions;
  const methods = opts.methods ?? METHODS;
  let clock = 0;
  const stamp = () => new Date(Date.parse(BASE) + ++clock * 1000).toISOString();
  const rec = (name: string, a: any) => {
    if (typeof a?.tenantId !== 'string') throw new Error(`fake repo: ${name} called without a tenant id`);
    w.repoCalls.push({ name, args: a });
  };
  const invoiceNet = opts.invoiceNet === undefined ? 225000 : opts.invoiceNet;
  if (invoiceNet !== null) w.s.invoices.push({ id: INVOICE, tenant_id: TENANT_A, order_id: IDS.order, net_paisa: invoiceNet, purpose: 'registration', status: 'issued' });

  const r: any = w.repo;
  r.readOrderTotals = async (_tx: unknown, a: any) => {
    rec('readOrderTotals', a);
    const inv = w.s.invoices.filter((i: any) => i.tenant_id === a.tenantId && i.order_id === a.orderId);
    const led = L().filter((e) => e.tenant_id === a.tenantId && e.order_id === a.orderId);
    if (inv.length === 0 && led.length === 0) return undefined;
    return {
      invoiced_paisa: String(inv.reduce((t: number, i: any) => t + Number(i.net_paisa), 0)), paid_paisa: String(led.reduce((t, e) => t + e.amount_paisa, 0)), credited_paisa: '0',
      issued_invoice_count: inv.length, centre_id: IDS.centre, branch_id: IDS.branch, billing_mode: opts.billingMode ?? 'cash',
    };
  };
  r.lockOrderBalance = async (_tx: unknown, a: any) => { rec('lockOrderBalance', a); (w.s as any).locks.push(a.orderId); };
  r.getPaymentMethod = async (_tx: unknown, a: any) => { rec('getPaymentMethod', a); return methods[a.code]; };
  r.findLedgerByIdempotencyKey = async (_tx: unknown, a: any) => {
    rec('findLedgerByIdempotencyKey', a);
    return L().find((e) => e.tenant_id === a.tenantId && e.idempotency_key === a.idempotencyKey);
  };
  r.findInvoiceForPayment = async (_tx: unknown, a: any) => {
    rec('findInvoiceForPayment', a);
    const i = w.s.invoices.find((x: any) => x.tenant_id === a.tenantId && x.id === a.invoiceId);
    return i ? { id: i.id, order_id: i.order_id, status: i.status } : undefined;
  };
  r.insertLedgerEntry = async (_tx: unknown, e: any) => {
    rec('insertLedgerEntry', e);
    // models the 05-SCHEMA CHECK / UNIQUE constraints the service must never rely on to be correct, but that must hold in the end
    if (e.entryKind === 'payment' && !(e.amountPaisa > 0)) throw pgError('23514', 'violates check constraint "ledger_entries__sign__ck"');
    if (e.referenceText != null && (e.referenceText.length > 100 || /[0-9]{13,19}/.test(e.referenceText))) throw pgError('23514', 'violates check constraint "ledger_entries__ref__ck"');
    if ((e.captureKind === 'gateway') !== (e.collectedByMembershipId == null)) throw pgError('23514', 'violates check constraint "ledger_entries__collector__ck"');
    if (e.idempotencyKey != null && L().some((x) => x.tenant_id === e.tenantId && x.idempotency_key === e.idempotencyKey)) throw pgError('23505', 'duplicate key "ledger_entries__tenant_id_idem__p_uq"');
    if (e.receiptSeq != null && L().some((x) => x.tenant_id === e.tenantId && x.fiscal_year_bs === e.fiscalYearBs && x.receipt_seq === e.receiptSeq)) throw pgError('23505', 'duplicate key "ledger_entries__tenant_id_receipt__p_uq"');
    const row = {
      id: e.id, tenant_id: e.tenantId, branch_id: e.branchId, centre_id: e.centreId, order_id: e.orderId, invoice_id: e.invoiceId, entry_kind: e.entryKind, capture_kind: e.captureKind,
      method_code: e.methodCode, amount_paisa: e.amountPaisa, fiscal_year_bs: e.fiscalYearBs, business_date: e.businessDate, collected_by_membership_id: e.collectedByMembershipId,
      cash_session_id: e.cashSessionId ?? null, reference_text: e.referenceText ?? null, receipt_no: e.receiptNo ?? null, receipt_seq: e.receiptSeq ?? null,
      idempotency_key: e.idempotencyKey ?? null, captured_at_device: e.capturedAtDevice ?? null, created_by: e.userId, created_at: stamp(),
    };
    L().push(row); return structuredClone(row);
  };
  r.findOpenCashSession = async (_tx: unknown, a: any) => {
    rec('findOpenCashSession', a);
    return S().find((s) => s.tenant_id === a.tenantId && s.membership_id === a.membershipId && (a.centreId === undefined || s.centre_id === a.centreId) && s.status === 'open');
  };
  r.insertCashSession = async (_tx: unknown, a: any) => {
    rec('insertCashSession', a);
    if (S().some((s) => s.tenant_id === a.tenantId && s.membership_id === a.membershipId && s.centre_id === a.centreId && s.status === 'open')) {
      throw Object.assign(pgError('23505', 'duplicate key "cash_sessions__tenant_id_open__p_uq"'), { constraint: 'cash_sessions__tenant_id_open__p_uq' });
    }
    const row = { id: a.id, tenant_id: a.tenantId, branch_id: a.branchId, centre_id: a.centreId, membership_id: a.membershipId, status: 'open', opened_at: a.openedAt, closed_at: null,
      expected: null, counted: null, variance_paisa: null, close_note: null, version: 1, is_active: true, created_by: a.userId, updated_by: a.userId };
    S().push(row); return structuredClone(row);
  };
  r.getCashSession = async (_tx: unknown, a: any) => { rec('getCashSession', a); const s = S().find((x) => x.tenant_id === a.tenantId && x.id === a.sessionId); return s && structuredClone(s); };
  r.sumLedgerBySession = async (_tx: unknown, a: any) => {
    rec('sumLedgerBySession', a);
    const sums = new Map<string, number>();
    for (const e of L()) if (e.tenant_id === a.tenantId && e.cash_session_id === a.sessionId) sums.set(e.method_code, (sums.get(e.method_code) ?? 0) + e.amount_paisa);
    return [...sums].map(([method_code, v]) => ({ method_code, amount_paisa: String(v) }));
  };
  r.closeCashSession = async (_tx: unknown, a: any) => {
    rec('closeCashSession', a);
    const s = S().find((x) => x.tenant_id === a.tenantId && x.id === a.sessionId);
    if (!s || s.status !== 'open' || s.version !== a.expectedVersion) return undefined;
    Object.assign(s, { status: 'closed', closed_at: a.closedAt, expected: a.expected, counted: a.counted, variance_paisa: a.variancePaisa, close_note: a.note ?? null, version: s.version + 1, updated_by: a.userId });
    return structuredClone(s);
  };

  const balance = createBalanceService({ repo: w.repo as never, events: createBillingEvents(w.events) as never });
  const out = Object.assign(w, {
    ledger: L, sessions: S, ledgerEvents: createBillingEvents(w.events) as never,
    /** Mirrors what BL-T06 issue() leaves behind: balance row v1 (invoice_issued) so payments start at version 2. */
    async seedBalance() { if (invoiceNet !== null) await w.tx(() => balance.applyChange(w.ctx(), { orderId: IDS.order, cause: 'invoice_issued' })); },
    names: () => w.repoCalls.map((c) => c.name),
    balanceEvents: () => w.events_of('billing.balance.changed.v1').map((e) => e.envelope),
    /** Put a ledger row in directly (bypasses the service) for read/cash tests. */
    addLedger(row: Record<string, unknown>) { L().push({ tenant_id: TENANT_A, branch_id: IDS.branch, centre_id: IDS.centre, order_id: IDS.order, invoice_id: null, entry_kind: 'payment', capture_kind: 'manual',
      method_code: 'cash', amount_paisa: 1000, fiscal_year_bs: '2083/84', business_date: '2026-11-08', collected_by_membership_id: V7('000000030001'), cash_session_id: null, reference_text: null,
      receipt_no: null, receipt_seq: null, idempotency_key: null, created_by: V7('000000030001'), created_at: stamp(), ...row }); },
    addSession(row: Record<string, unknown>) { S().push({ tenant_id: TENANT_A, branch_id: IDS.branch, centre_id: IDS.centre, membership_id: V7('000000030001'), status: 'open', opened_at: BASE, closed_at: null,
      expected: null, counted: null, variance_paisa: null, close_note: null, version: 1, is_active: true, created_by: V7('000000030001'), updated_by: V7('000000030001'), ...row }); },
  });
  return out;
}
export type LedgerWorld = ReturnType<typeof makeLedgerWorld>;
