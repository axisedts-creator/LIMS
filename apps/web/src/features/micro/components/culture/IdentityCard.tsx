'use client';
// 04-UI-UX §3 identity card: DescriptionList columns=3 (Patient, Age / Sex, Barcode, Reg no, Specimen type, Site, Received, Planted, Next read, Final due, Lab status).
// LD-140 (2026-11-13): kit components only. Patient data comes from C4 through the BFF; when that read failed the card says so and offers ONE Retry (a page refresh
// re-reads once; there is no automatic retry). Everything from the server renders as text nodes (REQ-SEC-088).
import { useRouter } from 'next/navigation';
import { Card } from '@lims/ui/components/Card';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { When } from '../common';
import type { CultureDetailDto, PatientLite, SpecimenLite } from '../../server/types';

const words = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1).replace(/_/g, ' ')}`;

export function IdentityCard({ culture, patient, specimen }: { culture: CultureDetailDto; patient: PatientLite | null; specimen: SpecimenLite | null | undefined }) {
  const router = useRouter();
  const ageSex = patient ? [patient.age_display, patient.sex].filter(Boolean).join(' / ') : '';
  return (
    <Card>
      <DescriptionList
        columns={3}
        items={[
          {
            term: 'Patient',
            value: patient ? (
              patient.name
            ) : (
              <>
                Patient details unavailable{' '}
                <a
                  className="lims-link"
                  href={`/micro/cultures/${culture.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    router.refresh(); // one re-read of the page, hence of the patient; no automatic retry
                  }}
                >
                  Retry
                </a>
              </>
            ),
          },
          { term: 'Age / Sex', value: ageSex || '—' },
          { term: 'Barcode', value: specimen?.barcode ?? culture.barcode ?? '—' },
          { term: 'Reg no', value: specimen?.registration_no ?? '—' },
          { term: 'Specimen type', value: culture.specimen_type_code },
          { term: 'Site', value: culture.specimen_site_code ?? '—' },
          { term: 'Received', value: <When value={culture.received_at} time /> },
          { term: 'Planted', value: <When value={culture.planted_at} time /> },
          { term: 'Next read', value: <When value={culture.next_read_due_at} time /> },
          { term: 'Final due', value: <When value={culture.final_due_at} time /> },
          { term: 'Lab status', value: culture.lab_result ? words(culture.lab_result.status) : '—' },
        ]}
      />
    </Card>
  );
}
