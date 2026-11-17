'use client';
// PL-4 IRD Annex tracker (AC-E3.1..E3.5): matrix tenants × Annex 1 (platform) / 2 / 3 / 7, record panel with the IR2..IR8 transitions and upload.
// The documents list / download (P-19 "Scan pending") is not built: identity.yaml has no list of a record's documents (.orchestra/cr/C2.T26.md).
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { useToast } from '@lims/ui/components/Toast';
import { transitionAnnexAction, uploadAnnexDocumentAction, type TransitionInput } from './actions';
import {
  ANNEX_CODES, ANNEX_NEXT, MAX_UPLOAD_BYTES, UPLOAD_TYPES, annexLabel, annexStatusLabel,
  type AnnexCode, type AnnexRecord, type AnnexStatus, type Tenant,
} from './shared';
import { Alert, TextAreaInput, TextInput, newKey, useProblemDialogs, useSingleFlight } from './ui';

export const B6_BANNER = 'Tracking only. IRD checklist and Annex 7 template are pending IRD clarification (B6).';
const TONE: Record<AnnexStatus, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  not_started: 'neutral', in_preparation: 'info', submitted: 'warning', completed: 'success', rejected: 'danger', superseded: 'neutral',
};
const ACTION_LABEL: Record<AnnexStatus, string> = {
  not_started: 'Back to not started', in_preparation: 'Mark in preparation', submitted: 'Mark submitted', completed: 'Mark completed', rejected: 'Mark rejected', superseded: 'Mark superseded',
};
type TenantRow = Pick<Tenant, 'tenant_id' | 'code'>;

/** Current record of a cell: the newest non-superseded record (a superseded record has a successor, IR7). */
function pick(records: readonly AnnexRecord[], tenantId: string | undefined, code: AnnexCode): AnnexRecord | undefined {
  const mine = records.filter((r) => r.annex_code === code && (code === 'annex_1' ? !r.tenant_id : r.tenant_id === tenantId));
  return mine.find((r) => r.status !== 'superseded') ?? mine.at(-1);
}

