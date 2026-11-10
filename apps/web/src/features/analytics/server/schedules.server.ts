import 'server-only';
// #23-#27 report schedules (BFF). Reads: list (cursor pages of 20) and one schedule with its run log. Writes: create (Idempotency-Key), update and
// deactivate (If-Match "<version>"; 409 common.version_conflict / 428 are surfaced, never retried). Only ids that are uuids reach a path.
import { serverFetch } from '@/core/api/server-fetch';
import { UUID_RE } from '../report-codes';

export interface RunSummary { id: string; created_at: string; period?: { label_ad?: string; label_bs?: string } }
export interface Schedule {
  id: string; version: number; name: string; report_codes: string[]; frequency: string; weekday?: number; send_time_local: string; period_rule: string;
  scope: { all_centres: boolean; centre_ids?: string[] }; recipient_membership_ids: string[]; is_active: boolean; next_run_at?: string; owner_membership_id?: string;
}
export interface ScheduleDetail extends Schedule { runs: RunSummary[] }
export interface ScheduleInput {
  name: string; report_codes: string[]; frequency: string; weekday?: number; send_time_local: string; period_rule: string;
  scope: { all_centres: boolean; centre_ids?: string[] }; recipient_membership_ids: string[];
}

type SP = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const json = { 'content-type': 'application/json' };
const etag = (version: number) => `"${Math.trunc(version)}"`;

export function schedulesQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  const cursor = first(sp['cursor']);
  if (cursor && cursor.length <= 512 && /^[A-Za-z0-9_-]+$/.test(cursor)) q.set('cursor', cursor);
  q.set('limit', '20');
  return q;
}
export const listSchedules = (q: URLSearchParams) => serverFetch<{ data: Schedule[]; page?: { next_cursor?: string } }>(`/v1/analytics/schedules?${q.toString()}`);

const path = (id: string) => {
  if (!UUID_RE.test(id)) throw new Error('invalid schedule id'); // callers validate first; this is the last line of defence against path injection
  return `/v1/analytics/schedules/${id}`;
};
export const getSchedule = (id: string) => serverFetch<ScheduleDetail>(path(id));
export const createSchedule = (input: ScheduleInput, key: string) =>
  serverFetch<Schedule>('/v1/analytics/schedules', { method: 'POST', headers: { ...json, 'idempotency-key': key }, body: JSON.stringify(input) });
export const updateSchedule = (id: string, version: number, input: ScheduleInput) =>
  serverFetch<Schedule>(path(id), { method: 'PUT', headers: { ...json, 'if-match': etag(version) }, body: JSON.stringify(input) });
export const deactivateSchedule = (id: string, version: number) =>
  serverFetch<Schedule>(`${path(id)}/deactivate`, { method: 'POST', headers: { ...json, 'if-match': etag(version) }, body: '{}' });
