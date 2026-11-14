'use client';
// Read-only "View" drawer of one stored report version (04-UI-UX §3.4; AC-11.5: earlier versions stay readable after a reopen). GET /report-versions/{version_no} (M16) through a server action.
// LD-140 (2026-11-13): kit components only. The snapshot is shown, never edited: no inputs, no submit. All server text is rendered as text nodes with line breaks kept (REQ-SEC-088).
import { useEffect, useState } from 'react';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Drawer } from '@lims/ui/components/Drawer';
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';
import { Stack } from '@lims/ui/components/Stack';
import { getReportVersionAction } from '../../server/reportActions';
import type { ReportVersionDto, ReportVersionSummaryDto } from '../../server/types';
import { Chip, When, type Fail } from '../common';
import '../culture/culture.css';
import { ReportNotice } from './ReportNotice';
import { AstTable, IsolatesTable } from './SnapshotTables';
import { KIND_LABEL, PHASE_LABEL, labelOf } from './labels';

export function ReportViewDrawer({ cultureId, version, outcomeDisplay, onClose }: { cultureId: string; version: ReportVersionSummaryDto; outcomeDisplay: string | undefined; onClose: () => void }) {
  const [dto, setDto] = useState<ReportVersionDto>();
  const [fail, setFail] = useState<Fail>();

  useEffect(() => {
    let alive = true;
    getReportVersionAction(cultureId, version.version_no).then(
      (r) => { if (alive) (r.ok ? setDto(r.data) : setFail(r)); },
      () => { if (alive) setFail({ ok: false, status: 0, code: 'common.internal' }); },
    );
    return () => { alive = false; };
  }, [cultureId, version.version_no]);

  const v = dto ?? version;
  return (
    <Drawer title={labelOf(PHASE_LABEL, version.report_phase)} isOpen onClose={onClose} width="lg">
      <Stack gap={3}>
        <ReportNotice fail={fail} />
        <DescriptionList
          columns={2}
          items={[
            { term: 'Version', value: v.version_no },
            { term: 'Kind', value: labelOf(KIND_LABEL, v.version_kind) },
            { term: 'Outcome', value: outcomeDisplay ?? '—' },
            { term: 'Critical', value: v.is_critical ? <Chip tone="critical" label="Critical" /> : 'No' },
            { term: 'Signed by', value: v.signed_by_display },
            { term: 'Signed at', value: <When value={v.signed_at} time /> },
            { term: 'Lab status at submit', value: v.lab_status_at_submit },
          ]}
        />
        {!dto && !fail ? <LoadingSkeleton variant="detail" /> : null}
        {dto ? (
          <>
            <DescriptionList
              items={[
                { term: 'Summary', value: <span className="lims-finding">{dto.culture_summary_text}</span> },
                ...(dto.comments_text ? [{ term: 'Comments', value: <span className="lims-finding">{dto.comments_text}</span> }] : []),
                ...(dto.early_final_reason ? [{ term: 'Reason for early final', value: <span className="lims-finding">{dto.early_final_reason}</span> }] : []),
                ...(dto.version_kind === 'amendment' && dto.amendment_reason_text ? [{ term: 'Amendment reason', value: <span className="lims-finding">{dto.amendment_reason_text}</span> }] : []),
              ]}
            />
            <IsolatesTable caption="Isolates in this version" rows={dto.isolates.map((i) => ({ seq: i.seq, organism: i.organism_display, growth: i.growth_text }))} />
            <AstTable
              caption="AST results in this version"
              rows={dto.ast.map((a) => ({ isolate_seq: a.isolate_seq, antibiotic_code: a.antibiotic_code, antibiotic: a.antibiotic_display, method: a.method, raw: a.raw_value, category: a.category_code, standard: a.standard, version: a.standard_version }))}
            />
          </>
        ) : null}
      </Stack>
    </Drawer>
  );
}
