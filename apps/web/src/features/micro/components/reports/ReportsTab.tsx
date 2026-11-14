'use client';
// 04-UI-UX §3.4 tab "Reports": DataTable of the culture's report versions (Version, Phase, Kind, Outcome, Flag, Critical, Signed by, Signed at, Lab status at submit); row action "View"
// opens the read-only snapshot drawer (AC-09.5 UI side: versions are never edited or deleted from here; AC-11.5: earlier versions stay readable). LD-140 (2026-11-13): kit components only;
// Critical shows icon + word; Flag uses the kit FlagBadge (tone + icon + word). Read-only users (micro.culture.read) see everything here.
import { useState } from 'react';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FlagBadge } from '@lims/ui/components/FlagBadge';
import { listOutcomesAction } from '../../server/reportActions';
import type { CultureDetailDto, MicroCodeDto, ReportVersionSummaryDto } from '../../server/types';
import { Chip, When } from '../common';
import { useLoad } from '../settings/useLoad';
import { KIND_LABEL, PHASE_WORD, labelOf } from './labels';
import { ReportViewDrawer } from './ReportViewDrawer';

export function ReportsTab({ culture }: { culture: CultureDetailDto }) {
  const versions = [...(culture.report_versions ?? [])].sort((a, b) => b.version_no - a.version_no);
  const outcomes = useLoad<MicroCodeDto>(() => listOutcomesAction(), 'culture_outcomes', versions.some((v) => v.outcome_code));
  const [viewing, setViewing] = useState<ReportVersionSummaryDto>();
  const outcomeOf = (code: string | undefined) => (code ? outcomes.rows.find((o) => o.code === code)?.display ?? code : undefined);

  const columns: readonly ColumnDef<ReportVersionSummaryDto>[] = [
    { id: 'version', header: 'Version', isRowHeader: true, cell: (r) => r.version_no, width: 90 },
    { id: 'phase', header: 'Phase', cell: (r) => labelOf(PHASE_WORD, r.report_phase) },
    { id: 'kind', header: 'Kind', cell: (r) => labelOf(KIND_LABEL, r.version_kind) },
    { id: 'outcome', header: 'Outcome', cell: (r) => outcomeOf(r.outcome_code) ?? '—' },
    { id: 'flag', header: 'Flag', cell: (r) => <FlagBadge flag={r.flag} showNormal /> },
    { id: 'critical', header: 'Critical', cell: (r) => (r.is_critical ? <Chip tone="critical" label="Critical" /> : '—') },
    { id: 'signed_by', header: 'Signed by', cell: (r) => r.signed_by_display },
    { id: 'signed_at', header: 'Signed at', cell: (r) => <When value={r.signed_at} time /> },
    { id: 'lab_status', header: 'Lab status at submit', cell: (r) => r.lab_status_at_submit },
  ];

  return (
    <>
      <DataTable<ReportVersionSummaryDto>
        caption="Report versions"
        columns={columns}
        rows={versions}
        getRowId={(r) => String(r.version_no)}
        emptyState={{ title: 'No reports have been sent yet.' }}
        rowActions={() => [{ id: 'view', label: 'View' }]}
        onRowActionMenu={(r, a) => a === 'view' && setViewing(r)}
        onRowAction={setViewing}
      />
      {viewing ? <ReportViewDrawer cultureId={culture.id} version={viewing} outcomeDisplay={outcomeOf(viewing.outcome_code)} onClose={() => setViewing(undefined)} /> : null}
    </>
  );
}
