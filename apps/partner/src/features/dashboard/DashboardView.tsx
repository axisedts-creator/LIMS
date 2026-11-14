'use client';
// C13.T18 PH-1 Home (dashboard), 04-UI-UX PH-1; US-14.1 / US-14.2.
// LD-140 (2026-11-13): built only from @lims/ui components; no hex colours, no inline styles; one primary button per page;
// every status shows tone, icon and word. Client component because kit Buttons/DataTable take callbacks.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText } from '@lims/ui/components/DateText';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Grid } from '@lims/ui/components/Grid';
import { Icon } from '@lims/ui/components/Icon';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatTile } from '@lims/ui/components/StatTile';
import { StatusChip, type StatusChipProps } from '@lims/ui/components/StatusChip';

type Tone = NonNullable<StatusChipProps['tone']>;

export interface DashboardCounts {
  submitted_today: number;
  in_lab: number;
  reported_today: number;
  rejected_open: number;
  new_reports: number;
  open_pickups: number;
  outstanding?: { amount_paisa: number; currency: string };
  outstanding_as_of?: string;
}
export interface RecentManifest {
  id: string;
  manifest_no: string;
  state: string;
  line_count: number;
  submitted_at?: string | null;
  created_at?: string;
}
export interface DashboardViewProps {
  counts: DashboardCounts;
  manifests: readonly RecentManifest[];
  manifestsFailed: boolean;
  labName: string;
}

// PM-1 state tones (04-UI-UX PM-1); labels from PM-1 filter words.
const STATE: Record<string, readonly [Tone, string]> = {
  draft: ['neutral', 'Draft'],
  submitted: ['info', 'Submitted'],
  partially_received: ['info', 'Partly received'],
  received: ['success', 'Received'],
  withdrawn: ['neutral', 'Withdrawn'],
  discarded: ['neutral', 'Discarded'],
};
const stateOf = (s: string) => (Object.hasOwn(STATE, s) ? STATE[s]! : (['neutral', s] as const));

// [CONV] lakh grouping via Intl en-IN (same output as MoneyText grouping='lakh'); StatTile.value is a string.
const lakh = (paisa: number) => `Rs. ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paisa / 100)}`;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '0');

// [CONV] "New manifest" opens PM-1 (manifest creation lives there; no separate create route in 04-UI-UX).
const NEW_MANIFEST = '/manifests';

export function DashboardView({ counts, manifests, manifestsFailed, labName }: DashboardViewProps) {
  const router = useRouter();
  const allZero = [counts.submitted_today, counts.in_lab, counts.reported_today, counts.rejected_open, counts.new_reports, counts.open_pickups].every((v) => !v);
  const isEmpty = allZero && !manifestsFailed && manifests.length === 0; // US-14.2
  const newManifest = () => router.push(NEW_MANIFEST);

  // [CONV] desktop shortcut Alt+W (04-UI-UX PH-1).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); router.push(NEW_MANIFEST); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const columns: ColumnDef<RecentManifest>[] = [
    { id: 'manifest_no', header: 'Manifest no.', isRowHeader: true, cell: (r) => <IdText value={r.manifest_no} truncate={32} /> },
    { id: 'state', header: 'State', cell: (r) => { const [t, label] = stateOf(r.state); return <StatusChip kind="generic" status={r.state} tone={t} label={label} size="sm" />; } },
    { id: 'line_count', header: 'Samples', align: 'end', cell: (r) => n(r.line_count) },
    { id: 'submitted_at', header: 'Submitted', cell: (r) => (r.submitted_at ? <DateText value={r.submitted_at as never} withTime /> : '—') },
  ];

  const warn = (counts.rejected_open ?? 0) > 0;
  const out = counts.outstanding;

  return (
    <>
      <PageHeader
        title="Home"
        helpKey="partners.home"
        actions={isEmpty ? null : <Button variant="primary" shortcut="Alt+W" onPress={newManifest}>New manifest</Button>}
      />
      <Grid columns={4}>
        <StatTile label="Submitted today" value={n(counts.submitted_today)} href="/manifests" />
        <StatTile label="In lab" value={n(counts.in_lab)} href="/orders?tracking_status=in_lab" />
        <StatTile label="Reported today" value={n(counts.reported_today)} href="/orders?tracking_status=reported" />
        {warn ? (
          <div className="lims-tone-warning" data-tone="warning">
            <StatTile label="New sample needed" value={n(counts.rejected_open)} href="/orders?tracking_status=action_needed" />
            <Icon name="warning" size={14} />
          </div>
        ) : (
          <StatTile label="New sample needed" value={n(counts.rejected_open)} href="/orders?tracking_status=action_needed" />
        )}
        <StatTile label="New reports" value={n(counts.new_reports)} href="/reports?is_new=true" />
        <StatTile label="Open pickups" value={n(counts.open_pickups)} href="/pickups" />
        <div>
          {/* [CONV] no statements yet -> "—" (balance unknown, not zero) */}
          <StatTile label="Outstanding" value={out && Number.isFinite(out.amount_paisa) ? lakh(out.amount_paisa) : '—'} href="/statements" />
          {out && counts.outstanding_as_of ? (
            <span className="lims-stat-note">
              as of <DateText value={counts.outstanding_as_of as never} withTime />
            </span>
          ) : null}
        </div>
      </Grid>
      {isEmpty ? (
        <EmptyState title="Welcome" body={`Create your first manifest to send samples to ${labName}.`} action={{ label: 'New manifest', onPress: newManifest }} />
      ) : (
        <section aria-label="Recent manifests">
          <h2>Recent manifests</h2>
          <DataTable
            caption="Recent manifests"
            density="compact"
            columns={columns}
            rows={manifests}
            getRowId={(r) => r.id}
            emptyState={{ title: 'No manifests yet.' }}
            {...(manifestsFailed ? { error: { title: 'Could not load recent manifests.' } } : {})}
            onRowAction={(r) => router.push(`/manifests/${encodeURIComponent(r.id)}`)}
          />
        </section>
      )}
    </>
  );
}
