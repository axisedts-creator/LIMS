'use client';
// C13.T19 PR-3 Report versions (04-UI-UX PR-3; US-08.4; routes.yaml partner.report). All versions of one report; Download per version, "Patient slip" only on the current valid version when the feature is on.
// LD-140 (2026-11-13): @lims/ui components only; no primary button on this page.
import Link from 'next/link';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Dt, ListScreen, RowLink, type ListColumn } from '../common/ui';
import type { PartnerReport } from '../common/types';
import { KIND } from './ReportList';

const BTN = 'lims-btn lims-btn-secondary lims-btn-sm';

export function ReportVersions({ versions, slips }: { versions: PartnerReport[]; slips: boolean }) {
  const head = versions[0];
  if (!head) {
    return (
      <>
        <PageHeader title="Report" helpKey="partners.report" />
        <EmptyState title="This report is no longer available." />
      </>
    );
  }
  const current = Math.max(...versions.filter((v) => v.status === 'valid').map((v) => v.version_no), 0);
  const columns: ListColumn<PartnerReport>[] = [
    { id: 'version', header: 'Version', isRowHeader: true, align: 'end', cell: (r) => `v${r.version_no}` },
    { id: 'kind', header: 'Kind', cell: (r) => KIND[r.kind] ?? 'Report' },
    { id: 'panels', header: 'Panels', cell: (r) => (r.panel_names ?? []).join(', ') || '—' },
    { id: 'released_at', header: 'Released', cell: (r) => <Dt value={r.released_at} withTime /> },
    { id: 'status', header: 'Status', cell: (r) => <StatusChip kind="report_version" status={r.status === 'valid' ? 'released' : 'superseded'} size="sm" /> },
    {
      id: 'actions', header: 'Actions', card: () => null,
      cell: (r) => (
        <span className="partner-actions-cell">
          <a className={BTN} href={`/api/bff/reports/${encodeURIComponent(r.report_id)}/versions/${r.version_no}/file`} aria-label={`Download report version ${r.version_no} for registration ${r.registration_no}`}>Download</a>
          {slips && r.status === 'valid' && r.version_no === current ? <Link className={BTN} href={`/reports/${encodeURIComponent(r.report_id)}/slip`}>Patient slip</Link> : null}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader title={`Report for registration ${head.registration_no}`} helpKey="partners.report" />
      <Stack gap={4}>
        <DescriptionList
          items={[
            { term: 'Patient name', value: head.patient.full_name },
            { term: 'Registration no.', value: <RowLink href={`/orders/${encodeURIComponent(head.order_id)}`}>{head.registration_no}</RowLink> },
          ]}
        />
        <ListScreen caption="Report versions" columns={columns} rows={versions} getRowId={(r) => `${r.report_id}:${r.version_no}`} empty={{ title: 'This report is no longer available.' }} />
      </Stack>
    </>
  );
}
