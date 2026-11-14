'use client';
// C13.T19 PO-2 Sample detail (04-UI-UX PO-2; US-07.1/07.5, US-08.4). Read-only: header + description list, one Card per specimen with a Timeline, and the report versions.
// A rejected specimen shows the humanised reason (danger) and "A new sample is needed" until a replacement is received (03-APP-FLOW §3 T4).
// LD-140 (2026-11-13): @lims/ui components only; no primary button on this page.
import Link from 'next/link';
import { Banner } from '@lims/ui/components/Banner';
import { Card } from '@lims/ui/components/Card';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Timeline } from '@lims/ui/components/Timeline';
import { Chip, Dt, RowLink } from '../common/ui';
import { humanise, sexAge, str } from '../common/format';
import type { PartnerOrderDetail, PartnerReport, Specimen } from '../common/types';
import { TRACKING } from './OrderList';

const BTN = 'lims-btn lims-btn-secondary lims-btn-sm';
const KIND: Record<string, string> = { final: 'Final report', partial: 'Partial report', preliminary: 'Preliminary report', amended: 'Amended report', addendum: 'Addendum' };
const RECEIVED_OR_LATER = new Set(['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'stored']);

type Step = { at: string; label: string; tone?: 'danger' };
function stepsOf(s: Specimen, all: readonly Specimen[]): Step[] {
  const steps: Step[] = [];
  if (s.collected_at) steps.push({ at: s.collected_at, label: 'Collected' });
  if (s.in_transit_at) steps.push({ at: s.in_transit_at, label: 'Sent to lab' });
  if (s.received_at) steps.push({ at: s.received_at, label: 'Received at lab' });
  const why = str(s.rejection_reason_display) || humanise(s.rejection_reason_code);
  if (s.rejected_at) steps.push({ at: s.rejected_at, label: why ? `Rejected: ${why}` : 'Rejected', tone: 'danger' });
  const next = all.find((x) => x.replaces_specimen_id === s.specimen_id);
  if (next) steps.push({ at: next.received_at ?? next.collected_at ?? s.rejected_at ?? '1970-01-01T00:00:00.000Z', label: 'Replaced by new sample' });
  return steps.sort((a, b) => a.at.localeCompare(b.at));
}
const needsNew = (s: Specimen, all: readonly Specimen[]) =>
  (s.status === 'rejected' || s.status === 'recollection_ordered') && !all.some((x) => x.replaces_specimen_id === s.specimen_id && RECEIVED_OR_LATER.has(x.status));

export function ReportVersionActions({ r, slips, current }: { r: PartnerReport; slips: boolean; current: boolean }) {
  return (
    <span className="partner-actions-cell">
      <a className={BTN} href={`/api/bff/reports/${encodeURIComponent(r.report_id)}/versions/${r.version_no}/file`} aria-label={`Download report version ${r.version_no} for registration ${r.registration_no}`}>
        Download PDF
      </a>
      {slips && current ? <Link className={BTN} href={`/reports/${encodeURIComponent(r.report_id)}/slip`}>Print patient slip</Link> : null}
    </span>
  );
}

export function OrderDetail({ order: o, slips }: { order: PartnerOrderDetail; slips: boolean }) {
  const specimens = o.specimens ?? [];
  const reports = o.reports ?? [];
  const newest = Math.max(0, ...reports.filter((r) => r.status === 'valid').map((r) => r.version_no));
  return (
    <>
      <PageHeader title={`Registration ${o.registration_no}`} helpKey="partners.order" status={<Chip table={TRACKING} code={o.tracking_status} size="md" />} />
      <Stack gap={4}>
        <DescriptionList
          columns={2}
          items={[
            { term: 'Patient name', value: o.patient.full_name },
            { term: 'Sex/Age', value: sexAge(o.patient) || '—' },
            { term: 'Your ref', value: o.partner_sample_ref ?? '—' },
            { term: 'Manifest no.', value: o.manifest ? <RowLink href={`/manifests/${encodeURIComponent(o.manifest.id)}`}>{o.manifest.manifest_no}</RowLink> : '—' },
            { term: 'Doctor', value: o.referrer?.display_name ?? '—' },
            { term: 'Priority', value: o.priority === 'urgent' ? 'Urgent' : 'Routine' },
            { term: 'Tests', value: (o.orderables ?? []).map((t) => t.name ?? t.code).join(', ') || '—' },
          ]}
        />
        <section aria-label="Samples">
          <h2>Samples</h2>
          {specimens.length === 0 ? (
            <EmptyState title="The lab has not labelled this sample yet." />
          ) : (
            <Stack gap={3}>
              {specimens.map((s) => (
                <Card key={s.specimen_id} title={str(s.specimen_type_display) || humanise(s.specimen_type_code) || 'Sample'}>
                  <StatusChip kind="specimen" status={s.status} />
                  {needsNew(s, specimens) ? <Banner tone="warning" title="A new sample is needed" /> : null}
                  <Timeline items={stepsOf(s, specimens).map((t) => ({ at: t.at, label: t.label, ...(t.tone ? { tone: t.tone } : {}) }))} />
                </Card>
              ))}
            </Stack>
          )}
        </section>
        <section aria-label="Reports">
          <h2>Reports</h2>
          {reports.length === 0 ? (
            <EmptyState title="No reports released yet." />
          ) : (
            <Stack gap={3}>
              {reports.map((r) => (
                <Card key={`${r.report_id}-${r.version_no}`} title={`${KIND[r.kind] ?? 'Report'} · version ${r.version_no}`}>
                  <StatusChip kind="report_version" status={r.status === 'valid' ? 'released' : 'superseded'} />
                  <p>{(r.panel_names ?? []).join(', ')} · <Dt value={r.released_at} withTime /></p>
                  <ReportVersionActions r={r} slips={slips} current={r.status === 'valid' && r.version_no === newest} />
                  <p><RowLink href={`/reports/${encodeURIComponent(r.report_id)}`}>All versions</RowLink></p>
                </Card>
              ))}
            </Stack>
          )}
        </section>
      </Stack>
    </>
  );
}
