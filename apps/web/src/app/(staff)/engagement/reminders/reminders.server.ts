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
// R1 takes instants only (YYYY-MM-DDTHH:MM:SS.sssZ). URL dates are Asia/Kathmandu calendar days.
const dayStart = (d: string) => new Date(`${d}T00:00:00.000+05:45`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999+05:45`).toISOString();

/** Validated R1 query. A missing or invalid range (reversed, > 92 calendar days inclusive, malformed) falls back to today-7 … today+60 (Asia/Kathmandu date). */
export function remindersQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  let f = first(sp['due_from']);
  let t = first(sp['due_to']);
  // 92 calendar days inclusive = 91-day difference; the end-of-day bound keeps to - from ≤ 92 d for the API.
  const ok = isDate(f) && isDate(t) && t >= f && (Date.parse(t) - Date.parse(f)) / DAY <= MAX_RANGE_DAYS - 1;
  if (!ok) {
    const today = Date.now() + 5.75 * 3_600_000;
    f = iso(today - 7 * DAY); t = iso(today + 60 * DAY);
  }
  q.set('due_from', dayStart(f!)); q.set('due_to', dayEnd(t!));
  const status = first(sp['status']);
  if ((STATUSES as readonly string[]).includes(status ?? '')) q.set('status', status!);
  // `kind` is not an R1 param (02-TRD R1); the page filters rows instead (CR .orchestra/cr/T-R2.md).
  const cursor = first(sp['cursor']);
  if (cursor && cursor.length <= 512 && /^[A-Za-z0-9_-]+$/.test(cursor)) q.set('cursor', cursor);
  q.set('limit', '50');
  return q;
}

/** Kind filter value from the URL, or undefined. */
export const kindFilter = (sp: SP) => { const k = first(sp['kind']); return (KINDS as readonly string[]).includes(k ?? '') ? k : undefined; };

/** T3a listEngagementCodedSet: tenant reason codes (seed + cs_reminder_reasons overrides). */
export const listReminderReasons = async () => {
  const r = await serverFetch<{ data: { code: string; display: string }[] }>('/v1/engagement/coded-sets/reminder_reasons');
  return (Array.isArray(r?.data) ? r.data : []).map(({ code, display }) => ({ code, display, isActive: true }));
};

export const listReminders = (q: URLSearchParams) => serverFetch<{ data: Reminder[]; page?: { next_cursor?: string } }>(`${BASE}?${q.toString()}`);
export const createReminder = (input: ReminderInput, key: string) =>
  serverFetch<Reminder>(BASE, { method: 'POST', headers: { ...json, 'idempotency-key': key }, body: JSON.stringify({ patient_id: input.patient_id, reason_code: input.reason_code, due_at: input.due_at }) });
export const cancelReminder = (id: string, version: number) => {
  if (!UUID_RE.test(id)) throw new Error('invalid reminder id'); // last line of defence against path injection
  return serverFetch<Reminder>(`${BASE}/${id}/cancel`, { method: 'POST', headers: { ...json, 'if-match': `"${Math.trunc(version)}"` }, body: '{}' });
};
