'use client';
// C13.T19 PF-1 Referring doctors (04-UI-UX PF-1; US-13.1/13.2/13.3/13.6). Admins add / edit doctors and switch Active; members read only. Counts only ("Samples this month"), never money.
// LD-140 (2026-11-13): @lims/ui components only; one primary action ("Add doctor"; the empty state carries it when there are no rows).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { Chip, ListScreen, type ListColumn, type Tone } from '../common/ui';
import { num } from '../common/format';
import type { PartnerReferrer } from '../common/types';
import { createDoctorAction, setDoctorActiveAction, updateDoctorAction, type DoctorInput } from './actions';

export const LAB_CHECK: Readonly<Record<string, readonly [Tone, string]>> = { unmapped: ['neutral', 'Waiting for lab'], mapped: ['success', 'Confirmed'], rejected: ['warning', 'Please check'] };
const blank: DoctorInput = { display_name: '', qualification: '', registration_council: '', registration_no: '' };

export function ReferrerList({ rows, nextCursor, canManage }: { rows: PartnerReferrer[]; nextCursor?: string | undefined; canManage: boolean }) {
  const router = useRouter();
  const [edit, setEdit] = useState<{ row: PartnerReferrer | null } | null>(null);
  const [d, setD] = useState<DoctorInput>(blank);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const open = (row: PartnerReferrer | null) => { setD(row ? { display_name: row.display_name, qualification: row.qualification ?? '', registration_council: row.registration_council ?? '', registration_no: row.registration_no ?? '' } : blank); setFailed(null); setEdit({ row }); };

  const save = async () => {
    setBusy(true);
    const r = edit?.row ? await updateDoctorAction(edit.row.id, edit.row.version ?? 0, d) : await createDoctorAction(d, crypto.randomUUID());
    setBusy(false);
    if (r.ok) { setEdit(null); router.refresh(); } else setFailed(r.code === 'partners.referrer_duplicate' ? 'This doctor is already on your list.' : 'Could not save. Try again in a moment.');
  };
  const toggle = async (row: PartnerReferrer, on: boolean) => {
    const r = await setDoctorActiveAction(row.id, row.version ?? 0, on);
    if (r.ok) router.refresh(); else setFailed('Could not change the doctor. Reload and try again.');
  };

  const columns: ListColumn<PartnerReferrer>[] = [
    { id: 'name', header: 'Name', isRowHeader: true, cell: (r) => r.display_name },
    { id: 'qualification', header: 'Qualification', cell: (r) => r.qualification ?? '—' },
    { id: 'council', header: 'Council reg. no.', hideBelow: 'md', cell: (r) => [r.registration_council, r.registration_no].filter(Boolean).join(' ') || '—' },
    {
      id: 'lab_check', header: 'Lab check',
      cell: (r) => (<><Chip table={LAB_CHECK} code={r.mapping_state} />{r.mapping_state === 'rejected' && canManage ? <small> Edit to send again</small> : null}</>),
    },
    { id: 'samples', header: 'Samples this month', align: 'end', cell: (r) => num(r.samples_this_month) },
    {
      id: 'active', header: 'Active',
      cell: (r) => (canManage ? <Switch label="Active" isSelected={r.is_active} onChange={(on) => void toggle(r, on)} /> : r.is_active ? 'Yes' : 'No'),
      card: (r) => (r.is_active ? 'Yes' : 'No'),
    },
  ];
  const empty = rows.length === 0;

  return (
    <>
      <PageHeader title="Referring doctors" helpKey="partners.referrers" actions={canManage && !empty ? <Button variant="primary" onPress={() => open(null)}>Add doctor</Button> : null} />
      {failed && !edit ? <Banner tone="danger" title={failed} /> : null}
      <ListScreen
        caption="Referring doctors"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        nextCursor={nextCursor}
        empty={{ title: 'No referring doctors yet.', ...(canManage ? { action: { label: 'Add doctor', onPress: () => open(null) } } : {}) }}
        {...(canManage ? { rowActions: () => [{ id: 'edit', label: 'Edit' }], onRowActionMenu: (r: PartnerReferrer) => open(r), cardActions: (r: PartnerReferrer) => <Button size="sm" onPress={() => open(r)}>Edit</Button> } : {})}
      />
      {edit ? (
        <Dialog title={edit.row ? 'Edit doctor' : 'Add doctor'} isOpen onClose={() => setEdit(null)}>
          <Form onSubmit={save}>
            <Stack gap={3}>
              {failed ? <Banner tone="danger" title={failed} /> : null}
              <TextField label="Name" name="display_name" maxLength={120} isRequired value={d.display_name} onChange={(v) => setD({ ...d, display_name: v })} />
              <TextField label="Qualification" name="qualification" maxLength={120} value={d.qualification} onChange={(v) => setD({ ...d, qualification: v })} />
              <TextField label="Council" name="registration_council" maxLength={20} description="e.g. NMC" value={d.registration_council} onChange={(v) => setD({ ...d, registration_council: v })} />
              <TextField label="Registration no." name="registration_no" maxLength={30} value={d.registration_no} onChange={(v) => setD({ ...d, registration_no: v })} />
              <div className="partner-card-actions">
                <Button type="submit" isLoading={busy}>Save doctor</Button>
                <Button variant="ghost" onPress={() => setEdit(null)}>Cancel</Button>
              </div>
            </Stack>
          </Form>
        </Dialog>
      ) : null}
    </>
  );
}
