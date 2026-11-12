import 'server-only';
// W9 BFF: R1 listReminders, R2 createReminder (Idempotency-Key), R3 cancelReminder (If-Match "<version>"). The JWT stays server-side (serverFetch).
// Every query value is validated here before it reaches the API; only uuids reach a path.
import { serverFetch } from '@/core/api/server-fetch';

export interface Reminder {
  id: string; patient_id: string; patient_display?: string; kind: string; reason_code?: string; source: string;
  due_at: string; status: string; sent_at?: string; failure_code?: string; version: number;
}
export interface ReminderInput { patient_id: string; reason_code: string; due_at: string }

const BASE = '/v1/engagement/reminders';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STATUSES = ['scheduled', 'sent', 'suppressed', 'cancelled', 'failed'] as const;
export const KINDS = ['custom', 'follow_up', 'booking'] as const;
export const MAX_RANGE_DAYS = 92; // R1: due_from..due_to ≤ 92 d
const DAY = 86_400_000;
const json = { 'content-type': 'application/json' };

type SP = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Validated R1 query. A missing or invalid range (reversed, > 92 days, malformed) falls back to today-7 … today+60 (Asia/Kathmandu date). */
export function remindersQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  const f = first(sp['due_from']);
  const t = first(sp['due_to']);
  const ok = isDate(f) && isDate(t) && t >= f && (Date.parse(t) - Date.parse(f)) / DAY <= MAX_RANGE_DAYS;
  if (ok) { q.set('due_from', f); q.set('due_to', t); } else {
    const today = Date.now() + 5.75 * 3_600_000;
    q.set('due_from', iso(today - 7 * DAY)); q.set('due_to', iso(today + 60 * DAY));
  }
  const status = first(sp['status']);
  if ((STATUSES as readonly string[]).includes(status ?? '')) q.set('status', status!);
  const kind = first(sp['kind']);
  if ((KINDS as readonly string[]).includes(kind ?? '')) q.set('kind', kind!);
  const cursor = first(sp['cursor']);
  if (cursor && cursor.length <= 512 && /^[A-Za-z0-9_-]+$/.test(cursor)) q.set('cursor', cursor);
  q.set('limit', '50');
  return q;
}

export const listReminders = (q: URLSearchParams) => serverFetch<{ data: Reminder[]; page?: { next_cursor?: string } }>(`${BASE}?${q.toString()}`);
export const createReminder = (input: ReminderInput, key: string) =>
  serverFetch<Reminder>(BASE, { method: 'POST', headers: { ...json, 'idempotency-key': key }, body: JSON.stringify({ patient_id: input.patient_id, reason_code: input.reason_code, due_at: input.due_at }) });
export const cancelReminder = (id: string, version: number) => {
  if (!UUID_RE.test(id)) throw new Error('invalid reminder id'); // last line of defence against path injection
  return serverFetch<Reminder>(`${BASE}/${id}/cancel`, { method: 'POST', headers: { ...json, 'if-match': `"${Math.trunc(version)}"` }, body: '{}' });
};
