import 'server-only';
// T0D-ACCT-1 (LD-313, founder blanket authority LD-310): BFF reads and writes for the lab accounting screens (contracts/openapi/billing.yaml,
// T0C-ACCT-1 operations). Ledger entries are append only (LD-313 b): this file only POSTs entries and reversals, never PUT/PATCH/DELETE them.
// Every write sends Idempotency-Key; master edits send If-Match. Query values are validated by shape before they leave the BFF.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { FY_RE, ISO_DATE_RE, UUID_RE } from './types';

export type PartyKind = 'credit_party' | 'franchise' | 'user_pocket' | 'laboratory';
export const PARTY_KINDS: readonly PartyKind[] = ['credit_party', 'franchise', 'user_pocket', 'laboratory'];
export type EntryType = 'credit' | 'debit';
/** T0C-FINCTRL-1 (LD-321): 'held' = on hold, left out of posted balances until released. */
export type EntryStatus = 'submitted' | 'approved' | 'rejected' | 'reversed' | 'held';
export type GroupNature = 'income' | 'expense' | 'asset' | 'liability';

export interface AccountGroup { id: string; code: string; name: string; nature: GroupNature; is_active: boolean; version: number; created_at: string; updated_at: string }
export interface AccountParticular { id: string; account_group_id: string; code: string; name: string; is_active: boolean; version: number }
export interface AccountLedgerEntry {
  id: string; centre_id: string; party_kind: PartyKind; party_id: string; entry_date: string; account_particular_id: string; entry_type: EntryType; amount_paisa: number;
  payment_mode: string; bank_name?: string | undefined; reference_no?: string | undefined; payment_details?: string | undefined; comments?: string | undefined; status: EntryStatus;
  reverses_entry_id?: string | undefined; receipt_no: string; created_by: string; last_modified_by: string; created_at: string;
  /** T0C-FINCTRL-1 (LD-321): hold trail and the B.S. fiscal year label set by the server. */
  held_reason?: string | undefined; held_by?: string | undefined; held_at?: string | undefined; released_by?: string | undefined; released_at?: string | undefined; fiscal_year_label?: string | undefined;
}
export interface AccountStatementRow { entry_id: string; entry_date: string; receipt_no: string; entry_type: EntryType; account_particular_id: string; status: EntryStatus; reverses_entry_id?: string; credit_paisa: number; debit_paisa: number; balance_paisa: number; balance_side: EntryType }
export interface AccountStatement {
  party_kind: PartyKind; party_id: string; from: string; to: string; opening_balance_paisa: number; opening_balance_side: EntryType; rows: AccountStatementRow[];
  closing_balance_paisa: number; closing_balance_side: EntryType; total_credit_paisa: number; total_debit_paisa: number;
}
export interface AccountSummary { party_kind: PartyKind; party_id: string; credit_limit_paisa: number; outstanding_paisa: number; outstanding_side: EntryType; is_blocked: boolean }
/** A party as the screens show it (joined from credit parties, centres, users). */
type Opt = string | undefined;
export interface AccountParty { id: string; kind: PartyKind; name: string; centre_name?: Opt; franchise_name?: Opt; address?: Opt; joined_on?: Opt; contact_person?: Opt; phone?: Opt; email?: Opt; pan?: Opt }
export interface Named { id: string; name: string }
export interface CreateEntryInput {
  centre_id: string; party_kind: PartyKind; party_id: string; entry_date: string; account_particular_id: string; entry_type: EntryType; amount_paisa: number; payment_mode: string;
  bank_name?: string; reference_no?: string; payment_details?: string; comments?: string;
}
export interface EntryFilters { centre_id?: string; party_kind?: string; party_id?: string; account_particular_id?: string; entry_type?: string; status?: string; entry_date_from?: string; entry_date_to?: string; fiscal_year_label?: string; cursor?: string }

