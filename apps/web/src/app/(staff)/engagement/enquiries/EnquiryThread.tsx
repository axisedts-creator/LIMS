'use client';
// W11 thread (04-UI-UX §3 W11; US-EN-18.2, 18.4). Reply = N3 (Ctrl+Enter sends), Close = N4 (Alt+X, with confirmation). Reply / Close need engagement.enquiry.respond.
// LD-140: packages/ui components and token classes only. Exactly one primary button: Send. Message text is rendered as text, never logged, never stored in the browser.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { closeEnquiryAction, replyEnquiryAction } from './actions';
import { STATUS_LABEL } from './EnquiriesView';
import type { StaffEnquiry } from './enquiries.server';

export interface EnquiryThreadProps { enquiry: StaffEnquiry; permissions: readonly string[] }

const RESPOND = 'engagement.enquiry.respond';
const MAX = 2000;
const ERROR_TEXT: Record<string, string> = {
  'engagement.enquiry_invalid_transition': 'This conversation is closed.',
  'common.version_conflict': 'This conversation changed. Reload to continue.', // 04-UI-UX §1
};
const WHO = { patient: 'Patient', staff: 'Lab' } as const;

export function EnquiryThread({ enquiry, permissions }: EnquiryThreadProps) {
  const router = useRouter();
  const toast = useToast();
  const [thread, setThread] = useState(enquiry);
  const [text, setText] = useState('');
  const [error, setError] = useState<{ text: string; reload?: boolean }>();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const inFlight = useRef(false); // synchronous guard: a double-click must send one request
  useEffect(() => setThread(enquiry), [enquiry]); // router.refresh() brings a newer thread
  const closed = thread.status === 'closed';
  const canRespond = permissions.includes(RESPOND) && !closed;
  const [label, tone] = STATUS_LABEL[thread.status] ?? ['Unknown', 'neutral' as const];

  const fail = (code: string) => setError({ text: ERROR_TEXT[code] ?? 'Could not complete this. Try again.', reload: code === 'common.version_conflict' });

  const send = async () => {
    if (inFlight.current || text.trim() === '') return;
    inFlight.current = true;
    setPending(true);
    try {
      const r = await replyEnquiryAction(thread.id, thread.version, text, crypto.randomUUID());
      if (r.ok) { setThread(r.data); setText(''); setError(undefined); router.refresh(); } else { fail(r.code); if (r.status === 409) router.refresh(); }
    } finally { inFlight.current = false; setPending(false); }
  };
  const close = async () => {
    setConfirming(false);
    const r = await closeEnquiryAction(thread.id, thread.version);
    if (r.ok) { setThread(r.data); setError(undefined); toast.show({ tone: 'success', title: 'Enquiry closed' }); } else fail(r.code);
    router.refresh();
  };

  const onBoxKey = (e: KeyboardEvent<HTMLDivElement>) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void send(); } };
  useEffect(() => {
    if (!canRespond) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.altKey && e.key.toLowerCase() === 'x') { e.preventDefault(); setConfirming(true); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [canRespond]);

  return (
    <section aria-label="Enquiry">
      <PageHeader
        title={thread.subject} helpKey="engagement.enquiries"
        actions={<StatusChip kind="generic" status={thread.status} label={label} tone={tone} />}
      />
      {error && !closed ? <div role="alert"><Banner tone="danger" title={error.text} {...(error.reload ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} /></div> : null}
      <ul aria-label="Messages" className="lims-stack">
        {thread.messages.map((m, i) => (
          <li key={`${m.created_at}-${i}`}>
            <strong>{WHO[m.author_kind] ?? 'Patient'}</strong> <DateText value={m.created_at as DateTextProps['value']} withTime />
            <p>{m.body}</p>
          </li>
        ))}
      </ul>
      {closed ? <p>This conversation is closed.</p> : null}
      {canRespond ? (
        <>
          <Banner tone="warning" title="Don't include test results in replies; ask the patient to open their report in the app." />
          <div onKeyDown={onBoxKey}>
            <TextArea label="Reply" name="reply" maxLength={MAX} value={text} onChange={setText} rows={5} />
          </div>
          <div className="lims-inline">
            <Button variant="primary" shortcut="Ctrl+Enter" isLoading={pending} onPress={() => void send()}>Send</Button>
            <Button variant="secondary" shortcut="Alt+X" onPress={() => setConfirming(true)}>Close</Button>
          </div>
        </>
      ) : null}
      <ConfirmDialog
        title="Close this enquiry?" body="The patient can still read the conversation but can no longer reply."
        confirmLabel="Close enquiry" isOpen={confirming} onCancel={() => setConfirming(false)} onConfirm={close}
      />
    </section>
  );
}
