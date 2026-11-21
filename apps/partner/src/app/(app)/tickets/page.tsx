// T0D-MSGDESK-1 My tickets — /tickets. listMyPartnerTickets (own tickets only; only status, cursor and a fixed limit are forwarded, never a party filter).
import { can, getList, getMe, query, type Search } from '@/features/common/api';
import { TicketList, type TicketRow } from '@/features/tickets/TicketList';

const RULES = { status: { one: ['new', 'replied', 'closed'] }, cursor: 'cursor' } as const;

export default async function TicketsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const [list, me] = await Promise.all([getList<TicketRow>(`/v1/partners/me/tickets${query(await searchParams, RULES, { limit: '50' })}`), getMe()]);
  return <TicketList rows={list.data} nextCursor={list.page?.next_cursor} canCreate={can(me, 'partners.ticket.manage')} />;
}