const bad = () => new ApiError(400, problem('common.validation_failed', 'Validation failed', 400));
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CODE_RE = /^[A-Z0-9_]{1,32}$/;
const MODE_RE = /^[a-z][a-z0-9_]{0,49}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;
const id = (v: string) => {
  if (!UUID_RE.test(v)) throw bad();
  return v;
};
const FILTER_CHECKS: Record<string, RegExp> = {
  centre_id: UUID_RE, party_id: UUID_RE, account_particular_id: UUID_RE, party_kind: /^(credit_party|franchise|user_pocket|laboratory)$/, entry_type: /^(credit|debit)$/,
  status: /^(submitted|approved|rejected|reversed|held)$/, fiscal_year_label: FY_RE, entry_date_from: ISO_DATE_RE, entry_date_to: ISO_DATE_RE, from: ISO_DATE_RE, to: ISO_DATE_RE, cursor: CURSOR_RE, account_group_id: UUID_RE,
};
function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    const s = String(v);
    const re = FILTER_CHECKS[k];
    if (re && !re.test(s)) throw bad();
    p.set(k, s);
  }
  const out = p.toString();
  return out ? `?${out}` : '';
}
/** Drops invalid URL values instead of failing the whole page (a hand-edited URL shows the unfiltered list). */
export function cleanFilters(sp: Record<string, string | string[] | undefined>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = sp[k];
    if (typeof v === 'string' && v && (!FILTER_CHECKS[k] || FILTER_CHECKS[k]!.test(v))) out[k] = v;
  }
  return out;
}

/** URL from/to when valid, else the current month up to today in Asia/Kathmandu (UTC+05:45, no DST). */
export function dateRange(sp: Record<string, string | string[] | undefined>, now = Date.now()): { from: string; to: string } {
  const today = new Date(now + 345 * 60_000).toISOString().slice(0, 10);
  const pick = (k: string) => (typeof sp[k] === 'string' && ISO_DATE_RE.test(sp[k] as string) ? (sp[k] as string) : undefined);
  const from = pick('from') ?? `${today.slice(0, 8)}01`;
  const to = pick('to') ?? today;
  return from <= to ? { from, to } : { from: to, to: from };
}

type Page<T> ={ data: T[]; page?: { next_cursor?: string | null } };
const data = <T,>(p: Promise<Page<T>>) => p.then((r) => r.data ?? []);
/** Lookup lists for names: a missing permission on a neighbour module shows ids as a dash, never a broken page. */
const soft = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);

export const listAccountGroups = () => data(serverFetch<Page<AccountGroup>>('/v1/billing/account-groups?limit=200'));
export const listAccountParticulars = () => data(serverFetch<Page<AccountParticular>>('/v1/billing/account-particulars?limit=200'));
export function listAccountLedgerEntries(f: EntryFilters = {}) {
  return serverFetch<Page<AccountLedgerEntry>>(`/v1/billing/account-ledger-entries${qs({ ...f, limit: 200 })}`);
}
export function getAccountStatement(q: { party_kind: PartyKind; party_id: string; from: string; to: string }) {
  return serverFetch<AccountStatement>(`/v1/billing/account-statement${qs(q)}`);
}
export function getAccountSummary(q: { party_kind: PartyKind; party_id: string }) {
  return serverFetch<AccountSummary>(`/v1/billing/account-summary${qs(q)}`);
}

/** LD-358 AccountSummaryRow: every AccountSummary field plus the party name. */
export interface AccountSummaryRow extends AccountSummary { party_name: string }
/** T0D-UILIST-2 (LD-358): ONE list read, operation listAccountSummaries (GET /v1/billing/account-summaries).
 *  T0D-BUILD-1 (LD-447): the five contract filters, cursor paging (50 a page). Every value is checked by shape here; a bad one is dropped, never forwarded. */
