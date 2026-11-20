import 'server-only';
// T0D-ACCT-2 (LD-313, founder blanket authority LD-310): BFF reads and writes for Expense, Expense Type, Cash Transfer and the daily collection
// summary (contracts/openapi/billing.yaml, T0C-ACCT-1 operations). Expenses and transfers are never PUT/PATCHed or deleted (LD-313 b): an expense is
// cancelled with a reason, a transfer is accepted, rejected or cancelled. Only expense types are PATCHed, with If-Match. Every write sends
// Idempotency-Key; ids and dates are checked by shape (UUID_RE / ISO_DATE_RE) before they leave the BFF.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { ISO_DATE_RE, UUID_RE } from './types';

export interface ExpenseType { id: string; name: string; account_particular_id: string; is_active: boolean; version: number; created_at: string; updated_at: string }
export interface Expense {
  id: string; centre_id: string; expense_at: string; expense_type_id: string; amount_paisa: number; description?: string; ledger_entry_id?: string;
  cancelled_at?: string; cancel_reason_text?: string; version: number; created_by: string; created_at: string;
}
export type TransferKind = 'user' | 'centre';
export type TransferStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';
export interface CashTransfer {
  id: string; from_kind: TransferKind; from_id: string; to_kind: TransferKind; to_id: string; amount_paisa: number; status: TransferStatus; remark?: string;
  decided_by?: string; decided_at?: string; version: number; created_by: string; created_at: string;
}
export interface DailyCollectionSummary { centre_id: string; day: string; rows: { payment_mode: string; entry_count: number; total_paisa: number }[]; total_paisa: number }
export interface CreateExpenseInput { centre_id: string; expense_at: string; expense_type_id: string; amount_paisa: number; description?: string }
export interface CreateTransferInput { from_kind: TransferKind; from_id: string; to_kind: TransferKind; to_id: string; amount_paisa: number; remark?: string }
export interface PocketBalance { paisa: number; side: 'credit' | 'debit' }

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const KINDS: readonly string[] = ['user', 'centre'];
const id = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};
const amountOk = (p: number) => Number.isSafeInteger(p) && p >= 1;
const text = (v: string | undefined, max: number) => v === undefined || (v.trim().length > 0 && v.length <= max);

type Page<T> = { data: T[]; page?: { next_cursor?: string | null } };
const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1]));
  return p.toString() ? `?${p}` : '';
};

/** URL filters for the expense list; invalid values are dropped (a hand-edited URL shows the unfiltered list). from/to are Kathmandu days. */
export function expenseFilters(sp: Record<string, string | string[] | undefined>): { centre_id?: string; expense_type_id?: string; from?: string; to?: string } {
  const s = (k: string, re: RegExp) => (typeof sp[k] === 'string' && re.test(sp[k] as string) ? { [k]: sp[k] as string } : {});
  return { ...s('centre_id', UUID_RE), ...s('expense_type_id', UUID_RE), ...s('from', ISO_DATE_RE), ...s('to', ISO_DATE_RE) };
}
/** A Kathmandu day (UTC+05:45, no DST) as the UTC instant of its start. */
const nptStart = (day: string) => new Date(`${day}T00:00:00+05:45`).toISOString();
const nptEnd = (day: string) => new Date(Date.parse(`${day}T00:00:00+05:45`) + 86_400_000 - 1).toISOString();

/** ponytail: first 200 rows (API limit); cursor paging when a filter window holds more. Cancelled expenses are listed (with their reason). */
export function listExpenses(f: ReturnType<typeof expenseFilters> = {}) {
  return serverFetch<Page<Expense>>(`/v1/billing/expenses${qs({
    centre_id: f.centre_id, expense_type_id: f.expense_type_id, include_cancelled: 'true', limit: '200',
    expense_at_from: f.from && ISO_DATE_RE.test(f.from) ? nptStart(f.from) : undefined, expense_at_to: f.to && ISO_DATE_RE.test(f.to) ? nptEnd(f.to) : undefined,
  })}`).then((r) => r.data ?? []);
}
export function listExpenseTypes() {
  return serverFetch<Page<ExpenseType>>('/v1/billing/expense-types?limit=200').then((r) => r.data ?? []);
}

