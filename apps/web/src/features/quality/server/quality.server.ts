import 'server-only';
// C9 T-21 reads (BFF). Permission is checked BEFORE any API call; only whitelisted, well-formed search params reach the API (07-SECURITY);
// the Bearer token comes from the session inside serverFetch and never leaves the server (REQ-SEC-068).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import type { CodeOption, LjChart, ListPage, RunDetail, RunSummary, StatusRow, UnassignedObservation } from '../types';
import { UNASSIGNED_STATUSES } from '../format';

type SP = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

/** Comma list of distinct allowed values (order kept); undefined when nothing valid is left. */
function enumList(v: string | undefined, allowed: readonly string[]): string | undefined {
  const l = [...new Set((v ?? '').split(',').filter((x) => allowed.includes(x)))];
  return l.length ? l.join(',') : undefined;
}
function put(q: URLSearchParams, k: string, v: string | undefined) {
  if (v !== undefined) q.set(k, v);
}
const uuid = (v: string | undefined) => (v && UUID.test(v) ? v : undefined);
const bool = (v: string | undefined) => (v === 'true' || v === 'false' ? v : undefined);
const iso = (v: string | undefined) => (v && ISO_UTC.test(v) ? v : undefined);
const cursor = (v: string | undefined) => (v && CURSOR.test(v) ? v : undefined);

export const RUN_STATUSES = ['collecting', 'evaluated', 'closed'] as const;
export const OUTCOMES = ['accepted', 'accepted_warning', 'incomplete', 'rejected'] as const;
export const QC_STATUSES = ['in_control', 'warning', 'out_of_control', 'no_qc_data'] as const;

export function statusQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  put(q, 'instrument_id', uuid(first(sp['instrument_id'])));
  put(q, 'status', enumList(first(sp['status']), QC_STATUSES));
  put(q, 'overdue_only', bool(first(sp['overdue_only'])));
  q.set('limit', '200'); // the board lists every plan pair (one row per plan, max 200 per page)
  return q;
}

export function runsQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  for (const k of ['plan_id', 'instrument_id', 'analyte_id']) put(q, k, uuid(first(sp[k])));
  put(q, 'status', enumList(first(sp['status']), RUN_STATUSES));
  put(q, 'outcome', enumList(first(sp['outcome']), OUTCOMES));
  put(q, 'needs_action', bool(first(sp['needs_action'])));
  put(q, 'run_at_from', iso(first(sp['run_at_from'])));
  put(q, 'run_at_to', iso(first(sp['run_at_to'])));
  put(q, 'cursor', cursor(first(sp['cursor'])));
  q.set('sort', '-run_at'); // the only sort the API offers
  q.set('limit', '50');
  return q;
}

export function observationsQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  put(q, 'instrument_id', uuid(first(sp['instrument_id'])));
  // only the unassigned statuses: "assigned" and "excluded" never belong on this screen
  q.set('status', enumList(first(sp['status']), UNASSIGNED_STATUSES) ?? UNASSIGNED_STATUSES.join(','));
  put(q, 'observed_at_from', iso(first(sp['observed_at_from'])));
  put(q, 'observed_at_to', iso(first(sp['observed_at_to'])));
  put(q, 'cursor', cursor(first(sp['cursor'])));
  q.set('limit', '50');
  return q;
}

const DAY = 86_400_000;
const MAX_DAYS = 400; // 04-UI-UX §2.4
/** LJ query: plan_id is required (undefined = no request). Without a level the one-level view cannot be asked for, so it falls back to all levels. */
export function ljQuery(sp: SP): { query: URLSearchParams; view: 'level' | 'z' } | undefined {
  const plan = uuid(first(sp['plan_id']));
  if (!plan) return undefined;
  const level = uuid(first(sp['level_id']));
  const view = first(sp['view']) === 'z' || !level ? 'z' : 'level';
  const q = new URLSearchParams({ plan_id: plan, view });
  if (view === 'level' && level) q.set('level_id', level);
  put(q, 'lot_id', uuid(first(sp['lot_id'])));
  const fromRaw = first(sp['from']);
  const toRaw = first(sp['to']);
  const to = toRaw && ISO_DATE.test(toRaw) && !Number.isNaN(Date.parse(toRaw)) ? Date.parse(toRaw) : undefined;
  let from = fromRaw && ISO_DATE.test(fromRaw) && !Number.isNaN(Date.parse(fromRaw)) ? Date.parse(fromRaw) : Date.now() - 30 * DAY;
  if (to !== undefined && to - from > MAX_DAYS * DAY) from = to - MAX_DAYS * DAY;
  q.set('observed_at_from', new Date(from).toISOString());
  if (to !== undefined) q.set('observed_at_to', `${new Date(to).toISOString().slice(0, 10)}T23:59:59.999Z`);
  return { query: q, view };
}

