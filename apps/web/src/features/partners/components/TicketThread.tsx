'use client';
// T0D-MSGDESK-1 (LD-321): one ticket of the lab side inbox. The subject as heading, the status chip, the messages oldest first with the sender
// (Partner or Lab) and time, a Reply box, Close (new, replied) and Reopen (closed). A closed ticket takes no reply. Message text is plain text (ST16).
// Every write carries an Idempotency-Key; Close / Reopen carry If-Match = the ticket version. A reply refused because the ticket was closed meanwhile
// keeps the typed text.
import Link from 'next/link';
import { useId, useState } from 'react';
import { Card } from '@lims/ui/components/Card';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { Gate, ReasonLine } from '@/features/engagement/components/MessageTemplates';
import type { PartnerTicketDetail } from '../server/tickets.server';
import { closeTicketAction, reopenTicketAction, replyTicketAction, type TicketResult } from '../server/ticketActions';
import { Ad, hasPerm } from './common';
import { Alert, failure, newKey, useOnce, useUrl } from './SalesCommon';
import { TICKET_MANAGE, TicketStatus } from './TicketInbox';

const refusal = (r: Exclude<TicketResult, { ok: true }>) =>
  r.code === 'partners.ticket_invalid_transition' ? t('partners.ticket.error.closed_meanwhile') : failure(r, []).text;

export function TicketThread({ detail, party, permissions }: { detail: PartnerTicketDetail; party: string; permissions: readonly string[] }) {
  const { ticket } = detail;
  const toast = useToast();
  const url = useUrl();
  const once = useOnce();
  const manageId = useId();
  const closedId = useId();
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string>();
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [replyKey, setReplyKey] = useState(newKey);
  const canManage = hasPerm(permissions, TICKET_MANAGE);
  const closed = ticket.status === 'closed';
  const messages = [...detail.messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const replyReason = !canManage ? manageId : closed ? closedId : undefined;

  const write = (f: () => Promise<TicketResult>, ok: string, after?: () => void) => once(async () => {
    setBusy(true);
    setText(undefined);
    try {
      const r = await f();
      if (r.ok) { after?.(); toast.show({ tone: 'success', title: ok }); url.refresh(); return; }
      setText(refusal(r));
      if (r.code === 'common.version_conflict') url.refresh();
    } finally {
      setBusy(false);
    }
  });
  const send = () => {
    if (!reply.trim() || reply.length > 2000) { setError(t('partners.ticket.error.reply')); return; }
    setError(undefined);
    void write(() => replyTicketAction(ticket.id, reply.trim(), replyKey), t('partners.ticket.replied_done'), () => { setReply(''); setReplyKey(newKey()); });
  };

  return (
    <section className="lims-stack">
      <Link href="/partners/tickets" className="lims-link">{t('partners.ticket.back')}</Link>
      <PageHeader title={ticket.subject} helpKey="partners.tickets" status={<TicketStatus status={ticket.status} />}
        actions={closed
          ? <Gate variant="secondary" reasonId={canManage ? undefined : manageId} isLoading={busy} onPress={() => void write(() => reopenTicketAction(ticket.id, ticket.version, newKey()), t('partners.ticket.reopened_done'))}>{t('partners.ticket.reopen')}</Gate>
          : <Gate variant="secondary" reasonId={canManage ? undefined : manageId} isLoading={busy} onPress={() => void write(() => closeTicketAction(ticket.id, ticket.version, newKey()), t('partners.ticket.closed_done'))}>{t('partners.ticket.close')}</Gate>} />
      <p className="lims-description">{`${t('partners.ticket.col.party')}: ${party}`}</p>
      {!canManage ? <ReasonLine id={manageId}>{t('partners.ticket.reason.manage')}</ReasonLine> : null}
      {/* T0D-UIGUARD-1-PARTNERS (LD-436/LD-439 rule 7): the messages sit in a kit Card with its title row (no raw h2); the list is ARIA roles, no raw ol. */}
      <Card title={t('partners.ticket.messages')}>
        {messages.length === 0 ? (
          <div className="ticket-empty-state"><EmptyState title={t('partners.ticket.messages_empty')} body={t('partners.ticket.messages_empty_hint')} /></div>
        ) : (
          <div role="list" className="lims-timeline">
            {messages.map((m) => (
              <div role="listitem" key={m.id} className="lims-timeline-item">
                <p className="lims-label">
                  <span>{t(`partners.ticket.sender.${m.sender_kind}`)}</span>{' '}
                  <Ad value={m.created_at} withTime />
                </p>
                <p className="lims-pre-wrap">{m.body}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
      <div className="lims-stack">
        <TextArea label={t('partners.ticket.reply_label')} name="reply" maxLength={2000} rows={4} value={reply} isDisabled={closed || !canManage}
          onChange={(v) => { setReply(v); setError(undefined); }} {...(error ? { error } : {})} />
        {closed ? <ReasonLine id={closedId}>{t('partners.ticket.reason.closed')}</ReasonLine> : null}
        <span className="lims-inline">
          <Gate variant="primary" reasonId={replyReason} isLoading={busy} onPress={send}>{t('partners.ticket.reply')}</Gate>
        </span>
        <Alert text={text} />
      </div>
    </section>
  );
}
