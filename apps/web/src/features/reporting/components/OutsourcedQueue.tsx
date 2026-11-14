'use client';
// 04-UI-UX §2.3 Outsourced reports queue: filter by file state, upload a PDF (≤15 MB, external lab name ≤120), open the file card.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { listOutsourcedFilesAction, uploadOutsourcedAction } from '../server/actions';
import type { Centre, InputFile, OutsourcedItem } from '../server/types';
import { Chip, When, errorText, hasPerm, newKey } from './format';
import { fileStateLabel, OutsourcedFilePanel } from './OutsourcedFilePanel';
import { SimpleTable, type Col } from './SimpleTable';
import { useUrlFilters } from './useUrlFilters';

const MAX_BYTES = 15 * 1024 * 1024;

export function OutsourcedQueue({ items, permissions, centres }: { items: readonly OutsourcedItem[]; permissions: readonly string[]; centres: readonly Centre[] }) {
  const router = useRouter();
  const toast = useToast();
  const f = useUrlFilters(['state', 'centre_id']);
  const canAttach = hasPerm(permissions, 'reporting.outsourced.attach');
  const [uploadFor, setUploadFor] = useState<OutsourcedItem | null>(null);
  const [lab, setLab] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<{ lab?: string; file?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<{ item: OutsourcedItem; file: InputFile } | null>(null);
  const key = useRef(newKey());

  const open = (i: OutsourcedItem) => { setUploadFor(i); setLab(i.external_lab_name ?? ''); setFile(null); setErrors({}); };
  const submit = async () => {
    if (busy || !uploadFor) return;
    const e: typeof errors = {};
    if (lab.trim() === '') e.lab = 'External lab name is required';
    if (!file) e.file = 'Choose a PDF file';
    else if (file.type !== 'application/pdf') e.file = 'Only PDF files are allowed';
    else if (file.size > MAX_BYTES) e.file = 'The file is larger than 15 MB';
    setErrors(e);
    if (e.lab || e.file) return;
    const form = new FormData();
    form.set('file', file!);
    form.set('external_lab_name', lab.trim());
    setBusy(true);
    try {
      const r = await uploadOutsourcedAction(uploadFor.order_item_id, form, key.current);
      if (r.ok) { key.current = newKey(); setUploadFor(null); toast.show({ tone: 'success', title: 'File uploaded. Checking it now.' }); router.refresh(); } else setErrors({ form: errorText(r.code) });
    } catch {
      setErrors({ form: 'The upload failed. Check your connection and try again.' }); // network/transport failure: show it, don't leave an unhandled rejection
    } finally { setBusy(false); }
  };
  const openFile = async (i: OutsourcedItem) => {
    const r = await listOutsourcedFilesAction(i.order_item_id);
    const latest = r.ok ? r.data[0] : undefined;
    if (latest) setView({ item: i, file: latest });
    else toast.show({ tone: 'danger', title: 'The file could not be loaded', ...(r.ok ? {} : { description: errorText(r.code) }) });
  };

  const columns: Col<OutsourcedItem>[] = [
    { id: 'reg', header: 'Reg no', rowHeader: true, cell: (i) => (i.report_id ? <a className="lims-link lims-mono" href={`/reporting/reports/${i.report_id}`}>{i.registration_no}</a> : i.registration_no) },
    { id: 'patient', header: 'Patient', cell: (i) => i.patient_display_name ?? '—' },
    { id: 'test', header: 'Test', cell: (i) => i.test_names.join(', ') },
    { id: 'lab', header: 'External lab', cell: (i) => i.external_lab_name ?? '—' },
    { id: 'state', header: 'File state', cell: (i) => <Chip status={i.latest_file_state ?? 'awaiting_file'} label={fileStateLabel(i.latest_file_state)} /> },
    { id: 'reg_at', header: 'Registered', cell: (i) => <When value={i.registered_at} /> },
    { id: 'act', header: 'Actions', cell: (i) => (
      <>
        {canAttach ? <Button size="sm" onPress={() => open(i)}>Upload</Button> : null}
        {i.latest_file_state ? <Button size="sm" variant="ghost" onPress={() => void openFile(i)}>Open file</Button> : null}
      </>
    ) },
  ];
  return (
    <section aria-label="Outsourced reports">
      <PageHeader title="Outsourced reports" helpKey="reporting.outsourced" />
      <FilterBar
        filters={[
          { id: 'state', label: 'File state', kind: 'select', options: [{ value: 'awaiting_file', label: 'Awaiting file' }, { value: 'awaiting_confirmation', label: 'Awaiting confirmation' }, { value: 'confirmed', label: 'Confirmed' }] },
          { id: 'centre_id', label: 'Centre', kind: 'select', options: centres.map((c) => ({ value: c.id, label: c.name })) },
        ]}
        value={f.value} onChange={f.onChange} onReset={f.onReset}
      />
      <SimpleTable caption="Outsourced reports" columns={columns} rows={items} getRowId={(i) => i.order_item_id} empty={{ title: 'No outsourced reports to show.' }} />

      <Dialog
        title="Upload outsourced report" isOpen={uploadFor !== null} onClose={() => setUploadFor(null)} size="sm" isDismissable={false}
        footer={<><Button variant="ghost" onPress={() => setUploadFor(null)} isDisabled={busy}>Cancel</Button><Button variant="primary" onPress={() => void submit()} isLoading={busy}>Upload</Button></>}
      >
        <TextField label="External lab name" name="external_lab_name" maxLength={120} isRequired value={lab} onChange={setLab} {...(errors.lab ? { error: errors.lab } : {})} />
        <div className="lims-field">
          <label className="lims-label" htmlFor="outsourced-file">PDF file</label>
          <input id="outsourced-file" name="file" type="file" accept="application/pdf" className="lims-input" aria-invalid={errors.file ? true : undefined} onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
          <p className="lims-description">PDF only, up to 15 MB.</p>
          {errors.file ? <p className="lims-error">{errors.file}</p> : null}
        </div>
        {errors.form ? <p role="alert" className="lims-error">{errors.form}</p> : null}
      </Dialog>
      <Dialog title="Outsourced file" isOpen={view !== null} onClose={() => setView(null)} size="md">
        {view ? <OutsourcedFilePanel file={view.file} patientDisplayName={view.item.patient_display_name ?? view.item.registration_no} permissions={permissions} /> : null}
      </Dialog>
    </section>
  );
}
