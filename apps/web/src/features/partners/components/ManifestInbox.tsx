'use client';
// SM-1 Partner manifests inbox (04-UI-UX §4, US-06.1/.2/.9/.11). Receiving-centre scope is the API's job (US-06.2); filters live in the URL; the list refreshes every 60 s.
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Button } from '@lims/ui/components/Button';
import { DateRangePicker, type DateRange } from '@lims/ui/components/DateRangePicker';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import type { ManifestSummary } from '../server/types';
import { Ad, Chip, LOAD_FAILED, useUrlFilters } from './common';

export const WAITING = 'submitted,partially_received';
const STATES = [{ value: WAITING, label: 'Waiting for receipt' }, { value: 'received', label: 'Received' }];
const TZ = 'Asia/Kathmandu';
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('sv', { timeZone: TZ }) : undefined);

export interface InboxFilters { state?: string | undefined; submitted_at_from?: string | undefined; submitted_at_to?: string | undefined; has_failed_lines?: string | undefined; has_missing_samples?: string | undefined }

export function ManifestInbox({ rows, failed, filters }: { rows: readonly ManifestSummary[]; failed: boolean; filters: InboxFilters }) {
  const router = useRouter();
  const setUrl = useUrlFilters();
  const refresh = useRef(router.refresh);
  refresh.current = router.refresh;
  useEffect(() => {
    // LD-240: no refresh while the tab is hidden.
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') refresh.current(); }, 60_000);
    return () => clearInterval(t);
  }, []);

  const from = day(filters.submitted_at_from);
  const to = day(filters.submitted_at_to);
  const columns: ColumnDef<ManifestSummary>[] = [
    { id: 'no', header: 'Manifest', isRowHeader: true, cell: (m) => <a className="lims-link lims-mono" href={`/partners/manifests/${m.id}`}>{m.manifest_no}</a> },
    { id: 'partner', header: 'Partner', cell: (m) => m.partner.name },
    { id: 'samples', header: 'Samples', align: 'end', cell: (m) => m.line_count },
    { id: 'received', header: 'Received', align: 'end', cell: (m) => m.lines_converted },
    { id: 'attention', header: 'Needs attention', cell: (m) => (m.lines_failed > 0 ? <Badge tone="warning">{`${m.lines_failed} ${m.lines_failed === 1 ? 'needs' : 'need'} attention`}</Badge> : '—') },
    { id: 'submitted', header: 'Submitted', cell: (m) => (m.submitted_at ? <Ad value={m.submitted_at} withTime /> : '—') },
    { id: 'pickup', header: 'Pickup', cell: (m) => (m.pickup_request_id ? <Chip code="requested" /> : '—') },
  ];

  return (
    <section aria-label="Partner manifests">
      <PageHeader title="Partner manifests" helpKey="partners.inbox" />
      {/* T0D-UILIST-3 (LD-353 template 1, rule 2): one filter row; the kit FilterBar markup (role=search, .lims-filter-bar) holds the two switches too. */}
      <div role="search" className="lims-filter-bar">
        <Select label="State" name="state" options={STATES} {...(filters.state ? { value: filters.state } : {})} onChange={(v) => setUrl({ state: v })} />
        <DateRangePicker
          label="Submitted between"
          name="submitted"
          {...(from && to ? { value: { from, to } as DateRange } : {})}
          onChange={(r) => setUrl({
            submitted_at_from: r ? new Date(`${r.from}T00:00:00+05:45`).toISOString() : undefined,
            submitted_at_to: r ? new Date(`${r.to}T23:59:59.999+05:45`).toISOString() : undefined,
          })}
        />
        <Switch label="Has samples needing attention" isSelected={filters.has_failed_lines === 'true'} onChange={(v) => setUrl({ has_failed_lines: v ? 'true' : undefined })} />
        <Switch label="Order exists but sample missing" isSelected={filters.has_missing_samples === 'true'} onChange={(v) => setUrl({ has_missing_samples: v ? 'true' : undefined })} />
        <Button variant="ghost" onPress={() => setUrl({ state: undefined, submitted_at_from: undefined, submitted_at_to: undefined, has_failed_lines: undefined, has_missing_samples: undefined })}>
          Reset filters
        </Button>
      </div>
      {/* LD-353 rules 5 and 6: on a failed load the header row stays and the ErrorState (Retry) sits in the table body */}
      <div {...(failed ? { role: 'alert' } : {})}>
        <DataTable caption="Partner manifests" columns={columns} rows={rows} getRowId={(m) => m.id} cellTitle {...(failed ? { error: { title: LOAD_FAILED, onRetry: () => router.refresh() } } : {})} emptyState={{ title: 'No manifests', body: 'Submitted partner boxes will show here.' }} onRowAction={(m) => router.push(`/partners/manifests/${m.id}`)} />
      </div>
    </section>
  );
}
