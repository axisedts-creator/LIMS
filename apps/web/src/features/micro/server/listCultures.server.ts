import 'server-only';
// listCultures (GET /v1/micro/cultures) for the T-19 worklist. LD-140 (2026-11-13) applies to the screens; this file is BFF plumbing only.
// Every query value that reaches the API is whitelisted and validated here (REQ-SEC-026/027): the page never forwards raw searchParams,
// and never sends centre scoping of its own (centre limits are RLS, AC-02.3).
import { serverFetch } from '@/core/api/server-fetch';
import { TAB_IDS, UUID_RE, type CulturePage, type TabId } from './types';

type SearchParams = Record<string, string | string[] | undefined>;

export const PAGE_SIZE = 50;
export const DEFAULT_RECENT_DAYS = 7; // [CONV] recent_window_days default (settings)
/** 04-UI-UX §2 tab table. The "recent" tab has no count and adds updated_at_from. */
export const TAB_QUERY: Record<TabId, { status: string; sort: string }> = {
  setup: { status: 'awaiting_setup', sort: 'received_at' },
  incubating: { status: 'incubating', sort: 'next_read_due_at' },
  workup: { status: 'growth_detected', sort: 'next_read_due_at' },
  amending: { status: 'amending', sort: '-updated_at' },
  recent: { status: 'final_submitted,cancelled', sort: '-updated_at' },
};
export const COUNTED_TABS = ['setup', 'incubating', 'workup', 'amending'] as const satisfies readonly TabId[];

const SORTS = ['received_at', '-received_at', 'next_read_due_at', '-updated_at'] as const;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);
const isoUtc = (v: string | undefined) => (v !== undefined && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);
const bool = (v: string | undefined) => (v === 'true' || v === 'false' ? v : undefined);

export const parseTab = (v: string | string[] | undefined): TabId => (TAB_IDS as readonly string[]).includes(one(v) ?? '') ? (one(v) as TabId) : 'setup';

/** Validated filters only (no tab, sort, cursor, paging). Malformed values are dropped, never forwarded. */
export function worklistFilters(sp: SearchParams): URLSearchParams {
  const out = new URLSearchParams();
  const centre = one(sp['centre_id']);
  if (centre !== undefined && UUID_RE.test(centre)) out.set('centre_id', centre);
  const from = isoUtc(one(sp['received_at_from']));
  if (from) out.set('received_at_from', from);
  const to = isoUtc(one(sp['received_at_to']));
  if (to) out.set('received_at_to', to);
  const overdue = bool(one(sp['read_overdue']));
  if (overdue) out.set('read_overdue', overdue);
  const instr = bool(one(sp['has_open_instrument_records']));
  if (instr) out.set('has_open_instrument_records', instr);
  return out;
}

/** The main list call for the selected tab. `now` is injectable for tests. */
export function worklistQuery(tab: TabId, sp: SearchParams, recentWindowDays: number, now = Date.now()): URLSearchParams {
  const q = worklistFilters(sp);
  q.set('status', TAB_QUERY[tab].status);
  const sort = one(sp['sort']);
  q.set('sort', (SORTS as readonly (string | undefined)[]).includes(sort) ? (sort as string) : TAB_QUERY[tab].sort);
  q.set('include_total', 'true');
  q.set('limit', String(PAGE_SIZE));
  if (tab === 'recent') q.set('updated_at_from', new Date(now - recentWindowDays * 86_400_000).toISOString());
  const cursor = one(sp['cursor']);
  if (cursor !== undefined && CURSOR.test(cursor)) q.set('cursor', cursor);
  return q;
}

export const listCultures = async (q: URLSearchParams) => serverFetch<CulturePage>(`/v1/micro/cultures?${q.toString()}`);

/** Tab badge: limit=1&include_total=true so no row data is pulled. Any failure → undefined (badge omitted). */
export async function countCultures(tab: TabId, filters: URLSearchParams): Promise<number | undefined> {
  const q = new URLSearchParams(filters);
  q.set('status', TAB_QUERY[tab].status);
  q.set('include_total', 'true');
  q.set('limit', '1');
  try {
    return (await serverFetch<CulturePage>(`/v1/micro/cultures?${q.toString()}`)).page.total;
  } catch {
    return undefined;
  }
}
