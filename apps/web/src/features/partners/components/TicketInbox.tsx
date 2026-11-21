'use client';
// T0D-MSGDESK-1 (LD-321, LD-353 template 1 LIST): lab side Ticket Inbox, ElabAssist Message To Laboratory (status New, Replied, Close).
// Columns Ticket (link to the thread), Party (the partner name from the partner list), Subject, Status, Last Reply. One FilterBar: Status, Party,
// From and To (native date inputs, no picker library); filters live in the URL. New ticket: the lab writes to a partner (party, subject, message).
// Blocked controls are disabled and point (aria-describedby) at the visible reason naming partners.ticket.manage. Subjects are plain text (ST16).
import Link from 'next/link';
import { useId, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { Gate, ReasonLine } from '@/features/engagement/components/MessageTemplates';
import type { NamedOption } from '../server/sales.server';
import type { PartnerTicket, TicketFilter } from '../server/tickets.server';
import { createTicketAction } from '../server/ticketActions';
import { Ad, hasPerm } from './common';
import { Alert, SalesTable, failure, newKey, useOnce, useUrl, type Col } from './SalesCommon';

/** A native date input (no picker library, light on low end PCs) with its label above. */
function DateInput({ label, value, onChange, min }: { label: string; value: string; onChange: (v: string) => void; min?: string }) {
  const id = useId();
  return (
    <div className="lims-field">
      <label htmlFor={id} className="lims-label">{label}</label>
      <input id={id} type="date" className="lims-input" value={value} onChange={(e) => onChange(e.target.value)} {...(min ? { min } : {})} />
    </div>
  );
}

export const TICKET_MANAGE = 'partners.ticket.manage';
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const TONES: Record<string, Tone> = { new: 'warning', replied: 'info', closed: 'neutral' };
export const TicketStatus = ({ status }: { status: string }) => <StatusChip kind="generic" status={status} tone={TONES[status] ?? 'neutral'} label={t(`partners.ticket.status.${status}`)} />;
const ALL = 'all';

function NewTicket({ parties, onClose, onDone }: { parties: readonly NamedOption[]; onClose: () => void; onDone: () => void }) {
  const [party, setParty] = useState<string>();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);
  const once = useOnce();
  const send = () => once(async () => {
    const e: Record<string, string> = {};
    if (!party) e['party_id'] = t('partners.ticket.error.party');
    if (!subject.trim() || subject.length > 150) e['subject'] = t('partners.ticket.error.subject');
    if (!body.trim() || body.length > 2000) e['body'] = t('partners.ticket.error.message');
    setErrors(e);
    if (Object.keys(e).length || !party) return;
    setBusy(true);
    setText(undefined);
    try {
      const r = await createTicketAction({ party_id: party, subject: subject.trim(), body: body.trim() }, key);
      if (r.ok) return onDone();
      const f = failure(r, ['party_id', 'subject', 'body']);
      setErrors(f.fields);
      setText(f.text);
    } finally {
      setBusy(false);
    }
  });
  const err = (k: string) => (errors[k] ? { error: errors[k] } : {});
  return (
    <Dialog title={t('partners.ticket.new')} isOpen onClose={onClose} size="md"
      footer={<><Button variant="ghost" onPress={onClose}>{t('partners.ticket.cancel')}</Button><Button variant="primary" isLoading={busy} onPress={() => void send()}>{t('partners.ticket.send')}</Button></>}>
      <div className="lims-stack">
        <Select label={t('partners.ticket.field.party')} name="party_id" isRequired options={parties.map((p) => ({ value: p.id, label: p.name }))} {...(party ? { value: party } : {})} onChange={setParty} {...err('party_id')} />
        <TextField label={t('partners.ticket.field.subject')} name="subject" maxLength={150} isRequired value={subject} onChange={setSubject} {...err('subject')} />
        <TextArea label={t('partners.ticket.field.message')} name="body" maxLength={2000} rows={5} isRequired value={body} onChange={setBody} {...err('body')} />
        <Alert text={text} />
      </div>
    </Dialog>
  );
}

