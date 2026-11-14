'use client';
// 04-UI-UX §2.8 simulation report (#42, AC-11.3): StatTiles, deny-by-reason as chart AND text, and a sample table without patient identifiers.
import { Fragment } from 'react';
import { useRouter } from 'next/navigation';
import { BarChart } from '@lims/ui/components/BarChart';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { IdText } from '@lims/ui/components/IdText';
import { Inline } from '@lims/ui/components/Inline';
import { StatTile } from '@lims/ui/components/StatTile';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { DASH, DECISION, REASON_LABEL, orderResultsHref, reasonText } from '../_lib/format';
import type { Reason, Report, SampleRow } from '../_lib/types';

type Iso = DateTextProps['value'];
const decision = (d: string) => { const x = DECISION[d]; return <StatusChip kind="generic" status={d} label={x?.label ?? d} tone={x?.tone ?? 'neutral'} />; };

export function ReportView({ report }: { report: Report | undefined }) {
  const router = useRouter();
  if (!report) return <Card title="Simulation report"><ErrorState title="We couldn't load the simulation report." body="The rules above are unaffected. Try again." onRetry={() => router.refresh()} /></Card>;

  const denied = (Object.entries(report.deny_by_reason) as [Reason, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const columns: ColumnDef<SampleRow>[] = [
    { id: 'at', header: 'Decided at', isRowHeader: true, cell: (r) => <DateText value={r.decided_at as Iso} withTime /> },
    { id: 'analyte', header: 'Analyte', cell: (r) => <IdText value={r.analyte_id} /> },
    { id: 'shadow', header: 'Shadow decision', cell: (r) => decision(r.shadow_decision) },
    { id: 'reasons', header: 'Reasons', cell: (r) => reasonText(r.shadow_reasons) },
    { id: 'live', header: 'Live decision', cell: (r) => (r.live_decision ? decision(r.live_decision) : DASH) },
    { id: 'verified', header: 'Verified by staff', cell: (r) => (r.manually_verified_at ? <DateText value={r.manually_verified_at as Iso} withTime /> : DASH) },
    { id: 'open', header: 'Results', cell: (r) => (r.order_id ? <a href={orderResultsHref(r.order_id)}>Open results</a> : DASH) },
  ];

  return (
    <Card title="Simulation report">
      <p className="lims-description">Started <DateText value={report.started_at as Iso} withTime />. Nothing here changes any result: the simulation only records what auto-verification would have done.</p>
      <Inline gap={3}>
        {[
          ['Days running', report.days_running], ['Decisions', report.decisions], ['Would allow', report.would_allow], ['Would deny', report.would_deny],
          ['Allowed and later verified by staff', report.allow_later_manually_verified],
        ].map(([label, n]) => <Fragment key={label}><StatTile label={String(label)} value={String(n)} />{' '}</Fragment>)}
      </Inline>
      <h3>Why results would be denied</h3>
      {denied.length ? (
        <>
          <BarChart title="Would deny, by reason" categories={denied.map(([r]) => REASON_LABEL[r] ?? 'Other reason')} series={[{ id: 'deny', label: 'Would deny', values: denied.map(([, n]) => n) }]} valueFormat="integer" />
          <ul>{denied.map(([r, n]) => <li key={r}>{REASON_LABEL[r] ?? 'Other reason'}: {n}</li>)}</ul>
        </>
      ) : <p className="lims-description">Nothing would be denied yet.</p>}
      <DataTable<SampleRow> columns={columns} rows={report.sample} getRowId={(r) => r.decision_id} density="compact" caption="Sample decisions" emptyState={{ title: 'No would-allow decisions yet.' }} />
    </Card>
  );
}