export interface SummaryFilters { party_kind?: PartyKind | undefined; q?: string | undefined; blocked_only?: boolean | undefined; outstanding_only?: boolean | undefined; cursor?: string | undefined }
export const SUMMARY_PAGE = 50;
/** URL search params -> filters the API accepts (arrays, unknown kinds, non "true" switches and odd cursors dropped; q trimmed and cut to 80). */
export function summaryFilters(sp: Record<string, string | string[] | undefined>): SummaryFilters {
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const kind = one('party_kind');
  const q = one('q')?.trim().slice(0, 80);
  const cursor = one('cursor');
  return {
    ...(kind && (PARTY_KINDS as readonly string[]).includes(kind) ? { party_kind: kind as PartyKind } : {}),
    ...(q ? { q } : {}),
    ...(one('blocked_only') === 'true' ? { blocked_only: true } : {}),
    ...(one('outstanding_only') === 'true' ? { outstanding_only: true } : {}),
    ...(cursor && CURSOR_RE.test(cursor) ? { cursor } : {}),
  };
}
export function listAccountSummaryRows(f: SummaryFilters = {}) {
  const { blocked_only, outstanding_only, ...rest } = f;
  return serverFetch<Page<AccountSummaryRow>>(`/v1/billing/account-summaries${qs({ ...rest, ...(blocked_only ? { blocked_only: 'true' } : {}), ...(outstanding_only ? { outstanding_only: 'true' } : {}), limit: SUMMARY_PAGE })}`);
}

type CentreRow ={ centre_id?: string; id?: string; name: string; kind?: string; centre_kind?: string; address?: string; phone?: string; email?: string; created_at?: string };
type UserRow = { membership_id?: string; id?: string; display_name?: string };
type CreditPartyRow = { id: string; name: string; credit_limit_paisa?: number; address?: string; contact_person?: string; phone?: string; email?: string; pan?: string; created_at?: string };
const centreId = (c: CentreRow) => (c.centre_id ?? c.id) as string;

export const listCentres = () => soft(data(serverFetch<Page<CentreRow>>('/v1/identity/centres' /* LD-446: listCentres has no limit */)));
export const listMembers = (): Promise<Named[]> =>
  soft(data(serverFetch<Page<UserRow>>('/v1/identity/users?status=active&limit=200')).then((r) => r.filter((u) => u.membership_id ?? u.id).map((u) => ({ id: (u.membership_id ?? u.id) as string, name: u.display_name ?? '—' }))));

/** Client = billing credit party; franchise = a centre of kind franchise (T0B-ACCT-1 accounts.repo party tables). */
export async function listAccountParties(members: readonly Named[] = []): Promise<{ parties: AccountParty[]; centres: Named[] }> {
  const [centres, credit] = await Promise.all([listCentres(), soft(data(serverFetch<Page<CreditPartyRow>>('/v1/billing/credit-parties?limit=200')))]);
  const kindOf = (c: CentreRow) => c.kind ?? c.centre_kind;
  const lab = centres.find((c) => kindOf(c) !== 'franchise');
  const opt = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')) as T;
  const parties: AccountParty[] = [
    ...credit.map((p) => opt({ id: p.id, kind: 'credit_party' as const, name: p.name, centre_name: lab?.name, address: p.address, joined_on: p.created_at?.slice(0, 10), contact_person: p.contact_person, phone: p.phone, email: p.email, pan: p.pan })),
    ...centres.filter((c) => kindOf(c) === 'franchise').map((c) => opt({ id: centreId(c), kind: 'franchise' as const, name: c.name, franchise_name: c.name, address: c.address, joined_on: c.created_at?.slice(0, 10), phone: c.phone, email: c.email })),
    ...members.map((m) => ({ id: m.id, kind: 'user_pocket' as const, name: m.name })),
  ];
  return { parties, centres: centres.filter((c) => kindOf(c) !== 'franchise').map((c) => ({ id: centreId(c), name: c.name })) };
}

/** One summary per client and franchise (getAccountSummary is per party, rate tier `general`: 10 req/s, burst 20, 02-CONVENTIONS §10.3).
 *  At most 5 requests in flight; refused parties are counted in `failed`, a list cut at 200 sets `truncated` (T0D-ACCT-1 review item 1).
 *  ponytail: N calls per page view; a list endpoint for summaries is the real fix (CR for T0C/T0B). */
