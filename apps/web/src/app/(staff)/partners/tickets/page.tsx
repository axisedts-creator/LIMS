// T0D-MSGDESK-1 (LD-321; route staff.partners.tickets, permission partners.ticket.read): ElabAssist Message To Laboratory, the lab side ticket inbox.
// Only ?status, ?party_id, ?created_from, ?created_to (well formed) and ?cursor reach listPartnerTickets. The party names come from the partner list.
import { getShellSession } from '@/core/session/server';
import { t } from '@/core/i18n/messages';
import { TicketInbox } from '@/features/partners/components/TicketInbox';
import { one, settle } from '@/features/partners/server/sales.server';
import { cleanTicketFilter, listPartnerNames, listPartnerTickets } from '@/features/partners/server/tickets.server';

export const metadata = { title: 'Message To Laboratory' };

export default async function TicketsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const filter = cleanTicketFilter({ status: one(sp['status']), party_id: one(sp['party_id']), created_from: one(sp['created_from']), created_to: one(sp['created_to']) });
  const [list, parties] = await Promise.all([settle(listPartnerTickets(filter, one(sp['cursor']))), listPartnerNames().catch(() => [])]);
  const ok = typeof list === 'number' ? undefined : list;
  return (
    <TicketInbox rows={ok?.data ?? []} parties={parties} permissions={session?.actor.permissions ?? []} filter={filter} nextCursor={ok?.page.next_cursor}
      failed={ok ? undefined : t(list === 403 ? 'partners.ticket.load_forbidden' : 'partners.ticket.load_failed')} />
  );
}
