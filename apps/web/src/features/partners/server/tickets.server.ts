import 'server-only';
// T0D-MSGDESK-1 (LD-321): BFF reads of the lab side Ticket Inbox (partners.yaml listPartnerTickets, getPartnerTicket; live since T0B-MSGDESK-1).
// ElabAssist "Message To Laboratory". Only status, party_id, created_from, created_to and a cursor reach the query (limit 50); only a uuid reaches a path.
import { serverFetch } from '@/core/api/server-fetch';
import { isUuid } from './sales.server';
import type { Page } from './types';

export type TicketStatus = 'new' | 'replied' | 'closed';
export interface PartnerTicket {
  id: string; party_kind: 'partner'; party_id: string; subject: string; status: TicketStatus; created_by: string;
  created_at: string; updated_at: string; last_message_at?: string; version: number;
}
export interface PartnerTicketMessage { id: string; ticket_id: string; sender_kind: 'partner' | 'lab'; body: string; created_by: string; created_at: string }
export interface PartnerTicketDetail { ticket: PartnerTicket; messages: PartnerTicketMessage[] }
export interface TicketFilter { status?: string | undefined; party_id?: string | undefined; created_from?: string | undefined; created_to?: string | undefined }

export const TICKET_STATUSES: readonly TicketStatus[] = ['new', 'replied', 'closed'];
const CURSOR = /^[A-Za-z0-9_\-=.~+/]{1,512}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The filters the inbox may forward; anything else (or a malformed value) is dropped. */
export function cleanTicketFilter(f: TicketFilter): TicketFilter {
  const day = (v: string | undefined) => (v && DAY.test(v) ? v : undefined);
  return {
    status: TICKET_STATUSES.includes(f.status as TicketStatus) ? f.status : undefined,
    party_id: isUuid(f.party_id) ? f.party_id : undefined,
    created_from: day(f.created_from),
    created_to: day(f.created_to),
  };
}

export function listPartnerTickets(f: TicketFilter, cursor?: string | undefined) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(cleanTicketFilter(f))) if (v) p.set(k, v);
  if (cursor && CURSOR.test(cursor)) p.set('cursor', cursor);
  p.set('limit', '50');
  return serverFetch<Page<PartnerTicket>>(`/v1/partners/admin/tickets?${p}`);
}

export function getPartnerTicket(id: string) {
  if (!isUuid(id)) throw new Error('bad ticket id');
  return serverFetch<PartnerTicketDetail>(`/v1/partners/admin/tickets/${id}`);
}

/** Partner names for the Party column and pickers: one page of 200 (the API maximum). ponytail: a partner past the first 200 shows no name. */
export const listPartnerNames = () =>
  serverFetch<Page<{ id: string; name: string }>>('/v1/partners/admin/partners?limit=200').then((r) => r.data.map((p) => ({ id: p.id, name: p.name })));
