'use client';
// C16.T-B6 dialogs shared by W1 and W2 (04-UI-UX W2): Check in (Switch "Issue queue token" default on, queue Select, priority Normal/Priority — AC-15.3)
// and Cancel (ConfirmDialog, reasons from booking_cancel_reasons). The booking row is passed through so the BFF can send If-Match.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Dialog } from '@lims/ui/components/Dialog';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import type { Queue } from './queue-model';
import { bookingProblem, type CancelReason, type StaffBooking } from './booking-model';

export type CheckInBody = { issue_token: true; queue_id: string; priority: 'normal' | 'priority' } | { issue_token: false };
export interface BookingRowActions {
  checkIn(booking: StaffBooking, body: CheckInBody): Promise<void>;
  cancel(booking: StaffBooking, body: { reason_code: string }): Promise<void>;
}

export function CheckInDialog({ booking, queues, onCheckIn, onClose, onDone }: {
  booking: StaffBooking; queues: readonly Queue[]; onCheckIn: BookingRowActions['checkIn']; onClose: () => void; onDone: () => void;
}) {
  const active = queues.filter((q) => q.is_active && q.centre_id === booking.centre_id);
  const [issue, setIssue] = useState(true);
  const [queueId, setQueueId] = useState<string | undefined>(active[0]?.id);
  const [priority, setPriority] = useState<'normal' | 'priority'>('normal');
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (issue && !queueId) { setFailure('Choose a queue, or switch off "Issue queue token".'); return; }
    setBusy(true);
    try {
      await onCheckIn(booking, issue ? { issue_token: true, queue_id: queueId!, priority } : { issue_token: false });
      onDone();
    } catch (e) {
      setFailure(bookingProblem(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Check in ${booking.booking_no}`}
      isOpen
      onClose={onClose}
      size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>Close</Button><Button variant="primary" isLoading={busy} onPress={() => void submit()}>Check in</Button></>}
    >
      <Switch label="Issue queue token" isSelected={issue} onChange={setIssue} />
      {issue ? (
        <>
          <Select label="Queue" name="queue_id" options={active.map((q) => ({ value: q.id, label: q.display_name }))} {...(queueId ? { value: queueId } : {})} onChange={setQueueId} />
          <RadioGroup label="Priority" name="priority" orientation="horizontal" value={priority} onChange={setPriority} options={[{ value: 'normal', label: 'Normal' }, { value: 'priority', label: 'Priority' }]} />
        </>
      ) : null}
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
    </Dialog>
  );
}

export function CancelBookingDialog({ booking, reasons, onCancel, onClose, onDone }: {
  booking: StaffBooking; reasons: readonly CancelReason[]; onCancel: BookingRowActions['cancel']; onClose: () => void; onDone: () => void;
}) {
  const [failure, setFailure] = useState<string>();
  return (
    <ConfirmDialog
      title={`Cancel booking ${booking.booking_no}?`}
      body={<><p>The slot is released. The patient is not charged.</p>{failure ? <p role="alert" className="lims-error">{failure}</p> : null}</>}
      confirmLabel="Cancel booking"
      tone="danger"
      isOpen
      onCancel={onClose}
      requireReason={{ codedSet: 'booking_cancel_reasons', options: reasons.map((r) => ({ code: r.code, display: r.label })) }}
      onConfirm={async ({ reasonCode }) => {
        if (!reasonCode) return;
        try {
          await onCancel(booking, { reason_code: reasonCode });
          onDone();
        } catch (e) {
          setFailure(bookingProblem(e));
        }
      }}
    />
  );
}