export type Gate = 'denied' | 'disabled';
export const READ = 'quality.qc_run.read';
export const REVIEW = 'quality.qc_run.review';
export const MANAGE = 'quality.qc.manage';

export async function permissions(): Promise<readonly string[]> {
  return (await getShellSession())?.actor.permissions ?? [];
}
export const isFeatureDisabled = (e: unknown) => e instanceof ApiError && e.problem.code === 'common.feature_disabled';

/** Runs `load` only when the session holds `quality.qc_run.read`. A switched-off module is a normal state, anything else rethrows to error.tsx. */
export async function gated<T>(load: (perms: readonly string[]) => Promise<T>): Promise<{ gate: Gate } | { perms: readonly string[]; data: T }> {
  const perms = await permissions();
  if (!perms.includes(READ)) return { gate: 'denied' };
  try {
    return { perms, data: await load(perms) };
  } catch (e) {
    if (isFeatureDisabled(e)) return { gate: 'disabled' };
    throw e;
  }
}

interface Page<T> { data: T[]; page?: { next_cursor?: string } }
const api = <T>(path: string, q: URLSearchParams) => serverFetch<T>(`/v1/quality/${path}?${q.toString()}`);
const paged = <T>(p: Page<T>): ListPage<T> => ({ rows: Array.isArray(p?.data) ? p.data : [], ...(p?.page?.next_cursor ? { next: p.page.next_cursor } : {}) });

export const getStatusBoard = async (q: URLSearchParams) => paged(await api<Page<StatusRow>>('qc-status', q)).rows;
export const getRuns = async (q: URLSearchParams) => paged(await api<Page<RunSummary>>('qc-runs', q));
export const getUnassigned = async (q: URLSearchParams) => paged(await api<Page<UnassignedObservation>>('qc-observations', q));
export const getRun = (id: string) => serverFetch<RunDetail>(`/v1/quality/qc-runs/${id}`);
export const getLjChart = (q: URLSearchParams) => api<LjChart>('lj-chart', q);

/** Coded sets (quality.corrective_actions, quality.exclusion_reasons). A failed read yields an empty list: the form then cannot be submitted, the page stays usable. */
export async function getCodedSet(set: 'corrective_actions' | 'exclusion_reasons'): Promise<CodeOption[]> {
  try {
    const r = await serverFetch<{ data: { code: string; display: string; is_active: boolean }[] }>(`/v1/quality/coded-sets/${set}`);
    return (Array.isArray(r?.data) ? r.data : []).map((c) => ({ code: c.code, display: c.display, isActive: c.is_active }));
  } catch {
    return [];
  }
}

/** Secondary read: instrument label and analyte code for one plan (the run and chart DTOs carry ids only). Never breaks the page. */
export async function planLabel(planId: string, instrumentId?: string): Promise<{ instrument: string; analyte: string } | undefined> {
  try {
    const q = new URLSearchParams({ limit: '200' });
    put(q, 'instrument_id', uuid(instrumentId));
    const row = (await getStatusBoard(q)).find((r) => r.plan_id === planId);
    return row ? { instrument: row.instrument_label, analyte: row.analyte_code } : undefined;
  } catch {
    return undefined;
  }
}
/** Plans for the LJ plan picker (same read as the board). */
export async function planOptions(): Promise<StatusRow[]> {
  try {
    return await getStatusBoard(new URLSearchParams({ limit: '200' }));
  } catch {
    return [];
  }
}
