// T0D-MSGDESK-1 (LD-321; route staff.partners.ticket, permission partners.ticket.read): one ticket thread of the lab side inbox.
// A ticket id that is not a uuid is a 404 and never reaches the API; an unknown ticket (API 404) is a 404 too; other failures go to the segment error.tsx.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { t } from '@/core/i18n/messages';
import { TicketThread } from '@/features/partners/components/TicketThread';
import { isUuid } from '@/features/partners/server/sales.server';
import { getPartnerTicket, listPartnerNames } from '@/features/partners/server/tickets.server';

export const metadata = { title: 'Message To Laboratory' };

export default async function TicketPage({ params }: { params: Promise<{ ticket_id: string }> }) {
  const { ticket_id: id } = await params;
  if (!isUuid(id)) notFound();
  const [session, detail, parties] = await Promise.all([
    getShellSession(),
    getPartnerTicket(id).catch((e: unknown) => { if (e instanceof ApiError && e.status === 404) notFound(); throw e; }),
    listPartnerNames().catch(() => []),
  ]);
  const party = parties.find((p) => p.id === detail.ticket.party_id)?.name ?? t('partners.ticket.party_unknown');
  return <TicketThread detail={detail} party={party} permissions={session?.actor.permissions ?? []} />;
}
