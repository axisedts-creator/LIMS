'use client';
// C16.T-B6 W1 Bookings (04-UI-UX W1; TRD S1). Props injected; data only through `actions` (BFF server actions). LD-140: kit components + tokens only.
// [CONV] The status filter is a kit Checkbox group next to the FilterBar: the FilterBar `select multiple` renders option chips without a tone,
// and LD-140 requires every chip on a status screen to carry tone + word (open point in .orchestra/notes/T-B6-impl.md).
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DataTable } from '@lims/ui/components/DataTable';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { shortcuts } from '@/core/shortcuts/registry';
import type { Queue } from './queue-model';
import { CancelBookingDialog, CheckInDialog, type BookingRowActions } from './BookingDialogs';
import {
  DAY_MS, KIND_LABEL, KIND_OPTIONS, SOURCE_LABEL, STATUS, addDays, bookingProblem, dayStartUtc, hhmm, num, statusOf,
  type BookingKind, type BookingStatus, type CancelReason, type Centre, type StaffBooking,
} from './booking-model';

export const PAGE_ID = 'staff.engagement.bookings';
export interface BookingsQuery { centre_id: string; booking_kind?: BookingKind; status: BookingStatus[]; slot_start_from: string; slot_start_to: string; sort: 'slot_start' }
export interface BookingsListActions extends BookingRowActions { listBookings(q: BookingsQuery): Promise<StaffBooking[]> }
export interface BookingsListProps {
  centres: readonly Centre[]; workingCentreId: string; today: string; rows: readonly StaffBooking[]; queues: readonly Queue[]; cancelReasons: readonly CancelReason[];
  actions: BookingsListActions;
}

const MAX_DAYS = 31;
const DEFAULT_STATUS: BookingStatus[] = ['confirmed', 'checked_in'];

