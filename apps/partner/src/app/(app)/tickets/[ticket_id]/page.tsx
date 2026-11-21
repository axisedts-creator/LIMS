// T0D-MSGDESK-1 Ticket thread — /tickets/{ticket_id}. getMyPartnerTicket; a non uuid id or an API 404 (another partner's ticket, RLS) -> notFound().
// Messages oldest first; a partner message is "You", a lab message "Lab". A closed ticket takes no reply.
import { notFound } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Card } from '@lims/ui/components/Card';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { get, isUuid } from '@/features/common/api';
import { Dt } from '@/features/common/ui';
import { ReplyForm } from '@/features/tickets/TicketForms';
import { TicketChip } from '@/features/tickets/TicketList';

interface Message { id: string; sender_kind: string; body: string; created_at: string }
interface Detail { ticket: { id: string; subject: string; status: string }; messages: Message[] }

export default async function TicketPage({ params }: { params: Promise<{ ticket_id: string }> }) {
  const { ticket_id: id } = await params;
  if (!isUuid(id)) notFound();
  const d = await get<Detail>(`/v1/partners/me/tickets/${id}`);
  if (!d?.ticket || !Array.isArray(d.messages)) throw new Error('partner_api_failed');
  const messages = [...d.messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const closed = d.ticket.status === 'closed';
  return (
    <>
      <PageHeader title={d.ticket.subject} helpKey="partners.ticket" breadcrumbs={[{ label: 'My tickets', href: '/tickets' }, { label: d.ticket.subject }]} status={<TicketChip status={d.ticket.status} size="md" />} />
      <Stack gap={4}>
        {messages.map((m) => (
          <Card key={m.id} title={m.sender_kind === 'lab' ? 'Lab' : 'You'}>
            <p><Dt value={m.created_at} withTime /></p>
            <p>{m.body}</p>
          </Card>
        ))}
        {closed ? <Banner tone="info" title="This ticket is closed." /> : <ReplyForm ticketId={id} />}
      </Stack>
    </>
  );
}
