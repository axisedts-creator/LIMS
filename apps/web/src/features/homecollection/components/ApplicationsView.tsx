'use client';
// PHLEBO-UI-FULL-1: Phlebo applications. People apply from the phlebotomist app; a manager reviews the details and documents
// here and approves or rejects. Plain-JSON props from the server page. Documents open through a same-origin download route.
// LD-140: kit components only; every status shows tone and word.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { APPLICATION_STATUS, DOCUMENT_KIND, workPattern, type ApplicationRow } from '../applications.types';
import { useBoardRefresh } from '../hooks/useBoardRefresh';
import { approveApplicationAction, decideApplicationAction } from '../server/applications.actions';
import { useSubmissionKey } from '../submission';

type Iso = DateTextProps['value'];
const BASE = '/homecollection/applications';
const FAIL: Record<string, string> = {
  'common.version_conflict': 'Someone else changed this application. Refresh and try again.',
  'common.immutable_record': 'This application was already decided. Refresh the list.',
  'common.validation_failed': 'Write a reason before rejecting.',
  'identity.user_exists': 'A staff account with this email already exists. Check Admin > Users, then reject or contact the applicant.',
  'auth.forbidden': 'You are not allowed to create staff accounts. Ask a lab administrator to approve.',
};

const Status = ({ status }: { status: string }) => {
  const [tone, label] = APPLICATION_STATUS[status] ?? (['neutral', status] as const);
  return <StatusChip kind="generic" status={status} tone={tone} label={label} />;
};
const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

type Option = { id: string; name: string };
export interface ApplicationsViewProps { applications: readonly ApplicationRow[]; waiting: number; status: string; roles: readonly Option[]; centres: readonly Option[] }