export function BookingsList({ centres, workingCentreId, today, rows: initial, queues, cancelReasons, actions }: BookingsListProps) {
  const router = useRouter();
  const defaults: FilterValue = { date: [today, today], centre_id: workingCentreId };
  const [filters, setFilters] = useState<FilterValue>(defaults);
  const [status, setStatus] = useState<BookingStatus[]>(DEFAULT_STATUS);
  const [rows, setRows] = useState<readonly StaffBooking[]>(initial);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [checkIn, setCheckIn] = useState<StaffBooking | null>(null);
  const [cancelling, setCancelling] = useState<StaffBooking | null>(null);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = async (f: FilterValue, st: BookingStatus[]) => {
    const [from, to] = Array.isArray(f['date']) ? (f['date'] as string[]) : [today, today];
    const centre = typeof f['centre_id'] === 'string' ? f['centre_id'] : workingCentreId;
    const kind = f['booking_kind'] as BookingKind | undefined;
    const q: BookingsQuery = { centre_id: centre, ...(kind ? { booking_kind: kind } : {}), status: st, slot_start_from: dayStartUtc(from!), slot_start_to: dayStartUtc(addDays(to!, 1)), sort: 'slot_start' };
    if (Date.parse(q.slot_start_to) - Date.parse(q.slot_start_from) > MAX_DAYS * DAY_MS) { setError(`Choose a date range of ${MAX_DAYS} days or less.`); return; }
    if (st.length === 0) { setError('Choose at least one status.'); return; }
    const mine = ++seq.current;
    setError(undefined);
    setLoading(true);
    try {
      const r = await actions.listBookings(q);
      if (mine === seq.current) { setRows(r); setSelected(new Set()); }
    } catch (e) {
      if (mine === seq.current) setError(bookingProblem(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };
  const onFilters = (f: FilterValue) => { setFilters(f); void load(f, status); };
  const onStatus = (s: BookingStatus, on: boolean) => {
    const next = on ? [...status, s] : status.filter((x) => x !== s);
    setStatus(next);
    void load(filters, next);
  };
  const refresh = () => { void load(filters, status); router.refresh(); };

  const selectedRow = () => rows.find((r) => selected.has(r.id));
  const latest = useRef({ selectedRow, setCheckIn, setCancelling, router });
  latest.current = { selectedRow, setCheckIn, setCancelling, router };
  useEffect(() => shortcuts.register(
    PAGE_ID,
    { key: 'Alt+B', description: 'New booking', run: () => latest.current.router.push('/engagement/bookings/new') },
    { key: 'Alt+C', description: 'Check in the selected booking', run: () => { const r = latest.current.selectedRow(); if (r?.status === 'confirmed') latest.current.setCheckIn(r); } },
    { key: 'Alt+X', description: 'Cancel the selected booking', run: () => { const r = latest.current.selectedRow(); if (r?.status === 'confirmed') latest.current.setCancelling(r); } },
  ), []);

  return (
    <div className="lims-stack">
      <div className="lims-inline">
        <Button variant="primary" shortcut="Alt+B" onPress={() => router.push('/engagement/bookings/new')}>New booking</Button>
      </div>
      <FilterBar
        filters={[
          { id: 'date', label: 'Date', kind: 'date_range' },
          { id: 'centre_id', label: 'Centre', kind: 'select', options: centres.map((c) => ({ value: c.id, label: c.display_name })) },
          { id: 'booking_kind', label: 'Type', kind: 'select', options: KIND_OPTIONS },
        ]}
        value={filters}
        onChange={onFilters}
        onReset={() => { setFilters(defaults); setStatus(DEFAULT_STATUS); void load(defaults, DEFAULT_STATUS); }}
      />
      <fieldset className="lims-fieldset lims-inline">
        <legend>Status</legend>
        {(Object.keys(STATUS) as BookingStatus[]).map((s) => <Checkbox key={s} label={STATUS[s].label} isSelected={status.includes(s)} onChange={(on) => onStatus(s, on)} />)}
      </fieldset>
      {error ? <Banner tone="danger" title={error} /> : null}
      <DataTable
        caption="Bookings"
        rows={rows}
        getRowId={(r) => r.id}
        isLoading={loading}
        emptyState={{ title: 'No bookings for this day.' }}
        selection={{ mode: 'single', selectedIds: selected, onChange: setSelected }}
        onRowAction={(r) => router.push(`/engagement/bookings/${r.id}`)}
        columns={[
          { id: 'time', header: 'Time', cell: (r) => hhmm(r.slot_start) },
          { id: 'no', header: 'Booking no.', isRowHeader: true, cell: (r) => <span className="lims-mono">{r.booking_no}</span> },
          { id: 'patient', header: 'Patient', cell: (r) => r.patient_name || '—' },
          { id: 'type', header: 'Type', cell: (r) => KIND_LABEL[r.booking_kind] ?? r.booking_kind },
          { id: 'tests', header: 'Tests', align: 'end', cell: (r) => num(r.items.length) },
          { id: 'source', header: 'Source', cell: (r) => SOURCE_LABEL(r.created_via) },
          { id: 'status', header: 'Status', cell: (r) => { const s = statusOf(r.status); return <StatusChip kind="generic" status={r.status} tone={s.tone} label={s.label} />; } },
          { id: 'order', header: 'Order', cell: (r) => (r.order_id ? <a href={`/frontdesk/orders/${encodeURIComponent(r.order_id)}`}>Open order</a> : '—') },
          {
            id: 'actions', header: 'Actions', cell: (r) => (
              <span className="lims-inline">
                <a href={`/engagement/bookings/${encodeURIComponent(r.id)}`}>Open</a>
                {r.status === 'confirmed' ? <Button size="sm" onPress={() => setCheckIn(r)}>Check in</Button> : null}
                {r.status === 'confirmed' ? <Button size="sm" variant="ghost" onPress={() => setCancelling(r)}>Cancel</Button> : null}
              </span>
            ),
          },
        ]}
      />
      {checkIn ? <CheckInDialog booking={checkIn} queues={queues} onCheckIn={actions.checkIn} onClose={() => setCheckIn(null)} onDone={() => { setCheckIn(null); refresh(); }} /> : null}
      {cancelling ? <CancelBookingDialog booking={cancelling} reasons={cancelReasons} onCancel={actions.cancel} onClose={() => setCancelling(null)} onDone={() => { setCancelling(null); refresh(); }} /> : null}
    </div>
  );
}
