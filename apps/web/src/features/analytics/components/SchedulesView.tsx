'use client';
// S6 Scheduled reports list (04-UI-UX §8). Deactivate goes through a ConfirmDialog -> server action (If-Match = the version the row was read at).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { deactivateScheduleAction } from '../server/actions';

export interface ScheduleRowVM {
  id: string; version: number; name: string; reportCount: number; reportNames: string; frequency: string; period: string; recipients: number; nextRunAt?: string; active: boolean;
}

export function SchedulesView({ rows, next, hasPrevious }: { rows: ScheduleRowVM[]; next?: string; hasPrevious: boolean }) {
  const router = useRouter();
  const [target, setTarget] = useState<ScheduleRowVM>();
  const [error, setError] = useState<string>();

  const deactivate = async () => {
    if (!target) return;
    const r = await deactivateScheduleAction(target.id, target.version);
    setTarget(undefined);
    if (r.ok) { setError(undefined); router.refresh(); return; }
    setError(r.code === 'common.version_conflict' ? 'This schedule was changed by someone else. Reload to see the latest version.' : 'Could not stop this schedule. Try again.');
  };

  const columns: ColumnDef<ScheduleRowVM>[] = [
    { id: 'name', header: 'Name', isRowHeader: true, cell: (r) => r.name },
    { id: 'reports', header: 'Reports', cell: (r) => `${r.reportCount} (${r.reportNames}${r.reportCount > 2 ? ', …' : ''})` },
    { id: 'frequency', header: 'Frequency', cell: (r) => r.frequency },
    { id: 'period', header: 'Period', cell: (r) => r.period },
    { id: 'recipients', header: 'Recipients', align: 'end', cell: (r) => String(r.recipients) },
    { id: 'next', header: 'Next send', cell: (r) => (r.nextRunAt ? <DateText value={r.nextRunAt as DateTextProps['value']} withTime /> : '—') },
    { id: 'status', header: 'Status', cell: (r) => <StatusChip kind="generic" status={r.active ? 'active' : 'inactive'} label={r.active ? 'Active' : 'Inactive'} tone={r.active ? 'success' : 'neutral'} /> },
    {
      id: 'actions', header: 'Actions',
      cell: (r) => (
        <span className="lims-inline">
          <a href={`/analytics/schedules/${r.id}`}>Edit</a>
          {r.active ? <Button size="sm" variant="ghost" onPress={() => setTarget(r)}>Deactivate</Button> : null}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Scheduled reports" helpKey="analytics.schedules" actions={<a className="lims-btn lims-btn-primary" href="/analytics/schedules/new">New schedule</a>} />
      {error ? (
        <div role="alert">
          <Banner tone="danger" title={error} {...(error.startsWith('This schedule was changed') ? { action: { label: 'Reload', onPress: () => { setError(undefined); router.refresh(); } } } : {})} />
        </div>
      ) : null}
      <DataTable<ScheduleRowVM>
        columns={columns} rows={rows} getRowId={(r) => r.id} density="compact" caption="Scheduled reports"
        emptyState={{ title: 'No scheduled reports yet', body: 'Create a schedule to email a link to your reports on a fixed day and time.' }}
        {...(next || hasPrevious ? { page: { hasNext: !!next, hasPrevious, onNext: () => next && router.push(`/analytics/schedules?cursor=${encodeURIComponent(next)}`), onPrevious: () => router.back(), limit: 20 } } : {})}
      />
      <ConfirmDialog
        title="Stop sending this report?" body="Recipients will no longer get an email for this schedule. You can create a new schedule later."
        confirmLabel="Deactivate" tone="danger" isOpen={!!target} onCancel={() => setTarget(undefined)} onConfirm={deactivate}
      />
    </>
  );
}