export function ApplicationsView({ applications, waiting, status, roles, centres }: ApplicationsViewProps) {
  const router = useRouter();
  const toast = useToast();
  const keyFor = useSubmissionKey();
  const [open, setOpen] = useState<ApplicationRow | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [roleId, setRoleId] = useState(roles.length === 1 ? roles[0]!.id : '');
  const [centreId, setCentreId] = useState(centres.length === 1 ? centres[0]!.id : '');
  const canApprove = roles.length > 0 && centres.length > 0;
  useBoardRefresh(open !== null);

  const close = () => { setOpen(null); setNote(''); setError(''); };
  const decide = async (decision: 'approve' | 'reject') => {
    if (!open || pending) return;
    if (decision === 'reject' && !note.trim()) { setError(FAIL['common.validation_failed']!); return; }
    if (decision === 'approve' && (!roleId || !centreId)) { setError('Choose a role and a centre before approving.'); return; }
    setPending(true);
    setError('');
    const r = decision === 'approve'
      ? await approveApplicationAction(open.id, open.version, roleId, centreId, keyFor(`${open.id}:${open.version}:approve:${roleId}:${centreId}`))
      : await decideApplicationAction(open.id, open.version, decision, note.trim() || undefined, keyFor(`${open.id}:${open.version}:${decision}:${note.trim()}`));
    setPending(false);
    if (!r.ok) { setError(FAIL[r.code] ?? 'That did not work. Try again.'); return; }
    toast.show({ tone: 'success', title: decision === 'approve' ? 'Approved. An invite email was sent to the applicant.' : 'Application rejected.' });
    close();
    router.refresh();
  };

  const columns: ColumnDef<ApplicationRow>[] = [
    { id: 'name', header: 'Applicant', isRowHeader: true, cell: (a) => a.full_name },
    { id: 'phone', header: 'Mobile', cell: (a) => a.phone_e164 },
    { id: 'area', header: 'Area', cell: (a) => a.area },
    { id: 'work', header: 'Wants to work', cell: (a) => workPattern(a) },
    { id: 'docs', header: 'Documents', align: 'end', cell: (a) => String(a.documents.length) },
    { id: 'when', header: 'Applied', cell: (a) => (a.submitted_at ? <DateText value={a.submitted_at as Iso} withTime /> : '—') },
    { id: 'status', header: 'Status', cell: (a) => <Status status={a.status} /> },
    { id: 'open', header: 'Open', cell: (a) => <Button size="sm" variant="ghost" onPress={() => setOpen(a)}>Review</Button> },
  ];
  const tab = (value: string, label: string) => (
    <Button variant={status === value ? 'primary' : 'ghost'} size="sm" onPress={() => router.replace(`${BASE}?status=${value}`)}>{label}</Button>
  );

  return (
    <div>
      <PageHeader title="Phlebo applications" helpKey="homecollection.applications" actions={<Button onPress={() => router.refresh()}>Refresh</Button>} />
      {waiting > 0 ? <Banner tone="info" title={`${waiting} ${waiting === 1 ? 'application is' : 'applications are'} waiting for review.`} /> : null}
      <p>{tab('submitted', 'Waiting')} {tab('approved', 'Approved')} {tab('rejected', 'Rejected')}</p>
      <DataTable<ApplicationRow>
        caption="Phlebotomist applications" columns={columns} rows={applications} getRowId={(a) => a.id} density="compact"
        emptyState={{ title: status === 'submitted' ? 'No applications are waiting.' : 'Nothing here yet.' }}
        onRowAction={(a) => setOpen(a)}
      />
      {open ? (
        <Dialog
          title={open.full_name} isOpen onClose={close} size="md"
          footer={open.status === 'submitted' ? (
            <>
              <Button variant="ghost" onPress={close} isDisabled={pending}>Close</Button>
              <Button variant="ghost" onPress={() => decide('reject')} isDisabled={pending}>Reject</Button>
              <Button variant="primary" onPress={() => decide('approve')} isDisabled={pending || !canApprove}>Approve</Button>
            </>
          ) : <Button variant="ghost" onPress={close}>Close</Button>}
        >
          {error ? <div role="alert"><Banner tone="danger" title={error} /></div> : null}
          <dl>
            <dt>Status</dt><dd><Status status={open.status} /></dd>
            <dt>Mobile</dt><dd>{open.phone_e164}</dd>
            <dt>Email</dt><dd>{open.email}</dd>
            <dt>Area</dt><dd>{open.area}</dd>
            <dt>Wants to work</dt><dd>{workPattern(open)}</dd>
            {open.decided_by_display ? (<><dt>Decided by</dt><dd>{open.decided_by_display}</dd></>) : null}
            {open.decision_note ? (<><dt>Note</dt><dd>{open.decision_note}</dd></>) : null}
          </dl>
          <h3>Documents</h3>
          <ul>
            {open.documents.map((d) => (
              <li key={d.id}>
                <a href={`${BASE}/${open.id}/documents/${d.id}`} target="_blank" rel="noopener noreferrer">{DOCUMENT_KIND[d.kind] ?? d.kind}</a>
                {` (${d.content_type === 'application/pdf' ? 'PDF' : 'image'}, ${size(d.byte_size)})`}
              </li>
            ))}
          </ul>
          {open.status === 'submitted' ? (
            <>
              <TextArea label="Note (needed to reject)" name="note" rows={3} maxLength={500} value={note} onChange={setNote} />
              {canApprove ? (
                <>
                  <Select label="Role" name="role_id" options={roles.map((r) => ({ value: r.id, label: r.name }))} {...(roleId ? { value: roleId } : {})} onChange={setRoleId} />
                  <Select label="Centre" name="centre_id" options={centres.map((c) => ({ value: c.id, label: c.name }))} {...(centreId ? { value: centreId } : {})} onChange={setCentreId} />
                  <p>Approving creates the staff account and emails the applicant a link to set a password. They then sign in to the app with their mobile number.</p>
                </>
              ) : (
                <p>You can reject here. To approve, you also need permission to manage users and see roles and centres.</p>
              )}
            </>
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}
