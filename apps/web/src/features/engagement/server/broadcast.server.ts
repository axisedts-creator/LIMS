import 'server-only';
// T0D-MSGDESK-1 (LD-321, LD-310): BFF reads of the message screens (engagement.yaml, live since T0B-MSGDESK-1):
//   listBroadcastTemplates, listBroadcasts, listBroadcastRecipients; plus the signed-in user id for the second person rule.
// Only known filter values reach a query string, only a uuid reaches a path; lists are paged (50 a page, the recipient history 200).
// Addresses are masked by the API on read; they are masked again here so a full phone or e-mail never reaches the browser.
import { serverFetch } from '@/core/api/server-fetch';
import { getAccessToken } from '@/core/session/server';
import { UUID_RE } from '@/features/partners/server/types';

export interface Page<T> { data: T[]; page: { limit: number; next_cursor?: string } }
export type Channel = 'sms' | 'whatsapp' | 'email';
export type PartyKind = 'laboratory' | 'franchise' | 'client' | 'lab_user';
export type BroadcastStatus = 'draft' | 'pending_approval' | 'approved' | 'sending' | 'sent' | 'cancelled';
export interface BroadcastTemplate { id: string; name: string; channel: Channel; subject?: string; body: string; placeholders: string[]; is_active: boolean; version: number; created_at: string; updated_at: string }
export interface AudienceFilter { party_kinds: PartyKind[]; city?: string; priority?: string; active_only?: boolean }
export interface Broadcast {
  id: string; template_id: string; audience_filter: AudienceFilter; status: BroadcastStatus; recipient_count: number; opted_out_count: number;
  requested_by: string; approved_by?: string; approved_at?: string; created_at: string; updated_at: string; version: number;
}
export interface BroadcastRecipient { id: string; broadcast_id: string; party_kind: PartyKind; party_id: string; channel_address: string; status: 'queued' | 'sent' | 'failed' | 'skipped'; skip_reason?: 'opted_out' | 'no_address'; outbox_id?: string }
export interface AudienceSample { party_kind: PartyKind; party_id: string; channel_address: string }

export const PARTY_KINDS: readonly PartyKind[] = ['laboratory', 'franchise', 'client', 'lab_user'];
export const CHANNELS: readonly Channel[] = ['sms', 'whatsapp', 'email'];
export const STATUSES: readonly BroadcastStatus[] = ['draft', 'pending_approval', 'approved', 'sending', 'sent', 'cancelled'];
export const LIST_LIMIT = 50;
const CURSOR = /^[A-Za-z0-9_\-=.~+/]{1,512}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const cursor = (v: string | undefined) => (v && CURSOR.test(v) ? v : undefined);

function qs(f: Record<string, string | undefined>, limit = LIST_LIMIT) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  p.set('limit', String(limit));
  return `?${p}`;
}

/** A phone keeps its first 6 and last 3 characters, an e-mail its first letter and domain; a value the API already masked (has *) stays. */
export function mask(v: string): string {
  if (v.includes('*')) return v;
  const at = v.indexOf('@');
  if (at > 0) return `${v[0]}***${v.slice(at)}`;
  return v.length > 9 ? `${v.slice(0, 6)}****${v.slice(-3)}` : '****';
}

/** Templates for the list (filters ?channel, ?is_active) and, unfiltered, the names and active choices of the broadcasts screen (one page of 200). */
export function listBroadcastTemplates(q: { channel?: string | undefined; is_active?: string | undefined; cursor?: string | undefined } = {}, limit = LIST_LIMIT) {
  const channel = CHANNELS.includes(q.channel as Channel) ? q.channel : undefined;
  const is_active = q.is_active === 'true' || q.is_active === 'false' ? q.is_active : undefined;
  return serverFetch<Page<BroadcastTemplate>>(`/v1/engagement/broadcast-templates${qs({ channel, is_active, cursor: cursor(q.cursor) }, limit)}`);
}

export function listBroadcasts(q: { status?: string | undefined; cursor?: string | undefined }) {
  const status = STATUSES.includes(q.status as BroadcastStatus) ? q.status : undefined;
  return serverFetch<Page<Broadcast>>(`/v1/engagement/broadcasts${qs({ status, cursor: cursor(q.cursor) })}`);
}

/** ponytail: the newest 200 recipients, no paging of the history; add a history cursor when a broadcast needs more. */
export async function listBroadcastRecipients(broadcastId: string) {
  if (!isUuid(broadcastId)) throw new Error('bad broadcast id');
  const r = await serverFetch<Page<BroadcastRecipient>>(`/v1/engagement/broadcasts/${broadcastId}/recipients?limit=200`);
  return { ...r, data: r.data.map((x) => ({ ...x, channel_address: mask(x.channel_address) })) };
}

/** The signed-in user id (JWT `sub` of the access token the server already holds); the API stores requested_by / approved_by as this id. */
export async function currentUserId(): Promise<string | undefined> {
  const token = await getAccessToken();
  const part = token?.split('.')[1];
  if (!part) return undefined;
  try {
    const sub = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { sub?: unknown }).sub;
    return isUuid(sub) ? sub : undefined;
  } catch {
    return undefined;
  }
}
