'use client';
// S5 My exports (04-UI-UX §7). Plain-JSON rows from the server; Download is a plain <a> to the BFF route (no blob URLs).
// Polling: router.refresh() every 3 s while an export is queued/building, at most 2 min (40 ticks), then a manual Refresh button [CONV].
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';

export interface ExportRowVM {
  id: string; requestedAt: string; report: string; period: string; format: string; status: string; statusLabel: string;
  rows?: number; sizeBytes?: number; downloads: string; expiresAt?: string; canDownload: boolean; failure?: string;
}

type Iso = DateTextProps['value']; // the API sends validated IsoUtc strings; the plain-JSON view model carries them as string
const POLL_MS = 3000;
const MAX_TICKS = 40; // 2 minutes
const TONE: Record<string, 'neutral' | 'success' | 'danger'> = { ready: 'success', failed: 'danger' };
const NUM = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const FILTERS = [['all', 'All'], ['queued', 'Queued'], ['building', 'Building'], ['ready', 'Ready'], ['failed', 'Failed'], ['expired', 'Expired']].map(([value, label]) => ({ value: value!, label: label! }));

function size(b: number | undefined): string {
  if (b === undefined) return '—';
  if (b < 1024) return `${b} B`;
  const f = (n: number) => String(Math.round(n * 10) / 10);
  return b < 1024 * 1024 ? `${f(b / 1024)} KB` : `${f(b / (1024 * 1024))} MB`;
}

export function ExportsView({ rows, status, next, hasPrevious }: { rows: ExportRowVM[]; status: string; next?: string; hasPrevious: boolean }) {
  const router = useRouter();
  const pending = rows.some((r) => r.status === 'queued' || r.status === 'building');
  const [capped, setCapped] = useState(false);
  const ticks = useRef(0); // survives re-renders: the 2 min budget is per page visit, not per refresh
  useEffect(() => {
    if (!pending || ticks.current >= MAX_TICKS) return;
    const t = setInterval(() => {
      ticks.current += 1;
      router.refresh();
      if (ticks.current >= MAX_TICKS) { clearInterval(t); setCapped(true); }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [pending, router]);

  const go = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    if (status !== 'all') p.set('status', status);
    for (const [k, v] of Object.entries(patch)) (v === undefined ? p.delete(k) : p.set(k, v));
    const s = p.toString();
    router.push(s ? `/analytics/exports?${s}` : '/analytics/exports');
  };

  const columns: ColumnDef<ExportRowVM>[] = [
    { id: 'requested', header: 'Requested', isRowHeader: true, cell: (r) => <DateText value={r.requestedAt as Iso} withTime /> },
    { id: 'report', header: 'Report', cell: (r) => r.report },
    { id: 'period', header: 'Period', cell: (r) => r.period },
    { id: 'format', header: 'Format', cell: (r) => r.format },
    {
      id: 'status', header: 'Status',
      cell: (r) => (
        <>
          <StatusChip kind="generic" status={r.status} label={r.statusLabel} tone={TONE[r.status] ?? 'neutral'} />
          {r.failure ? <p className="lims-description">{r.failure}</p> : null}
        </>
      ),
    },
    { id: 'rows', header: 'Rows', align: 'end', cell: (r) => (r.rows === undefined ? '—' : NUM.format(r.rows)) },
    { id: 'size', header: 'Size', align: 'end', cell: (r) => size(r.sizeBytes) },
    { id: 'downloads', header: 'Downloads', align: 'end', cell: (r) => r.downloads },
    { id: 'expires', header: 'Expires', cell: (r) => (r.expiresAt ? <DateText value={r.expiresAt as Iso} withTime /> : '—') },
    { id: 'action', header: 'Download', cell: (r) => (r.canDownload ? <a className="lims-btn lims-btn-primary lims-btn-sm" href={`/analytics/exports/${r.id}/file`}>Download</a> : null) },
  ];

  return (
    <>
      <PageHeader
        title="My exports"
        helpKey="analytics.exports"
        actions={pending && capped ?<Button variant="secondary" onPress={() => router.refresh()}>Refresh</Button> : null}
      />
      <Select<string> label="Status" name="status" value={status} options={FILTERS} onChange={(v) => go({ status: v === 'all' ? undefined : v, cursor: undefined })} />
      <DataTable<ExportRowVM>
        columns={columns} rows={rows} getRowId={(r) => r.id} density="compact" caption="My exports"
        emptyState={{ title: 'No exports yet', body: 'Exports you request from a report page appear here.' }}
        {...(next || hasPrevious ? { page: { hasNext: !!next, hasPrevious, onNext: () => next && go({ cursor: next }), onPrevious: () => router.back(), limit: 20 } } : {})}
      />
    </>
  );
}
