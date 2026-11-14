'use client';
// SCR-11 verify queue (/catalog/doctors/verify): unverified doctors, newest first (the page sorts), possible duplicates under each
// row, actions Verify · Merge into… · Edit for catalog.referrer.manage. Rows are summaries without `version`, so the actions read
// the current version on the server (verifyDoctorAction / mergeDoctorAction without a version).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useToast } from '@lims/ui/components/Toast';
import { verifyDoctorAction } from '../server/catalogActions';
import type { DoctorSummary } from '../server/types';
import { CONFLICT, MasterTable, type Col } from './master-ui';
import { canManageDoctors } from './DoctorDetail';
import { DoctorMergeDialog } from './DoctorMergeDialog';

export function DoctorVerifyQueue({ doctors, possibleDuplicates = {}, mergeTargets, permissions }: {
  doctors: readonly DoctorSummary[];
  possibleDuplicates?: Readonly<Record<string, readonly DoctorSummary[]>>;
  mergeTargets: readonly DoctorSummary[];
  permissions: readonly string[];
}) {
  const manage = canManageDoctors(permissions);
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<string>();
  const [merging, setMerging] = useState<DoctorSummary>();

  const verify = async (d: DoctorSummary) => {
    if (busy) return;
    setBusy(d.id);
    setBanner(undefined);
    try {
      const r = await verifyDoctorAction(d.id);
      if (r.ok) {
        toast.show({ tone: 'success', title: `Verified ${d.doctor_code}` });
        router.refresh();
      } else setBanner(r.code === 'common.version_conflict' ? CONFLICT : 'Could not verify. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const cols: Col<DoctorSummary>[] = [
    { header: 'Code', cell: (r) => r.doctor_code },
    {
      header: 'Name',
      cell: (r) => {
        const dupes = possibleDuplicates[r.id] ?? [];
        return (
          <>
            <a className="lims-link" href={`/catalog/doctors/${r.id}`}>{r.display_name}</a>
            {dupes.length ? (
              <div>
                Possible duplicates:{' '}
                {dupes.map((x, i) => (
                  <span key={x.id}>
                    {i ? ', ' : ''}
                    <a className="lims-link" href={`/catalog/doctors/${x.id}`}>{x.display_name}</a> ({x.doctor_code})
                  </span>
                ))}
              </div>
            ) : null}
          </>
        );
      },
    },
    { header: 'Qualification', cell: (r) => r.qualification ?? '—' },
  ];
  return (
    <section aria-label="Doctors waiting for verification">
      <PageHeader title="Verify doctors" helpKey="catalog.doctors" breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Doctors', href: '/catalog/doctors' }, { label: 'Verify' }]} />
      {banner ? <Banner tone="warning" title={banner} action={{ label: 'Refresh', onPress: () => router.refresh() }} /> : null}
      <MasterTable
        caption="Doctors waiting for verification"
        cols={cols}
        rows={doctors}
        empty="No doctors waiting for verification."
        codeOf={(r) => r.doctor_code}
        rowExtra={
          manage
            ? (r) => (
                <>
                  <Button size="sm" variant="primary" isDisabled={busy !== null} onPress={() => void verify(r)}>Verify</Button>
                  <Button size="sm" onPress={() => setMerging(r)}>Merge into…</Button>
                  <Button size="sm" onPress={() => router.push(`/catalog/doctors/${r.id}`)}>Edit</Button>
                </>
              )
            : undefined
        }
      />
      {merging ? <DoctorMergeDialog source={{ id: merging.id, doctor_code: merging.doctor_code, display_name: merging.display_name }} targets={mergeTargets} onClose={() => setMerging(undefined)} /> : null}
    </section>
  );
}