export type TransferTab = 'all' | 'sent' | 'received' | 'pending';
export const TRANSFER_TABS: readonly TransferTab[] = ['all', 'sent', 'received', 'pending'];
/** Tab -> API query. ponytail: "received" asks to_id = me, so transfers to my centre show under All and Pending only (the API has no "to me or my centres" filter). */
export function listCashTransfers(tab: TransferTab, me: string, f: { from_id?: string; to_id?: string } = {}) {
  const mine = UUID_RE.test(me) ? me : undefined;
  const q = { from_id: f.from_id, to_id: f.to_id, ...(tab === 'sent' ? { from_id: mine } : tab === 'received' ? { to_id: mine } : tab === 'pending' ? { status: 'pending' } : {}) };
  if ((q.from_id && !UUID_RE.test(q.from_id)) || (q.to_id && !UUID_RE.test(q.to_id))) throw bad();
  if ((tab === 'sent' || tab === 'received') && !mine) return Promise.resolve([] as CashTransfer[]);
  return serverFetch<Page<CashTransfer>>(`/v1/billing/cash-transfers${qs({ ...q, limit: '200' })}`).then((r) => r.data ?? []);
}

export function getDailyCollectionSummary(centreId: string, day: string) {
  if (!UUID_RE.test(centreId) || !ISO_DATE_RE.test(day)) throw bad();
  return serverFetch<DailyCollectionSummary>(`/v1/billing/daily-collection-summary${qs({ centre_id: centreId, day })}`);
}

/** Pocket of a user (membership id) or a centre (centre id): T0B-ACCT-2 keeps both as party_kind user_pocket. A credit side balance is cash held. */
export async function getPocketBalance(partyId: string): Promise<PocketBalance> {
  const s = await serverFetch<{ outstanding_paisa: number; outstanding_side: 'credit' | 'debit' }>(`/v1/billing/account-summary${qs({ party_kind: 'user_pocket', party_id: id(partyId) })}`);
  return { paisa: s.outstanding_paisa, side: s.outstanding_side };
}

function send<T>(method: 'POST' | 'PATCH', path: string, body: unknown, key: string, version?: number): Promise<T> {
  if (!KEY_RE.test(key)) throw bad();
  return serverFetch<T>(path, {
    method,
    headers: { 'idempotency-key': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(version !== undefined ? { 'if-match': `"${version}"` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

export function createExpense(e: CreateExpenseInput, key: string) {
  if (!UUID_RE.test(e.centre_id) || !UUID_RE.test(e.expense_type_id) || !UTC_RE.test(e.expense_at) || !amountOk(e.amount_paisa) || !text(e.description, 2000)) throw bad();
  return send<Expense>('POST', '/v1/billing/expenses', e, key);
}
export function cancelExpense(expenseId: string, reasonText: string, key: string) {
  if (!text(reasonText, 500)) throw bad();
  return send<Expense>('POST', `/v1/billing/expenses/${id(expenseId)}/cancel`, { reason_text: reasonText }, key);
}
export function createExpenseType(x: { name: string; account_particular_id: string }, key: string) {
  if (!text(x.name, 200) || !UUID_RE.test(x.account_particular_id)) throw bad();
  return send<ExpenseType>('POST', '/v1/billing/expense-types', x, key);
}
export function updateExpenseType(typeId: string, version: number, patch: { name?: string; account_particular_id?: string; is_active?: boolean }, key: string) {
  const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (!Object.keys(body).length || !text(patch.name, 200) || (patch.account_particular_id !== undefined && !UUID_RE.test(patch.account_particular_id)) || !Number.isInteger(version)) throw bad();
  return send<ExpenseType>('PATCH', `/v1/billing/expense-types/${id(typeId)}`, body, key, version);
}
export function createCashTransfer(x: CreateTransferInput, key: string) {
  const ok = KINDS.includes(x.from_kind) && KINDS.includes(x.to_kind) && UUID_RE.test(x.from_id) && UUID_RE.test(x.to_id) && x.from_id !== x.to_id && amountOk(x.amount_paisa) && text(x.remark, 1000);
  if (!ok) throw bad();
  return send<CashTransfer>('POST', '/v1/billing/cash-transfers', x, key);
}
/** The contract has no request body for accept, reject and cancel (accept posts the balanced pair server side, LD-313 b). */
export function decideCashTransfer(transferId: string, action: 'accept' | 'reject' | 'cancel', key: string) {
  const path = { accept: '/accept', reject: '/reject', cancel: '/cancel' }[action];
  if (!path) throw bad();
  return send<CashTransfer>('POST', `/v1/billing/cash-transfers/${id(transferId)}${path}`, undefined, key);
}
