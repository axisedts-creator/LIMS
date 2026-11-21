'use client';
// T0D-MSGDESK-1 New ticket form and the Reply form of an open ticket. The partner comes from the session: no party / partner field exists here.
// LD-140: @lims/ui components only; one primary button per form.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { createTicketAction, replyTicketAction } from './actions';

const newKey = () => (typeof crypto === 'undefined' ? '' : crypto.randomUUID());

export function NewTicketForm() {
  const router = useRouter();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = useState(newKey)[0];

  const submit = async () => {
    if (!subject.trim() || !body.trim()) return;
    setBusy(true);
    setFailed(false);
    const r = await createTicketAction({ subject, body }, key);
    setBusy(false);
    if (r.ok) router.push('/tickets');
    else setFailed(true);
  };

  return (
    <>
      <PageHeader title="New ticket" helpKey="partners.ticket_new" breadcrumbs={[{ label: 'My tickets', href: '/tickets' }, { label: 'New ticket' }]} />
      {failed ? <Banner tone="danger" title="Could not send the ticket. Try again in a moment." /> : null}
      <Form onSubmit={submit}>
        <Stack gap={4}>
          <TextField label="Subject" name="subject" maxLength={150} isRequired value={subject} onChange={setSubject} />
          <TextArea label="Message" name="body" maxLength={2000} isRequired value={body} onChange={setBody} />
          <div><Button type="submit" variant="primary" isLoading={busy}>Send</Button></div>
        </Stack>
      </Form>
    </>
  );
}

export function ReplyForm({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newKey);

  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setFailed(null);
    const r = await replyTicketAction(ticketId, { body }, key);
    setBusy(false);
    if (r.ok) { setBody(''); setKey(newKey()); router.refresh(); }
    else setFailed(r.code === 'partners.ticket_invalid_transition' ? 'This ticket is closed.' : 'Could not send the reply. Try again in a moment.');
  };

  return (
    <Form onSubmit={submit}>
      {failed ? <Banner tone="danger" title={failed} /> : null}
      <Stack gap={4}>
        <TextArea label="Reply" name="body" maxLength={2000} isRequired value={body} onChange={setBody} />
        <div><Button type="submit" variant="primary" isLoading={busy}>Reply</Button></div>
      </Stack>
    </Form>
  );
}