export function TicketInbox({ rows, parties, permissions, filter, failed, nextCursor }: {
  rows: readonly PartnerTicket[]; parties: readonly NamedOption[]; permissions: readonly string[]; filter: TicketFilter; failed?: string | undefined; nextCursor?: string | undefined;
}) {
  const toast = useToast();
  const url = useUrl();
  const reasonId = useId();
  const blocked = hasPerm(permissions, TICKET_MANAGE) ? undefined : reasonId;
  const [creating, setCreating] = useState(false);
  const names = new Map(parties.map((p) => [p.id, p.name]));
  const go = (c: Record<string, string | undefined>) => url.go({ ...c, cursor: undefined }, true);

  const columns: Col<PartnerTicket>[] = [
    { id: 'ticket', header: t('partners.ticket.col.ticket'), cell: (r) => <Link href={`/partners/tickets/${r.id}`} className="lims-link lims-mono">{`#${r.id.slice(-6).toUpperCase()}`}</Link> },
    { id: 'party', header: t('partners.ticket.col.party'), cell: (r) => names.get(r.party_id) ?? t('partners.ticket.party_unknown') },
    { id: 'subject', header: t('partners.ticket.col.subject'), isRowHeader: true, cell: (r) => r.subject },
    { id: 'status', header: t('partners.ticket.col.status'), cell: (r) => <TicketStatus status={r.status} /> },
    { id: 'last', header: t('partners.ticket.col.last_reply'), cell: (r) => (r.last_message_at ? <Ad value={r.last_message_at} withTime /> : '—') },
  ];
  const statusOptions = [{ value: ALL, label: t('partners.ticket.filter.all') }, ...['new', 'replied', 'closed'].map((s) => ({ value: s, label: t(`partners.ticket.status.${s}`) }))];
  const partyOptions = [{ value: ALL, label: t('partners.ticket.filter.all_parties') }, ...parties.map((p) => ({ value: p.id, label: p.name }))];

  return (
    <section className="lims-stack">
      <PageHeader title={t('partners.nav.tickets')} helpKey="partners.tickets"
        actions={<Gate variant="primary" reasonId={blocked} onPress={() => setCreating(true)}>{t('partners.ticket.new')}</Gate>} />
      {blocked ? <ReasonLine id={reasonId}>{t('partners.ticket.reason.manage')}</ReasonLine> : null}
      {/* T0D-UIGUARD-1-PARTNERS (LD-353 rule 2, LD-441): the kit FilterBar holds the row; the native date inputs ride in as children. */}
      <FilterBar>
        <Select label={t('partners.ticket.filter.status')} name="status" options={statusOptions} value={filter.status ?? ALL} onChange={(v) => go({ status: v === ALL ? undefined : v })} />
        <Select label={t('partners.ticket.filter.party')} name="party_id" options={partyOptions} value={filter.party_id ?? ALL} onChange={(v) => go({ party_id: v === ALL ? undefined : v })} />
        <DateInput label={t('partners.ticket.filter.from')} value={filter.created_from ?? ''} onChange={(v) => go({ created_from: v || undefined })} />
        <DateInput label={t('partners.ticket.filter.to')} value={filter.created_to ?? ''} {...(filter.created_from ? { min: filter.created_from } : {})} onChange={(v) => go({ created_to: v || undefined })} />
      </FilterBar>
      <SalesTable caption={t('partners.nav.tickets')} columns={columns} rows={rows} getRowId={(r) => r.id} failed={failed} nextCursor={nextCursor}
        empty={{ title: t('partners.ticket.empty'), body: t('partners.ticket.empty_hint') }} />
      {creating ? <NewTicket parties={parties} onClose={() => setCreating(false)} onDone={() => { setCreating(false); toast.show({ tone: 'success', title: t('partners.ticket.created') }); url.refresh(); }} /> : null}
    </section>
  );
}
