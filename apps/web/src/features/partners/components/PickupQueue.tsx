'use client';
// SK-1 Partner pickups (04-UI-UX §4, US-10.3 schedule, US-10.4 picked up, reject with reason). Actions follow the request state; closed requests have none.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { markPickedUpAction, rejectPickupAction, schedulePickupAction } from '../server/actions';
import type { ActionResult, Pickup } from '../server/types';
import { Ad, Chip, DialogError, LoadFailed, Notice, REASONS, errorText } from './common';

function ScheduleDialog({ pickup, onClose, onDone }: { pickup: Pickup; onClose: () => void; onDone: (r: ActionResult<unknown>) => void }) {
  const [from, setFrom] = useState<string>();
  const [to, setTo] = useState<string>();
  const [who, setWho] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    if (!from || !to || !who.trim()) return setError('Enter the start, the end and who will collect.');
    if (new Date(to).getTime() <= new Date(from).getTime()) return setError('The end must be after the start.');
    setBusy(true);
    setError(undefined);
    try {
      const r = await schedulePickupAction(pickup.id, pickup.version, { scheduled_start: from, scheduled_end: to, assignee_text: who.trim() });
      if (r.ok) onDone(r);
      else setError(errorText(r.code, r.status));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Schedule pickup" isOpen onClose={onClose} footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isLoading={busy} onPress={() => void submit()}>Schedule pickup</Button></>}>
      <p>Asked for {pickup.partner.name}: <Ad value={pickup.window_start} withTime /> to <Ad value={pickup.window_end} withTime />.</p>
      <DateTimePicker label="From" name="scheduled_start" isRequired {...(from ? { value: from as never } : {})} onChange={(v) => setFrom(v)} />
      <DateTimePicker label="To" name="scheduled_end" isRequired {...(to ? { value: to as never } : {})} onChange={(v) => setTo(v)} />
      <TextField label="Assignee" name="assignee_text" maxLength={80} isRequired value={who} onChange={setWho} description="Rider or team who will collect" />
      <DialogError text={error} />
    </Dialog>
  );
}

export function PickupQueue({ rows, failed }: { rows: readonly Pickup[]; failed: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [notice, setNotice] = useState<string>();
  const [scheduling, setScheduling] = useState<Pickup | null>(null);
  const [collecting, setCollecting] = useState<Pickup | null>(null);
  const [rejecting, setRejecting] = useState<Pickup | null>(null);

  const done = (r: ActionResult<unknown>, ok: string) => {
    if (r.ok) { setNotice(undefined); toast.show({ tone: 'success', title: ok }); router.refresh(); } else setNotice(errorText(r.code, r.status));
  };
  const columns: ColumnDef<Pickup>[] = [
    { id: 'window', header: 'Window', isRowHeader: true, cell: (p) => <><Ad value={p.window_start} withTime /> – <Ad value={p.window_end} withTime /></> },
    { id: 'partner', header: 'Partner', cell: (p) => p.partner.name },
    { id: 'contact', header: 'Address and contact', cell: (p) => [p.partner.address_text, p.contact_name, p.contact_phone_e164 ?? p.partner.contact_phone_e164].filter(Boolean).join(' · ') || '—' },
    { id: 'manifests', header: 'Manifests', cell: (p) => (p.manifests.length ? p.manifests.map((m) => m.manifest_no).join(', ') : '—') },
    { id: 'packages', header: 'Packages', align: 'end', cell: (p) => p.packages_count },
    { id: 'status', header: 'Status', cell: (p) => <Chip code={p.state} /> },
    { id: 'when', header: 'Scheduled for', cell: (p) => (p.scheduled_start ? <Ad value={p.scheduled_start} withTime /> : '—') },
    { id: 'assignee', header: 'Assignee', cell: (p) => p.assignee_text ?? '—' },
    {
      id: 'actions', header: 'Actions',
      cell: (p) => p.state === 'requested' ? (
        <>
          <Button size="sm" onPress={() => setScheduling(p)}>Schedule</Button>
          <Button size="sm" variant="ghost" onPress={() => setRejecting(p)}>Reject</Button>
        </>
      ) : p.state === 'scheduled' ? <Button size="sm" onPress={() => setCollecting(p)}>Mark picked up</Button> : null,
    },
  ];

  return (
    <section aria-label="Partner pickups">
      <PageHeader title="Partner pickups" helpKey="partners.pickups" />
      {notice ? <Notice text={notice} /> : null}
      {failed ? (
        <LoadFailed />
      ) : (
        <DataTable caption="Partner pickups" columns={columns} rows={rows} getRowId={(p) => p.id} emptyState={{ title: 'No pickup requests', body: 'Requests from partners will show here.' }} />
      )}
      {scheduling ? <ScheduleDialog pickup={scheduling} onClose={() => setScheduling(null)} onDone={(r) => { setScheduling(null); done(r, 'Pickup scheduled.'); }} /> : null}
      <ConfirmDialog
        title="Mark picked up"
        isOpen={collecting !== null}
        confirmLabel="Confirm"
        onCancel={() => setCollecting(null)}
        body={<p>Confirm that the samples were collected from {collecting?.partner.name}.</p>}
        onConfirm={async () => {
          const p = collecting;
          if (!p) return;
          setCollecting(null);
          done(await markPickedUpAction(p.id, p.version), 'Marked as picked up.');
        }}
      />
      <ConfirmDialog
        key={rejecting?.id ?? 'none'}
        title="Reject pickup"
        isOpen={rejecting !== null}
        confirmLabel="Reject"
        tone="danger"
        onCancel={() => setRejecting(null)}
        body={<p>The partner is told that this pickup cannot be done.</p>}
        requireReason={{ codedSet: 'partners.pickup_reject_reasons', options: REASONS.pickup_reject_reasons }}
        onConfirm={async ({ reasonCode }) => {
          const p = rejecting;
          if (!p || !reasonCode) return;
          setRejecting(null);
          done(await rejectPickupAction(p.id, p.version, reasonCode), 'Pickup rejected.');
        }}
      />
    </section>
  );
}