export function IrdTracker({ tenants, records: initial, canManage }: { tenants: readonly TenantRow[]; records: readonly AnnexRecord[]; canManage: boolean }) {
  const [records, setRecords] = useState(initial);
  useEffect(() => setRecords(initial), [initial]);
  const [open, setOpen] = useState<{ tenant: TenantRow; code: AnnexCode }>();
  const current = open ? pick(records, open.tenant.tenant_id, open.code) : undefined;

  const columns: ColumnDef<TenantRow>[] = [
    { id: 'tenant', header: 'Tenant', isRowHeader: true, cell: (t) => t.code },
    ...ANNEX_CODES.map((code): ColumnDef<TenantRow> => ({
      id: code,
      header: code === 'annex_1' ? 'Annex 1 (platform)' : annexLabel(code),
      cell: (t) => {
        const r = pick(records, t.tenant_id, code);
        if (!r) return <span aria-label={`${t.code} ${annexLabel(code)} no record`}>—</span>;
        return (
          <button type="button" className="lims-btn lims-btn-ghost lims-btn-sm" aria-label={`${t.code} ${annexLabel(code)}: ${annexStatusLabel(r.status)}`}
            onClick={() => setOpen({ tenant: t, code })}>
            <StatusChip kind="generic" status={r.status} tone={TONE[r.status]} label={annexStatusLabel(r.status)} size="sm" />
          </button>
        );
      },
    })),
  ];

  return (
    <div className="lims-ird-tracker">
      <Banner tone="warning" title={B6_BANNER} />
      <DataTable caption="IRD annexes" columns={columns} rows={tenants} getRowId={(t) => t.tenant_id} emptyState={{ title: 'No tenants yet' }} />
      {open && current ? (
        <RecordPanel key={`${current.record_id}:${current.version}`} tenantCode={open.tenant.code} record={current} canManage={canManage}
          onClose={() => setOpen(undefined)}
          onChanged={(r) => setRecords((rs) => rs.map((x) => (x.record_id === r.record_id ? { ...x, ...r } : x)))} />
      ) : null}
    </div>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

function RecordPanel({ tenantCode, record, canManage, onClose, onChanged }: {
  tenantCode: string; record: AnnexRecord; canManage: boolean; onClose: () => void; onChanged: (r: AnnexRecord) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const { run, pending } = useSingleFlight();
  const { handle, dialogs } = useProblemDialogs();
  const [f, setF] = useState({
    reference_no: record.reference_no ?? '', tax_office: record.tax_office ?? '', counterparty: record.counterparty ?? '',
    software_version: record.software_version ?? '', submitted_on: record.submitted_on ?? '', completed_on: record.completed_on ?? '', notes: record.notes ?? '',
  });
  const [error, setError] = useState<string>();
  const [uploadError, setUploadError] = useState<string>();
  const uploadKey = useRef(newKey());
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const ro = !canManage;
  const code = record.annex_code;

  const transition = (to: AnnexStatus) => run(async () => {
    const body: TransitionInput = { to_status: to };
    if (to === 'submitted') {
      if (!f.submitted_on) return setError('Enter the Submitted on date first.');
      if (f.submitted_on > today()) return setError('Submitted on cannot be in the future.');
      body.submitted_on = f.submitted_on;
    }
    if (to === 'completed') {
      if (!f.reference_no.trim() || !f.completed_on) return setError('Enter the Reference no. and the Completed on date first.');
      const submitted = f.submitted_on || record.submitted_on;
      if (submitted && f.completed_on < submitted) return setError('Completed on cannot be before Submitted on.');
      body.reference_no = f.reference_no.trim();
      body.completed_on = f.completed_on;
    }
    if (to === 'rejected') {
      if (!f.notes.trim()) return setError('Enter a note explaining the rejection.');
      if (f.notes.length > 1000) return setError('The rejection note can be at most 1000 characters.');
      body.note = f.notes.trim();
    }
    setError(undefined);
    const r = await transitionAnnexAction(record.record_id, record.version, body);
    if (!r.ok) return setError(handle(r));
    onChanged(r.data);
    toast.show({ tone: 'success', title: `${annexLabel(code)} for ${tenantCode}: ${annexStatusLabel(r.data.status)}` });
    router.refresh(); // superseded → the successor record (IR7) arrives with the refreshed list
  });

  const upload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!(UPLOAD_TYPES as readonly string[]).includes(file.type)) return setUploadError('Only PDF, PNG or JPEG files can be uploaded.');
    if (file.size > MAX_UPLOAD_BYTES) return setUploadError('The file is larger than 15 MB.');
    setUploadError(undefined);
    void run(async () => {
      const form = new FormData();
      form.set('file', file);
      const r = await uploadAnnexDocumentAction(record.record_id, form, uploadKey.current);
      uploadKey.current = newKey();
      if (!r.ok) return setUploadError(handle(r));
      toast.show({ tone: 'success', title: 'Document uploaded. It is scanned before it can be downloaded.' });
    });
  };

  return (
    <aside className="lims-panel" aria-label={`${tenantCode} ${annexLabel(code)} record`}>
      <div className="lims-panel-header">
        <h2>{tenantCode} · {annexLabel(code)}{code === 'annex_1' ? ' (platform)' : ''}</h2>
        <Button variant="ghost" onPress={onClose}>Close panel</Button>
      </div>
      <p>Status: <StatusChip kind="generic" status={record.status} tone={TONE[record.status]} label={annexStatusLabel(record.status)} /></p>
      <TextInput label="Reference no." value={f.reference_no} onChange={set('reference_no')} maxLength={100} readOnly={ro} />
      {code !== 'annex_1' ? <TextInput label="Tax office" value={f.tax_office} onChange={set('tax_office')} maxLength={200} readOnly={ro} /> : null}
      {code === 'annex_7' ? <TextInput label="Counterparty" value={f.counterparty} onChange={set('counterparty')} maxLength={200} readOnly={ro} /> : null}
      {code === 'annex_1' ? <TextInput label="Software version" value={f.software_version} onChange={set('software_version')} maxLength={40} readOnly={ro} /> : null}
      <TextInput label="Submitted on" type="date" value={f.submitted_on} onChange={set('submitted_on')} readOnly={ro} />
      <TextInput label="Completed on" type="date" value={f.completed_on} onChange={set('completed_on')} readOnly={ro} />
      {ro ? (f.notes ? <p>Notes: {f.notes}</p> : null) : <TextAreaInput label="Notes" value={f.notes} onChange={set('notes')} maxLength={2000} />}
      <Alert>{error}</Alert>
      {canManage ? (
        <>
          <div className="lims-actions">
            {ANNEX_NEXT[record.status].map((to) => (
              <Button key={to} variant={to === 'completed' ? 'primary' : 'secondary'} isDisabled={pending} onPress={() => void transition(to)}>{ACTION_LABEL[to]}</Button>
            ))}
          </div>
          <div className="lims-field">
            <label className="lims-label" htmlFor={`up-${record.record_id}`}>Upload document (PDF, PNG or JPEG, up to 15 MB)</label>
            <input id={`up-${record.record_id}`} type="file" accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" onChange={upload} />
            <Alert>{uploadError}</Alert>
          </div>
        </>
      ) : null}
      {dialogs}
    </aside>
  );
}
