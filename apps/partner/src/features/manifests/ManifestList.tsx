'use client';
// C13.T19 PM-1 Manifests (04-UI-UX PM-1; US-04.1/04.2). FilterBar (State, Created) + table / phone cards; "New manifest" creates a draft (M1) and opens the editor.
// LD-140 (2026-11-13): @lims/ui components only; one primary button per page (the header action; the empty state carries it instead when there are no rows).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { IdText } from '@lims/ui/components/IdText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Chip, Dt, ListScreen, RowLink, useApplyFilters, type ListColumn, type Tone } from '../common/ui';
import { num } from '../common/format';
import type { ManifestSummary } from '../common/types';
import { createManifestAction } from './actions';

export const MANIFEST_STATE: Readonly<Record<string, readonly [Tone, string]>> = {
  draft: ['neutral', 'Draft'], submitted: ['info', 'Submitted'], partially_received: ['info', 'Partly received'],
  received: ['success', 'Received'], withdrawn: ['neutral', 'Withdrawn'], discarded: ['neutral', 'Discarded'],
};
const STATE_OPTIONS = Object.entries(MANIFEST_STATE).map(([value, [, label]]) => ({ value, label }));
const PICKUP: Readonly<Record<string, readonly [Tone, string]>> = { requested: ['info', 'Pickup requested'] }; // [CONV] ManifestSummary has no pickup state: any pickup_request_id reads as requested

export interface ManifestListProps {
  rows: ManifestSummary[];
  nextCursor?: string | undefined;
  canCreate: boolean;
  initial: { state?: string; created_at_from?: string; created_at_to?: string };
}

export function ManifestList({ rows, nextCursor, canCreate, initial }: ManifestListProps) {
  const router = useRouter();
  const apply = useApplyFilters();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filters, setFilters] = useState<FilterValue>({
    ...(initial.state ? { state: initial.state.split(',') } : {}),
    ...(initial.created_at_from && initial.created_at_to ? { created: [initial.created_at_from, initial.created_at_to] } : {}),
  });

  const push = (v: FilterValue) => {
    setFilters(v);
    const created = Array.isArray(v['created']) ? (v['created'] as readonly string[]) : [];
    apply({ state: Array.isArray(v['state']) ? (v['state'] as readonly string[]).join(',') : undefined, created_at_from: created[0], created_at_to: created[1] });
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const r = await createManifestAction(crypto.randomUUID());
    setBusy(false);
    if (r.ok && r.id) router.push(`/manifests/${encodeURIComponent(r.id)}`);
    else setFailed(true);
  };

  const columns: ListColumn<ManifestSummary>[] = [
    { id: 'manifest_no', header: 'Manifest no.', isRowHeader: true, cell: (r) => <RowLink href={`/manifests/${encodeURIComponent(r.id)}`}><IdText value={r.manifest_no} truncate={32} /></RowLink> },
    { id: 'state', header: 'State', cell: (r) => <Chip table={MANIFEST_STATE} code={r.state} /> },
    { id: 'line_count', header: 'Samples', align: 'end', cell: (r) => num(r.line_count) },
    { id: 'lines_converted', header: 'Registered', align: 'end', cell: (r) => num(r.lines_converted) },
    {
      id: 'lines_failed', header: 'Needs lab check', align: 'end', hideBelow: 'md',
      cell: (r) => (num(r.lines_failed) > 0 ? <Chip table={{ check: ['warning', `${num(r.lines_failed)} to check`] }} code="check" /> : '—'),
      card: (r) => (num(r.lines_failed) > 0 ? <Chip table={{ check: ['warning', `${num(r.lines_failed)} to check`] }} code="check" /> : null),
    },
    { id: 'submitted_at', header: 'Submitted', cell: (r) => <Dt value={r.submitted_at} withTime /> },
    { id: 'pickup', header: 'Pickup', hideBelow: 'lg', cell: (r) => (r.pickup_request_id ? <Chip table={PICKUP} code="requested" /> : '—'), card: (r) => (r.pickup_request_id ? <Chip table={PICKUP} code="requested" /> : null) },
  ];

  const empty = rows.length === 0;
  return (
    <>
      <PageHeader
        title="Manifests"
        helpKey="partners.manifests"
        actions={canCreate && !empty ? <Button variant="primary" isLoading={busy} onPress={() => void create()}>New manifest</Button> : null}
      />
      {failed ? <Banner tone="danger" title="Could not create the manifest.">Try again in a moment.</Banner> : null}
      <FilterBar
        filters={[
          { id: 'state', label: 'State', kind: 'select', multiple: true, options: STATE_OPTIONS },
          { id: 'created', label: 'Created', kind: 'date_range' },
        ]}
        value={filters}
        onChange={push}
        onReset={() => push({})}
      />
      <ListScreen
        caption="Manifests"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        href={(r) => `/manifests/${encodeURIComponent(r.id)}`}
        nextCursor={nextCursor}
        empty={{ title: 'No manifests yet.', ...(canCreate ? { action: { label: 'New manifest', onPress: () => void create() } } : {}) }}
      />
    </>
  );
}
