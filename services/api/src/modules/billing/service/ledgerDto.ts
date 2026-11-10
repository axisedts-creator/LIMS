// Shared row -> DTO mapping for the ledger / cash-session services and reads (contracts/openapi/billing.yaml LedgerEntryDto, CashSessionDto). Pure except names().
import { adToBs, formatBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { LimsError } from '../../../core/errors.js';
import { moneyOf, toPaisa } from '../domain/money/paisa.js';
import { iso, present, STAFF_DISPLAY } from './invoiceRead.service.js';
import type { BalanceCtx } from './balance.service.js';

export const DEFAULT_TZ = 'Asia/Kathmandu';

/** Calendar date ('YYYY-MM-DD') of a UTC instant in the tenant time zone. */
export function localDate(instant: string, timezone: string): string {
  const t = new Date(instant);
  if (Number.isNaN(t.getTime())) throw new LimsError('common.internal');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p['year']}-${p['month']}-${p['day']}`;
}

/** 'YYYY-MM-DD' of a `date` column (a string, or the local-midnight Date node-postgres builds). */
export function dateText(v: unknown): string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${String(v.getFullYear()).padStart(4, '0')}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  throw new LimsError('common.internal');
}
export const bsText = (adDate: string): string => formatBs(adToBs(adDate as IsoDate));

/**
 * Display names: only the caller's own name is known (IdentityPort.getActor); everybody else gets the fixed label (same [CONV] as invoiceRead STAFF_DISPLAY).
 * A failing lookup never fails the request - the label is used instead.
 */
export async function names(ctx: BalanceCtx, ids: readonly unknown[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const own = ctx.actor.membershipId;
  const idp = ctx.ports?.IdentityPort as { getActor?: (c: unknown) => Promise<{ displayName?: unknown }> } | undefined;
  for (const id of new Set(ids.filter((x): x is string => typeof x === 'string'))) {
    let name = STAFF_DISPLAY;
    if (id === own && typeof idp?.getActor === 'function') {
      try { const a = await idp.getActor(ctx); if (typeof a?.displayName === 'string' && a.displayName.trim() !== '') name = a.displayName; } catch { /* label */ }
    }
    out.set(id, name);
  }
  return out;
}

export const ledgerEntryDto = (r: Record<string, any>, display: ReadonlyMap<string, string>) => present({
  id: r['id'], entry_kind: r['entry_kind'], capture_kind: r['capture_kind'], order_id: r['order_id'], invoice_id: r['invoice_id'], credit_party_id: r['credit_party_id'],
  method_code: r['method_code'], amount: moneyOf(toPaisa(r['amount_paisa'])), reference_masked: r['reference_text'], receipt_no: r['receipt_no'], reverses_entry_id: r['reverses_entry_id'],
  collected_by: typeof r['collected_by_membership_id'] === 'string'
    ? { membership_id: r['collected_by_membership_id'], display_name: display.get(r['collected_by_membership_id']) ?? STAFF_DISPLAY } : undefined,
  cash_session_id: r['cash_session_id'], created_at: iso(r['created_at']), business_date_bs: bsText(dateText(r['business_date'])),
});

export interface SessionRowIn { readonly method_code: string; readonly expected: number; readonly counted?: number }
/** CashSessionDto.rows: one per method, sorted; counted/variance only when the session was counted. */
export const sessionRows = (rows: readonly SessionRowIn[]) => [...rows].sort((a, b) => (a.method_code < b.method_code ? -1 : a.method_code > b.method_code ? 1 : 0)).map((r) => present({
  method_code: r.method_code, expected: moneyOf(r.expected),
  counted: r.counted === undefined ? undefined : moneyOf(r.counted), variance: r.counted === undefined ? undefined : moneyOf(r.counted - r.expected),
}));

/** jsonb [{method_code, amount_paisa}] (cash_sessions.expected / counted) -> map. */
export function jsonbAmounts(v: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (Array.isArray(v)) for (const e of v) if (e && typeof e.method_code === 'string') out.set(e.method_code, toPaisa(e.amount_paisa));
  return out;
}

export function cashSessionDto(s: Record<string, any>, display: ReadonlyMap<string, string>, liveExpected?: ReadonlyMap<string, number>) {
  const closed = s['status'] === 'closed';
  const expected = liveExpected ?? jsonbAmounts(s['expected']);
  const counted = closed ? jsonbAmounts(s['counted']) : undefined;
  const methods = new Set([...expected.keys(), ...(counted?.keys() ?? [])]);
  return present({
    id: s['id'], opened_by: { membership_id: s['membership_id'], display_name: display.get(String(s['membership_id'])) ?? STAFF_DISPLAY }, centre_id: s['centre_id'], status: s['status'],
    opened_at: iso(s['opened_at']), closed_at: closed && s['closed_at'] ? iso(s['closed_at']) : undefined,
    rows: sessionRows([...methods].map((m) => ({ method_code: m, expected: expected.get(m) ?? 0, ...(counted ? { counted: counted.get(m) ?? 0 } : {}) }))),
    note: s['close_note'], version: Number(s['version']),
  });
}
