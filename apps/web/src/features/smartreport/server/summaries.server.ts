import 'server-only';
// SR-01 review queue reads (TRD §5 #27). Query values are whitelisted before they reach the API; the bearer token is added by serverFetch.
import { notFound } from 'next/navigation';
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';

export const READ = 'smartreport.summary.read';
export const STATUSES = ['draft', 'approved', 'rejected', 'superseded'] as const;
export interface SummaryItem {
  id: string; centre_id?: string; status: string; built_at?: string; health_score_band?: string;
  deranged_count?: number; critical_count?: number; registration_no?: string; patient_display_name?: string;
}
export interface SummaryList { data?: SummaryItem[]; page?: { next_cursor?: string } }
export interface Centre { centre_id: string; code?: string; name?: string }
type SP = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The queue filter as validated from the URL; anything unknown is dropped. */
export function queueFilter(sp: SP) {
  const status = [...new Set((first(sp['status']) ?? '').split(',').filter((s) => (STATUSES as readonly string[]).includes(s)))];
  const centre = first(sp['centre_id']);
  const cursor = first(sp['cursor']);
  return {
    status: status.length ? status : ['draft'],
    centreId: centre && UUID.test(centre) ? centre : undefined,
    hasCritical: first(sp['has_critical']) === 'true',
    sort: first(sp['sort']) === '-built_at' ? '-built_at' : 'built_at',
    cursor: cursor && cursor.length <= 512 && /^[A-Za-z0-9_-]+$/.test(cursor) ? cursor : undefined,
  };
}
export type QueueFilter = ReturnType<typeof queueFilter>;

/** notFound() unless the session holds smartreport.summary.read. Runs before any API call. */
export async function requireRead() {
  const perms = (await getShellSession())?.actor.permissions ?? [];
  if (!perms.includes(READ)) notFound();
  return perms;
}

export async function listSummaries(f: QueueFilter): Promise<SummaryList> {
  const q = new URLSearchParams({ status: f.status.join(','), sort: f.sort, limit: '50' });
  if (f.centreId) q.set('centre_id', f.centreId);
  if (f.hasCritical) q.set('has_critical', 'true');
  if (f.cursor) q.set('cursor', f.cursor);
  try {
    return await serverFetch<SummaryList>(`/v1/smartreport/summaries?${q.toString()}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) notFound(); // permission revoked mid-session: a refusal, never an empty table
    throw e;
  }
}

/** A failure is tolerated: the Centre column then shows "—". */
export const listCentres = (): Promise<Centre[]> =>
  serverFetch<{ data?: Centre[] }>('/v1/identity/centres').then((r) => (Array.isArray(r?.data) ? r.data : [])).catch(() => []);

/** True only when the flag is read and `smart_report` is not enabled; an unreadable flag shows no banner. */
export const smartReportOff = (): Promise<boolean> =>
  serverFetch<{ data?: { code: string; is_enabled: boolean }[] }>('/v1/identity/feature-flags')
    .then((r) => { const f = r?.data?.find((x) => x.code === 'smart_report'); return !!f && !f.is_enabled; })
    .catch(() => false);
