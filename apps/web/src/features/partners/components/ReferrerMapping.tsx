'use client';
// SF-1 Partner doctors (04-UI-UX §4, US-13.3): confirm a partner-typed doctor as a catalogue (C3) doctor, reject the mapping, or unlink. Counts only, no money.
// A doctor missing from the catalogue is added by the catalogue team, never from here.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Dialog } from '@lims/ui/components/Dialog';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useToast } from '@lims/ui/components/Toast';
import { mapReferrerAction, rejectMappingAction, searchDoctorsAction, unmapReferrerAction } from '../server/actions';
import type { ActionResult, DoctorHit, Referrer } from '../server/types';
import { Chip, DialogError, LoadFailed, Notice, REASONS, errorText, useUrlFilters } from './common';

const STATES = [{ value: 'unmapped', label: 'Not confirmed' }, { value: 'mapped', label: 'Confirmed' }, { value: 'rejected', label: 'Rejected' }];

function MapDialog({ referrer, onClose, onDone }: { referrer: Referrer; onClose: () => void; onDone: () => void }) {
  const [doctor, setDoctor] = useState<DoctorHit>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    if (!doctor) return setError('Choose a doctor from the catalogue.');
    setBusy(true);
    setError(undefined);
    try {
      const r = await mapReferrerAction(referrer.id, referrer.version, doctor.id);
      if (r.ok) onDone();
      else setError(errorText(r.code, r.status));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Confirm doctor" isOpen onClose={onClose} footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isLoading={busy} onPress={() => void submit()}>Confirm mapping</Button></>}>
      <p>Partner entered: {referrer.display_name}{referrer.registration_no ? ` (${referrer.registration_no})` : ''}</p>
      <Combobox<DoctorHit>
        label="Catalogue doctor"
        name="catalog_doctor_id"
        isRequired
        value={doctor}
        onChange={setDoctor}
        loadOptions={async (q) => { const r = await searchDoctorsAction(q); return r.ok ? r.data : []; }}
        getKey={(d) => d.id}
        renderOption={(d) => d.display_name}
        renderValue={(d) => d.display_name}
      />
      <p className="lims-description">If the doctor is not listed, ask the catalogue team to add them, then confirm.</p>
      <DialogError text={error} />
    </Dialog>
  );
}

export function ReferrerMapping({ rows, failed, filters }: { rows: readonly Referrer[]; failed: boolean; filters: { mapping_state?: string | undefined } }) {
  const router = useRouter();
  const toast = useToast();
  const setUrl = useUrlFilters();
  const [notice, setNotice] = useState<string>();
  const [mapping, setMapping] = useState<Referrer | null>(null);
  const [rejecting, setRejecting] = useState<Referrer | null>(null);

  const done = (r: ActionResult<unknown>, ok: string) => {
    if (r.ok) { setNotice(undefined); toast.show({ tone: 'success', title: ok }); router.refresh(); } else setNotice(errorText(r.code, r.status));
  };
  const columns: ColumnDef<Referrer>[] = [
    { id: 'partner', header: 'Partner', cell: (r) => r.partner.name },
    { id: 'name', header: 'Name', isRowHeader: true, cell: (r) => r.display_name },
    { id: 'qual', header: 'Qualification', cell: (r) => r.qualification ?? '—' },
    { id: 'reg', header: 'Council and registration no.', cell: (r) => [r.registration_council, r.registration_no].filter(Boolean).join(' ') || '—' },
    { id: 'samples', header: 'Samples this month', align: 'end', cell: (r) => r.samples_this_month },
    { id: 'state', header: 'State', cell: (r) => <Chip code={r.mapping_state} /> },
    { id: 'doctor', header: 'Catalogue doctor', cell: (r) => r.catalog_doctor?.display_name ?? '—' },
    {
      id: 'actions', header: 'Actions',
      cell: (r) => r.mapping_state === 'mapped' ? (
        <Button size="sm" variant="ghost" onPress={async () => done(await unmapReferrerAction(r.id, r.version), 'Doctor unlinked.')}>Unlink</Button>
      ) : r.mapping_state === 'unmapped' ? (
        <>
          <Button size="sm" onPress={() => setMapping(r)}>Confirm</Button>
          <Button size="sm" variant="ghost" onPress={() => setRejecting(r)}>Reject</Button>
        </>
      ) : null,
    },
  ];

  return (
    <section aria-label="Partner doctors">
      <PageHeader title="Partner doctors" helpKey="partners.referrers" />
      <FilterBar
        filters={[{ id: 'mapping_state', label: 'Show', kind: 'select', options: STATES }]}
        value={{ mapping_state: filters.mapping_state }}
        onChange={(v) => setUrl({ mapping_state: v['mapping_state'] as string | undefined })}
        onReset={() => setUrl({ mapping_state: undefined })}
      />
      {notice ? <Notice text={notice} /> : null}
      {failed ? (
        <LoadFailed />
      ) : (
        <DataTable caption="Partner doctors" columns={columns} rows={rows} getRowId={(r) => r.id} emptyState={{ title: 'No doctors', body: 'Doctors typed by partners will show here.' }} />
      )}
      {mapping ? <MapDialog referrer={mapping} onClose={() => setMapping(null)} onDone={() => { setMapping(null); done({ ok: true, data: true }, 'Doctor confirmed.'); }} /> : null}
      <ConfirmDialog
        key={rejecting?.id ?? 'none'}
        title="Reject mapping"
        isOpen={rejecting !== null}
        confirmLabel="Reject"
        tone="danger"
        onCancel={() => setRejecting(null)}
        body={<p>{rejecting?.display_name} stays unconfirmed for this partner.</p>}
        requireReason={{ codedSet: 'partners.referrer_mapping_reject_reasons', options: REASONS.referrer_mapping_reject_reasons }}
        onConfirm={async ({ reasonCode }) => {
          const r = rejecting;
          if (!r || !reasonCode) return;
          setRejecting(null);
          done(await rejectMappingAction(r.id, r.version, reasonCode), 'Mapping rejected.');
        }}
      />
    </section>
  );
}