export async function listAccountSummaries(parties: readonly AccountParty[]): Promise<{ summaries: AccountSummary[]; failed: number; truncated: boolean }> {
  const eligible = parties.filter((p) => p.kind === 'credit_party' || p.kind === 'franchise');
  const todo = eligible.slice(0, 200);
  const rows: (AccountSummary | null)[] = new Array(todo.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const i = next++;
      const p = todo[i]!;
      // Review round 2 item 2: 429 common.rate_limited waits 1000 ms (ApiError has no Retry-After) and retries, max 3 attempts.
      for (let attempt = 1; ; attempt++) {
        try { rows[i] = await getAccountSummary({ party_kind: p.kind, party_id: p.id }); break; } catch (e) {
          if (!(e instanceof ApiError && e.status === 429) || attempt >= 3) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, todo.length) }, worker));
  const summaries = rows.filter((r): r is AccountSummary => r !== null);
  return { summaries, failed: todo.length - summaries.length, truncated: eligible.length > todo.length };
}

function send<T>(method: 'POST' | 'PATCH', path: string, body: unknown, key: string, version?: number): Promise<T> {
  if (!KEY_RE.test(key)) throw bad();
  return serverFetch<T>(path, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...(version !== undefined ? { 'if-match': `"${version}"` } : {}) },
    body: JSON.stringify(body),
  });
}

export function createAccountLedgerEntry(e: CreateEntryInput, key: string) {
  const ok = UUID_RE.test(e.centre_id) && UUID_RE.test(e.party_id) && UUID_RE.test(e.account_particular_id) && PARTY_KINDS.includes(e.party_kind) && ISO_DATE_RE.test(e.entry_date)
    && (e.entry_type === 'credit' || e.entry_type === 'debit') && Number.isSafeInteger(e.amount_paisa) && e.amount_paisa >= 1 && MODE_RE.test(e.payment_mode);
  if (!ok) throw bad();
  return send<AccountLedgerEntry>('POST', '/v1/billing/account-ledger-entries', e, key);
}
export function reverseAccountLedgerEntry(entryId: string, reasonText: string, key: string) {
  if (!reasonText.trim() || reasonText.length > 500) throw bad();
  return send<AccountLedgerEntry>('POST', `/v1/billing/account-ledger-entries/${id(entryId)}/reverse`, { reason_text: reasonText }, key);
}
/** T0C-FINCTRL-1 holdLedgerEntry / releaseLedgerEntry (billing.account.manage; contract body {reason}, 1-500 characters). */
export function holdAccountLedgerEntry(entryId: string, action: 'hold' | 'release', reason: string, key: string) {
  if ((action !== 'hold' && action !== 'release') || !reason.trim() || reason.length > 500) throw bad();
  const base = `/v1/billing/account-ledger-entries/${id(entryId)}`;
  return send<AccountLedgerEntry>('POST', action === 'hold' ? `${base}/hold` : `${base}/release`, { reason }, key);
}
export function createAccountGroup(g: { code: string; name: string; nature: GroupNature }, key: string) {
  if (!CODE_RE.test(g.code) || !g.name.trim() || g.name.length > 200 || !['income', 'expense', 'asset', 'liability'].includes(g.nature)) throw bad();
  return send<AccountGroup>('POST', '/v1/billing/account-groups', g, key);
}
export function createAccountParticular(p: { account_group_id: string; code: string; name: string }, key: string) {
  if (!UUID_RE.test(p.account_group_id) || !CODE_RE.test(p.code) || !p.name.trim() || p.name.length > 200) throw bad();
  return send<AccountParticular>('POST', '/v1/billing/account-particulars', p, key);
}
/** Code, nature and group are immutable after create (contract); only name and is_active are sent. */
export function updateAccountMaster(kind: 'group' | 'particular', masterId: string, version: number, patch: { name?: string; is_active?: boolean }, key: string) {
  const body = { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.is_active !== undefined ? { is_active: patch.is_active } : {}) };
  if (!Object.keys(body).length || (body.name !== undefined && (!body.name.trim() || body.name.length > 200)) || !Number.isInteger(version)) throw bad();
  return send<unknown>('PATCH', `/v1/billing/${kind === 'group' ? 'account-groups' : 'account-particulars'}/${id(masterId)}`, body, key, version);
}
