'use client';
// C16.T-B6 W2 Booking detail (04-UI-UX W2; TRD S2/S4/S5). Props injected; mutations only through `actions`.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Timeline } from '@lims/ui/components/Timeline';
import { useToast } from '@lims/ui/components/Toast';
import type { Queue } from './queue-model';
import { CancelBookingDialog, CheckInDialog, type BookingRowActions } from './BookingDialogs';
import { KIND_LABEL, SOURCE_LABEL, dateTime, hhmm, statusOf, type CancelReason, type StaffBooking, type Transition } from './booking-model';

export interface BookingDetailProps {
  booking: StaffBooking; timeline: readonly Transition[]; queues: readonly Queue[]; cancelReasons: readonly CancelReason[]; actions: BookingRowActions;
}

const ACTOR: Record<string, string> = { patient: 'Patient', staff: 'Staff', system: 'System' };

export function BookingDetail({ booking: initial, timeline, queues, cancelReasons, actions }: BookingDetailProps) {
  const router = useRouter();
  const toast = useToast();
  const [booking, setBooking] = useState(initial);
  const [dialog, setDialog] = useState<'check_in' | 'cancel' | null>(null);
  const b = booking;
  const s = statusOf(b.status);
  const done = (status: StaffBooking['status'], title: string) => {
    setDialog(null);
    setBooking((x) => ({ ...x, status }));
    toast.show({ tone: 'success', title });
    router.refresh();
  };

  return (
    <div className="lims-stack">
      {b.status === 'confirmed' ? (
        <div className="lims-inline">
          <Button variant="primary" onPress={() => setDialog('check_in')}>Check in</Button>
          <Button variant="danger" onPress={() => setDialog('cancel')}>Cancel booking</Button>
        </div>
      ) : null}
      <DescriptionList
        columns={2}
        items={[
          { term: 'Booking no.', value: <span className="lims-mono">{b.booking_no}</span> },
          { term: 'Patient', value: <a href={`/frontdesk/patients/${encodeURIComponent(b.patient_id)}`}>{b.patient_name || 'Open patient record'}</a> },
          { term: 'Type', value: KIND_LABEL[b.booking_kind] ?? b.booking_kind },
          { term: b.booking_kind === 'home_collection' ? 'Collected by' : 'Centre', value: b.centre_display_name },
          { term: 'Slot', value: `${dateTime(b.slot_start)}–${hhmm(b.slot_end)}` },
          {
            term: 'Tests',
            value: (
              <ul className="lims-list">
                {b.items.map((i) => (
                  <li key={i.orderable_id}>
                    {i.display_name}
                    {' · '}
                    {i.indicative_price ? <MoneyText value={{ amountPaisa: i.indicative_price.amount_paisa, currency: 'NPR' }} /> : '—'}
                  </li>
                ))}
              </ul>
            ),
          },
          { term: 'Status', value: <StatusChip kind="generic" status={b.status} tone={s.tone} label={s.label} /> },
          { term: 'Created via', value: SOURCE_LABEL(b.created_via) },
          { term: 'Order', value: b.order_id ? <a href={`/frontdesk/orders/${encodeURIComponent(b.order_id)}`}>Open order</a> : '—' },
          { term: 'Queue token', value: b.queue_token_id ? 'Issued at check-in' : '—' },
        ]}
      />
      <h2 className="lims-section-title">History</h2>
      <Timeline items={timeline.map((t) => ({ at: t.at, label: statusOf(t.status).label, ...(t.actor_kind ? { actor: ACTOR[t.actor_kind] ?? t.actor_kind } : {}) }))} />
      {dialog === 'check_in' ? <CheckInDialog booking={b} queues={queues} onCheckIn={actions.checkIn} onClose={() => setDialog(null)} onDone={() => done('checked_in', `Booking ${b.booking_no} checked in`)} /> : null}
      {dialog === 'cancel' ? <CancelBookingDialog booking={b} reasons={cancelReasons} onCancel={actions.cancel} onClose={() => setDialog(null)} onDone={() => done('cancelled', `Booking ${b.booking_no} cancelled`)} /> : null}
    </div>
  );
}
