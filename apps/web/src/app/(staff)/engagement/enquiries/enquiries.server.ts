import 'server-only';
// W11 BFF: N1 listEnquiries, N2 getEnquiry, N3 replyEnquiry (Idempotency-Key + If-Match "<version>"), N4 closeEnquiry (If-Match). The JWT stays server-side (serverFetch).
// Enquiry text is P3: it travels only in the POST body, never in a URL, a log line or browser storage.
import { serverFetch } from '@/core/api/server-fetch';

export interface EnquirySummary { id: string; category_code: string; subject: string; status: string; profile_id?: string; last_message_at: string; version: number }
export interface EnquiryMessage { author_kind: 'patient' | 'staff'; body: string; created_at: string }
export interface StaffEnquiry extends EnquirySummary { patient_id?: string; messages: EnquiryMessage[] }

const BASE = '/v1/engagement/enquiries';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STATUSES = ['open', 'answered', 'closed'] as const;
const json = { 'content-type': 'application/json' };

type SP = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Validated N1 query: only a known status and a well-formed cursor reach the API. */
export function enquiriesQuery(sp: SP): URLSearchParams {
  const q = new URLSearchParams();
  const status = first(sp['status']);
  if ((STATUSES as readonly string[]).includes(status ?? '')) q.set('status', status!);
  const cursor = first(sp['cursor']);
  if (cursor && cursor.length <= 512 && /^[A-Za-z0-9_-]+$/.test(cursor)) q.set('cursor', cursor);
  q.set('limit', '50');
  return q;
}

/** T3a listEngagementCodedSet: tenant topics (seed + cs_enquiry_categories overrides). */
export const listEnquiryCategories = async () => {
  const r = await serverFetch<{ data: { code: string; display: string }[] }>('/v1/engagement/coded-sets/enquiry_categories');
  return (Array.isArray(r?.data) ? r.data : []).map(({ code, display }) => ({ code, display }));
};

export const listEnquiries = (q: URLSearchParams) => serverFetch<{ data: EnquirySummary[]; page?: { next_cursor?: string } }>(`${BASE}?${q.toString()}`);
export const getEnquiry = (id: string) => {
  if (!UUID_RE.test(id)) throw new Error('invalid enquiry id'); // last line of defence against path injection
  return serverFetch<StaffEnquiry>(`${BASE}/${id}`);
};
export const replyEnquiry = (id: string, version: number, message: string, key: string) => {
  if (!UUID_RE.test(id)) throw new Error('invalid enquiry id');
  return serverFetch<StaffEnquiry>(`${BASE}/${id}/messages`, { method: 'POST', headers: { ...json, 'idempotency-key': key, 'if-match': `"${Math.trunc(version)}"` }, body: JSON.stringify({ message }) });
};
export const closeEnquiry = (id: string, version: number) => {
  if (!UUID_RE.test(id)) throw new Error('invalid enquiry id');
  return serverFetch<StaffEnquiry>(`${BASE}/${id}/close`, { method: 'POST', headers: { ...json, 'if-match': `"${Math.trunc(version)}"` }, body: '{}' });
};
