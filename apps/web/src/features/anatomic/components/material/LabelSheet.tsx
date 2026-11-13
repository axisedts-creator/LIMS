'use client';
// 04-UI-UX §4.3 Labels page: screen toolbar (kind toggle, [Print], [Back to case]) + one label per block / slide (line 1 label text, line 2 `line2`, Code 128 symbol).
// Everything that is not a label carries data-print-hide (see label-sheet.css: one @page of 50 x 25 mm, one label per page). AC-13.3 (CR-C11-007: kit BarcodeSymbol).
// A label value the symbol rejects (outside A-Z 0-9 hyphen) is printed as text only and flagged on screen: a wrong barcode is a misidentification risk, so none is ever guessed.
// LD-140 (2026-11-13, binding): kit components and token class names only; [Print] is the page's one primary button.
import { useRouter } from 'next/navigation';
import { BarcodeSymbol } from '@lims/ui/components/BarcodeSymbol';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import type { LabelItem } from '../../server/types';
import './label-sheet.css';

const SYMBOL_OK = /^[A-Z0-9-]{1,32}$/;

export function LabelSheet({ caseId, kind, labels }: { caseId: string; kind: 'blocks' | 'slides'; labels: readonly LabelItem[] }) {
  const router = useRouter();
  const unprintable = labels.filter((l) => !SYMBOL_OK.test(l.label));
  return (
    <>
      <div data-print-hide>
        <PageHeader title="Labels" helpKey="anatomic.case" breadcrumbs={[{ label: 'Pathology cases', href: '/anatomic' }, { label: 'Case', href: `/anatomic/cases/${caseId}` }, { label: 'Labels' }]} />
        <RadioGroup
          label="Label type"
          name="kind"
          orientation="horizontal"
          value={kind}
          options={[{ value: 'blocks', label: 'Blocks' }, { value: 'slides', label: 'Slides' }]}
          onChange={(k) => router.push(`/anatomic/cases/${caseId}/labels?kind=${k}`)}
        />
        <Button variant="primary" isDisabled={labels.length === 0} onPress={() => window.print()}>Print</Button>
        <a className="lims-link" href={`/anatomic/cases/${caseId}`}>Back to case</a>
        {unprintable.length ? <Banner tone="warning" title={`${unprintable.length} label(s) have no barcode symbol because the label text is not valid for one. They print as text only.`} /> : null}
      </div>
      {labels.length === 0 ? (
        <div data-print-hide>
          <EmptyState title={kind === 'blocks' ? 'No blocks yet.' : 'No slides yet.'} body="Labels appear here when the case has blocks or slides." />
        </div>
      ) : (
        <div className="lims-label-sheet">
          {labels.map((l) => (
            <section key={`${l.object_kind}-${l.object_id}`} className="lims-label-item" aria-label={`Label ${l.label}`}>
              <p className="lims-label-line1">{l.label}</p>
              <p className="lims-label-line2">{l.line2}</p>
              {/* ponytail: 0.25 mm is the C5 minimum module; a 32-character label is wider than 50 mm and would need a larger label size (C5 LabelRenderer owns that). */}
              {SYMBOL_OK.test(l.label) ? <span className="lims-label-symbol"><BarcodeSymbol value={l.label} moduleWidthMm={0.25} heightMm={7} quietZoneModules={4} /></span> : null}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
