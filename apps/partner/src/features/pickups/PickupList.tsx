'use client';
// C13.T19 PK-1 Pickups (04-UI-UX PK-1; US-10.3/10.4/10.5). Read-only list; a row opens a detail Drawer with "Cancel request" (ConfirmDialog with a coded reason).
// LD-140 (2026-11-13): @lims/ui components only; one primary action on the page ("Request pickup"; the empty state carries it instead when there are no rows).
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Drawer } from '@lims/ui/components/Drawer';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Chip, Dt, ListScreen, RowLink, type ListColumn, type Tone } from '../common/ui';
import { codesText, num } from '../common/format';
import type { PickupRequest } from '../common/types';
import { cancelPickupAction } from './actions';

export const PICKUP_STATE: Readonly<Record<string, readonly [Tone, string]>> = {
  requested: ['info', 'Requested'], scheduled: ['info', 'Scheduled'], picked_up: ['success', 'Picked up'], cancelled: ['neutral', 'Cancelled'], rejected: ['danger', 'Rejected'],
};
const CANCEL_REASONS = [ // 05-SCHEMA §7 pickup_cancel_reasons
  { code: 'no_longer_needed', display: 'No longer needed' }, { code: 'will_deliver_ourselves', display: 'We will deliver ourselves' },
  { code: 'manifest_withdrawn', display: 'Manifest withdrawn' }, { code: 'other', display: 'Other' },
];

const Window = ({ r }: { r: PickupRequest }) => <><Dt value={r.window_start} withTime /> – <Dt value={r.window_end} withTime /></>;

export function PickupList({ rows, nextCursor, canRequest }: { rows: PickupRequest[]; nextCursor?: string | undefined; canRequest: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState<PickupRequest | null>(null);
  const [ask, setAsk] = useState(false);
  const [failed, setFailed] = useState(false);

  const cancel = async (x: { reasonCode?: string }) => {
    if (!open) return;
    const r = await cancelPickupAction(open.id, open.version ?? 0, x.reasonCode ?? '', crypto.randomUUID());
    setAsk(false);
    if (r.ok) { setOpen(null); setFailed(false); router.refresh(); } else setFailed(true);
  };

  const columns: ListColumn<PickupRequest>[] = [
    // The manifest numbers identify a pickup, so that column is the row header (cards lead with it); the count is visible as the number of entries.
    { id: 'manifests', header: 'Manifests', isRowHeader: true, cell: (r) => codesText((r.manifests ?? []).map((m) => m.manifest_no), 2) || '—' },
    { id: 'created_at', header: 'Requested', cell: (r) => <Dt value={r.created_at} withTime /> },
    { id: 'window', header: 'Window', cell: (r) => <Window r={r} /> },
    { id: 'packages', header: 'Packages', align: 'end', cell: (r) => num(r.packages_count) },
    { id: 'status', header: 'Status', cell: (r) => <Chip table={PICKUP_STATE} code={r.state} /> },
    { id: 'scheduled', header: 'Scheduled time', cell: (r) => (r.scheduled_start ? <><Dt value={r.scheduled_start} withTime /> – <Dt value={r.scheduled_end} withTime /></> : '—') },
    { id: 'assignee', header: 'Assignee', hideBelow: 'md', cell: (r) => r.assignee_text ?? '—' },
  ];
  const empty = rows.length === 0;
  const cancellable = open !== null && (open.state === 'requested' || open.state === 'scheduled') && canRequest;

  return (
    <>
      <PageHeader
        title="Pickups"
        helpKey="partners.pickups"
        actions={canRequest && !empty ? <Link className="lims-btn lims-btn-primary lims-btn-md" href="/pickups/new">Request pickup</Link> : null}
      />
      {failed ? <Banner tone="danger" title="Could not cancel the request." /> : null}
      <ListScreen
        caption="Pickup requests"
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        onOpen={setOpen}
        nextCursor={nextCursor}
        cardActions={(r) => <Button size="sm" onPress={() => setOpen(r)}>Details</Button>}
        empty={{ title: 'No pickups yet.', body: 'Ask the lab to collect your samples.', ...(canRequest ? { action: { label: 'Request pickup', onPress: () => router.push('/pickups/new') } } : {}) }}
      />
      {open ? (
        <Drawer title="Pickup request" isOpen onClose={() => setOpen(null)} width="md">
          <Chip table={PICKUP_STATE} code={open.state} size="md" />
          <DescriptionList
            items={[
              { term: 'Window', value: <Window r={open} /> },
              { term: 'Packages', value: num(open.packages_count) },
              { term: 'Manifests', value: (open.manifests ?? []).map((m) => <RowLink key={m.id} href={`/manifests/${encodeURIComponent(m.id)}`}>{m.manifest_no}</RowLink>) },
              { term: 'Contact person', value: open.contact_name ?? '—' },
              { term: 'Notes', value: open.notes ?? '—' },
            ]}
          />
          {cancellable ? <Button variant="danger" onPress={() => setAsk(true)}>Cancel request</Button> : null}
        </Drawer>
      ) : null}
      <ConfirmDialog
        title="Cancel pickup request" confirmLabel="Cancel request" tone="danger" isOpen={ask} onCancel={() => setAsk(false)} onConfirm={cancel}
        body="The lab will not send anyone for this request."
        requireReason={{ codedSet: 'pickup_cancel_reasons', options: CANCEL_REASONS }}
      />
    </>
  );
}
