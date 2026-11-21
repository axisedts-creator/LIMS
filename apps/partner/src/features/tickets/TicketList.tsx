'use client';
// T0D-MSGDESK-1 My tickets (partner side of Message To Laboratory; LD-321, LD-310). Read-only list of own tickets; a row opens the thread.
// LD-140: @lims/ui components only; one primary action ("New ticket"). LD-310: when empty the header row stays and the EmptyState sits in the body.
import Link from 'next/link';
import { DataTable } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Chip, Dt, ListScreen, RowLink, type ListColumn, type Tone } from '../common/ui';

export interface TicketRow { id: string; subject: string; status: string; created_at: string; last_message_at?: string | undefined }

const TICKET_STATUS: Readonly<Record<string, readonly [Tone, string]>> = { new: ['info', 'New'], replied: ['success', 'Replied'], closed: ['neutral', 'Closed'] };

export function TicketChip({ status, size }: { status: string | undefined; size?: 'sm' | 'md' }) {
  return <Chip table={TICKET_STATUS} code={status} {...(size ? { size } : {})} />;
}

const columns: ListColumn<TicketRow>[] = [
  { id: 'subject', header: 'Subject', isRowHeader: true, cell: (r) => <RowLink href={`/tickets/${encodeURIComponent(r.id)}`}>{r.subject}</RowLink> },
  { id: 'status', header: 'Status', cell: (r) => <TicketChip status={r.status} /> },
  { id: 'last_message_at', header: 'Last reply', cell: (r) => <Dt value={r.last_message_at} withTime /> },
  { id: 'created_at', header: 'Created', cell: (r) => <Dt value={r.created_at} withTime /> },
];
const empty = { title: 'No tickets yet.', body: 'Send a message to the lab with New ticket.' };

export function TicketList({ rows, nextCursor, canCreate }: { rows: TicketRow[]; nextCursor?: string | undefined; canCreate: boolean }) {
  return (
    <>
      <PageHeader
        title="My tickets"
        helpKey="partners.tickets"
        actions={canCreate ? <Link className="lims-btn lims-btn-primary lims-btn-md" href="/tickets/new">New ticket</Link> : null}
      />
      {rows.length === 0 ? (
        <DataTable caption="Tickets" columns={columns} rows={rows} getRowId={(r) => r.id} emptyState={empty} />
      ) : (
        <ListScreen caption="Tickets" columns={columns} rows={rows} getRowId={(r) => r.id} href={(r) => `/tickets/${encodeURIComponent(r.id)}`} nextCursor={nextCursor} empty={empty} />
      )}
    </>
  );
}
