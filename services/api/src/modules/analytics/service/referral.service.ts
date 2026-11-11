// Referral business report (02-TRD §5 #8, §6.4; PRD US-07.1–.5; D-44: the only report with net billed per referrer; 07-SECURITY P1, P4).
// Volume (daily_referrer_volume) and money (daily_referrer_billing) are read separately and merged here by canonical (rollup=canonical) or raw referrer id.
// Rows are built for the whole period, then paged in memory (keyset cursor); totals always cover the whole period.
import { adToBs, formatBs, type IsoDate, type IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { LimsError } from '../../../core/errors.js';
import { loadAnalyticsConfig } from '../config.js';
import { evaluateFreshness, type Freshness } from '../domain/freshness.js';
import type { Period } from '../domain/period.js';
import type { Scope } from '../domain/scope.js';
import * as refresh from '../repository/refresh.repo.js';
import * as rollups from '../repository/rollups.repo.js';
import { referrerLabels } from './labels.service.js';
import type { ReportsContext } from './reports.service.js';

export const REFERRAL_GROUP_BY = ['referrer', 'referrer_ad_month', 'referrer_bs_month'] as const;
export type ReferralGroupBy = (typeof REFERRAL_GROUP_BY)[number];

export interface ReferralRow {
  referrer_id?: string; label: string; is_self: boolean; period_key?: string; period_label?: string;
  orders: number; patient_visits: number; tests_ordered: number; net_billed_paisa?: number; // SELF has no net billed (US-07.2)
}
export interface ReferralTotals { orders: number; patient_visits: number; tests_ordered: number; net_billed_paisa: number }
const NUM = ['orders', 'patient_visits', 'tests_ordered', 'net_billed_paisa'] as const;
const FAMILIES = new Set(['referrer_volume', 'referrer_billing']);
const shortId = (id: string): string => id.slice(-8);

export async function referralIncentive(
  ctx: ReportsContext,
  a: { period: Period; scope: Scope; groupBy: ReferralGroupBy; rollup: 'canonical' | 'none'; referrerIds: readonly string[]; now: IsoUtc },
): Promise<{ rows: ReferralRow[]; totals: ReferralTotals; freshness: Freshness[] }> {
  const q = { tenantId: ctx.tenantId, from: a.period.from, to: a.period.to, scope: a.scope, grain: a.groupBy === 'referrer' ? ('total' as const) : ('day' as const) };
  const vol = await rollups.referrerVolumeRows(ctx.tx, q);
  const bill = await rollups.referrerBillingRows(ctx.tx, q);

  const rawIds = [...new Set([...vol, ...bill].flatMap((r) => (r.referrer_id ? [r.referrer_id] : [])))];
  let names = await referrerLabels(ctx, rawIds);
  const canonOf = (id: string) => (a.rollup === 'canonical' ? (names.get(id)?.canonicalId ?? id) : id);
  const missing = [...new Set(rawIds.map(canonOf))].filter((id) => !names.has(id)); // canonical target with no figures of its own
  if (missing.length) names = new Map([...names, ...(await referrerLabels(ctx, missing))]);

  const periodOf = (d: string | null | undefined): string =>
    a.groupBy === 'referrer' || !d ? '' : a.groupBy === 'referrer_ad_month' ? d.slice(0, 7) : formatBs(adToBs(d as IsoDate)).slice(0, 7);
  const groups = new Map<string, { period: string; id: string | null; v: Record<(typeof NUM)[number], number> }>();
  const add = (date: string | null | undefined, rawId: string | null, part: Partial<Record<(typeof NUM)[number], number>>) => {
    const period = periodOf(date), id = rawId === null ? null : canonOf(rawId), key = `${period}|${id ?? 'SELF'}`;
    const g = groups.get(key) ?? { period, id, v: { orders: 0, patient_visits: 0, tests_ordered: 0, net_billed_paisa: 0 } };
    for (const k of NUM) g.v[k] = safeSum(g.v[k], part[k] ?? 0, k);
    groups.set(key, g);
  };
  for (const r of vol) add(r.business_date, r.referrer_id, r);
  for (const r of bill) add(r.business_date, r.referrer_id, r);

  const wanted = new Set(a.referrerIds); // canonical id under rollup=canonical, raw id under none; SELF never matches a filter
  const rows: ReferralRow[] = [...groups.values()].filter((g) => wanted.size === 0 || (g.id !== null && wanted.has(g.id))).map((g) => ({
    ...(g.id === null ? {} : { referrer_id: g.id }),
    label: g.id === null ? 'SELF' : (names.get(g.id)?.displayName ?? shortId(g.id)),
    is_self: g.id === null,
    ...(g.period ? { period_key: g.period, period_label: a.groupBy === 'referrer_bs_month' ? `${g.period} B.S.` : g.period } : {}),
    orders: g.v.orders, patient_visits: g.v.patient_visits, tests_ordered: g.v.tests_ordered,
    ...(g.id === null ? {} : { net_billed_paisa: g.v.net_billed_paisa }),
  }));
  rows.sort((x, y) => (x.period_key ?? '').localeCompare(y.period_key ?? '') || y.orders - x.orders || x.label.localeCompare(y.label) || (x.referrer_id ?? '').localeCompare(y.referrer_id ?? ''));

  const totals: ReferralTotals = { orders: 0, patient_visits: 0, tests_ordered: 0, net_billed_paisa: 0 };
  for (const r of rows) for (const k of NUM) totals[k] = safeSum(totals[k], r[k] ?? 0, k);

  const cfg = loadAnalyticsConfig();
  const states = await refresh.loadFamilyStates(ctx.tx as never, { tenantId: ctx.tenantId });
  return { rows, totals, freshness: states.filter((s) => FAMILIES.has(s.family)).map((s) => evaluateFreshness(s, a.now, cfg)) };
}

function safeSum(x: number, y: number, what: string): number {
  const n = x + y;
  if (!Number.isSafeInteger(n)) throw new RangeError(`referral: ${what} total is not a safe integer`); // refused, never rounded
  return n;
}

// ------------------------------------------------------------------ paging (opaque keyset cursor)
export interface Cursor { sort_value: number; key: string }
const CURSOR_KEY = /^(?:[0-9]{4}-[0-9]{2})?\|(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|SELF)$/i;
const rowKey = (r: ReferralRow): string => `${r.period_key ?? ''}|${r.referrer_id ?? 'SELF'}`;

/** Strict decode; run before any read so a hostile cursor costs nothing. undefined = first page. */
export function decodeCursor(v: unknown): Cursor | undefined {
  if (v === undefined) return undefined;
  const bad = () => new LimsError('common.invalid_cursor');
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(v)) throw bad();
  let o: any;
  try { o = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')); } catch { throw bad(); }
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).sort().join() !== 'key,sort_value') throw bad();
  if (!Number.isSafeInteger(o.sort_value) || o.sort_value < 0 || typeof o.key !== 'string' || !CURSOR_KEY.test(o.key)) throw bad();
  return { sort_value: o.sort_value, key: o.key };
}

export function pageOf(rows: readonly ReferralRow[], limit: number, cursor: Cursor | undefined): { rows: ReferralRow[]; nextCursor?: string } {
  let start = 0;
  if (cursor) {
    const i = rows.findIndex((r) => rowKey(r) === cursor.key);
    if (i >= 0) start = i + 1;
    else { // row vanished since the last page: resume at the first row after its (period, orders) position
      // ponytail: rows tied on orders with the vanished row may be skipped; add label to the cursor if that matters
      const p = cursor.key.split('|')[0]!;
      const j = rows.findIndex((r) => (r.period_key ?? '') > p || ((r.period_key ?? '') === p && r.orders < cursor.sort_value));
      start = j < 0 ? rows.length : j;
    }
  }
  const slice = rows.slice(start, start + limit);
  const last = slice.at(-1);
  const more = start + limit < rows.length && last !== undefined;
  return { rows: slice, ...(more ? { nextCursor: Buffer.from(JSON.stringify({ sort_value: last.orders, key: rowKey(last) })).toString('base64url') } : {}) };
}
