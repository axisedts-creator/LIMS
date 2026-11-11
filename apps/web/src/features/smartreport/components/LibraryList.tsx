'use client';
// SR-03 Library versions (04-UI-UX SR-03): DataTable + "New draft" menu. Create = server action with an Idempotency-Key; one request per press (busy guard).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { Menu } from '@lims/ui/components/Menu';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { createVersionAction } from '../server/actions';
import { LANG_LABEL, STATUS_LABEL, newKey, type Summary } from '../library';

const REASON = 'A draft or a version in review already exists';
const date = (v?: string) => (v ? <DateText value={v as DateTextProps['value']} /> : '—');

export function LibraryList({ rows }: { rows: Summary[] }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [source, setSource] = useState<string>();
  const inFlight = useRef(false);
  const blocked = rows.some((r) => r.status === 'draft' || r.status === 'in_review');

  const create = async (body: { source: string; source_version_id?: string }) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const r = await createVersionAction(body, newKey());
      if (r.ok) { setPickOpen(false); router.push(`/smartreport/library/${r.data.id}`); return; }
      setError(r.code === 'smartreport.library_invalid_transition' ? `${REASON}.` : 'Could not create the draft. Try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const columns: ColumnDef<Summary>[] = [
    { id: 'version', header: 'Version', isRowHeader: true, cell: (r) => `v${r.version_no}` },
    { id: 'status', header: 'Status', cell: (r) => <StatusChip kind="generic" status={r.status} label={STATUS_LABEL[r.status] ?? r.status} tone={r.status === 'approved' ? 'success' : r.status === 'in_review' ? 'warning' : r.status === 'draft' ? 'info' : 'neutral'} /> },
    { id: 'language', header: 'Language', cell: (r) => LANG_LABEL[r.language] ?? r.language },
    { id: 'approved_by', header: 'Approved by', cell: (r) => r.approved_by_display_name ?? '—' },
    { id: 'approved_at', header: 'Approved on', cell: (r) => date(r.approved_at) },
    { id: 'updated_at', header: 'Updated', cell: (r) => date(r.updated_at) },
    {
      id: 'actions', header: 'Actions',
      cell: (r) => (r.status === 'draft'
        ? <a href={`/smartreport/library/${r.id}`}>Edit v{r.version_no}</a>
        : <a href={`/smartreport/library/${r.id}/review`}>Open v{r.version_no}</a>),
    },
  ];

  const newDraft = (
    <span className="lims-inline">
      <Menu
        trigger={<Button variant="primary" isDisabled={blocked || busy}>New draft</Button>}
        items={[{ id: 'clone_active', label: 'From active version' }, { id: 'starter', label: 'From starter draft' }, { id: 'clone_version', label: 'From version…' }]}
        onAction={(id) => { setError(undefined); if (id === 'clone_version') setPickOpen(true); else void create({ source: id }); }}
      />
      {blocked ? <span className="lims-description">{REASON}</span> : null}
    </span>
  );

  return (
    <>
      <PageHeader title="Smart report library" helpKey="smartreport.library" actions={newDraft} />
      {error ? <div role="alert"><Banner tone="danger" title={error} /></div> : null}
      {rows.length === 0 ? (
        <div className="lims-state">
          <p className="lims-state-title">No library yet. Start from the starter draft.</p>
          <Button variant="primary" isLoading={busy} onPress={() => void create({ source: 'starter' })}>Start from the starter draft</Button>
        </div>
      ) : (
        <DataTable<Summary> columns={columns} rows={rows} getRowId={(r) => r.id} caption="Library versions" density="compact" emptyState={{ title: 'No library yet. Start from the starter draft.' }} />
      )}
      <Dialog
        title="New draft from a version" isOpen={pickOpen} onClose={() => setPickOpen(false)}
        footer={<Button variant="primary" isDisabled={!source} isLoading={busy} onPress={() => source && void create({ source: 'clone_version', source_version_id: source })}>Create draft</Button>}
      >
        <Select label="Version" name="source_version_id" options={rows.map((r) => ({ value: r.id, label: `v${r.version_no} · ${STATUS_LABEL[r.status] ?? r.status}` }))} {...(source ? { value: source } : {})} onChange={setSource} />
      </Dialog>
    </>
  );
}
