// T0D-MSGDESK-1 New ticket — /tickets/new. No read; the page query string is never forwarded and the partner comes from the session.
import { NewTicketForm } from '@/features/tickets/TicketForms';

export default function NewTicketPage() {
  return <NewTicketForm />;
}
