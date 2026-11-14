'use client';
// C13.T19 PR-1 Reports (04-UI-UX PR-1; US-08.1/08.2/08.4). Filters: Released range, New only, Show older versions. Rows select (max 200) for "Mark as seen" (R2).
// Download is a link to the BFF stream route (never a signed URL / file location in the markup); accessible names carry version + registration no. (04-UI-UX §7).
// LD-140 (2026-11-13): @lims/ui components only; no primary button on this page.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Switch } from '@lims/ui/components/Switch';
import { Dt, ListScreen, RowLink, useApplyFilters, type ListColumn } from '../common/ui';
import { codesText } from '../common/format';
import type { PartnerReport } from '../common/types';
import { markSeenAction } from './actions';

const BTN = 'lims-btn lims-btn-secondary lims-btn-sm';
export const KIND: Record<string, string> = { final: 'Final', partial: 'Partial', preliminary: 'Preliminary', amended: 'Amended', addendum: 'Addendum' };
export const rowId = (r: PartnerReport) => `${r.report_id}:${r.version_no}`;

export interface ReportListProps {
  rows: PartnerReport[];
  nextCursor?: string | undefined;
  slips: boolean;
  initial: { released_at_from?: string; released_at_to?: string; is_new?: string; include_superseded?: string };
}

export function ReportList({ rows, nextCursor, slips, initial }: ReportListProps) {
  const router = useRouter();
  const apply = useApplyFilters();
  const [onlyNew, setOnlyNew] = useState(initial.is_new === 'true');
  const [older, setOlder] = useState(initial.include_superseded === 'true');
  const [released, setReleased] = useState<FilterValue>(initial.released_at_from && initial.released_at_to ? { released: [initial.released_at_from, initial.released_at_to] } : {});
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);

  const push = (v: FilterValue, n = onlyNew, o = older) => {
    setReleased(v);
    const range = Array.isArray(v['released']) ? (v['released'] as readonly string[]) : [];
    apply({ released_at_from: range[0], released_at_to: range[1], is_new: n ? 'true' : undefined, include_superseded: o ? 'true' : undefined });
  };

  const markSeen = async () => {
    const items = rows.filter((r) => picked.has(rowId(r))).map((r) => ({ report_id: r.report_id, version_no: r.version_no }));
    if (items.length === 0) return;
    const r = await markSeenAction(items);
    setFailed(!r.ok);
    if (r.ok) { setPicked(new Set()); router.refresh(); }
  };

  const columns: ListColumn<PartnerReport>[] = [
    { id: 'patient', header: 'Patient', isRowHeader: true, cell: (r) => <RowLink href={`/reports/${encodeURIComponent(r.report_id)}`}>{r.patient.full_name}</RowLink> },
    { id: 'registration_no', header: 'Registration no.', cell: (r) => <span className="lims-mono">{r.registration_no}</span> },
    { id: 'report', header: 'Report', cell: (r) => `${KIND[r.kind] ?? 'Report'}${r.panel_names?.length ? ` · ${codesText(r.panel_names, 2)}` : ''}` },
    {
      id: 'version', header: 'Version',
      cell: (r) => <>{r.status === 'superseded' ? `v${r.version_no} · Superseded` : `v${r.version_no}`}{r.is_new ? <> <Badge tone="info">New</Badge></> : null}</>,
      card: (r) => `${r.status === 'superseded' ? `v${r.version_no} · Superseded` : `v${r.version_no}`}${r.is_new ? ' · new report' : ''}`,
    },
    { id: 'released_at', header: 'Released', cell: (r) => <Dt value={r.released_at} withTime /> },
    {
      id: 'actions', header: 'Actions', card: () => null,
      cell: (r) => (
        <span className="partner-actions-cell">
          <a className={BTN} href={`/api/bff/reports/${encodeURIComponent(r.report_id)}/versions/${r.version_no}/file`} aria-label={`Download report version ${r.version_no} for registration ${r.registration_no}`}>Download</a>
          {slips && r.status === 'valid' ? <Link className={BTN} href={`/reports/${encodeURIComponent(r.report_id)}/slip`}>Patient slip</Link> : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Reports" helpKey="partners.reports" />
      {failed ? <Banner tone="danger" title="Could not mark the reports as seen." /> : null}
      <FilterBar filters={[{ id: 'released', label: 'Released', kind: 'date_range' }]} value={released} onChange={(v) => push(v)} onReset={() => { setOnlyNew(false); setOlder(false); push({}, false, false); }} />
      <div className="partner-toolbar">
        <Switch label="New only" isSelected={onlyNew} onChange={(v) => { setOnlyNew(v); push(released, v, older); }} />
        <Switch label="Show older versions" isSelected={older} onChange={(v) => { setOlder(v); push(released, onlyNew, v); }} />
      </div>
      <ListScreen
        caption="Reports"
        columns={columns}
        rows={rows}
        getRowId={rowId}
        href={(r) => `/reports/${encodeURIComponent(r.report_id)}`}
        nextCursor={nextCursor}
        empty={{ title: 'No reports released yet.' }}
        selection={{ mode: 'multiple', selectedIds: picked, onChange: setPicked, max: 200 }}
        bulkActions={[{ id: 'seen', label: 'Mark as seen' }]}
        onBulkAction={() => void markSeen()}
      />
    </>
  );
}
